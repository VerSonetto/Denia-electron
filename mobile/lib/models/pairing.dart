import 'dart:convert';

import '../core/constants.dart';
import '../core/errors.dart';
import '../core/json.dart';

/// One address that can reach the host. The order in the payload is a hint;
/// [priority] is the contract and ascending order is the try order.
class PairingCandidate {
  const PairingCandidate({
    required this.type,
    required this.url,
    required this.priority,
    this.relayServerId,
    this.hostEncPubKey,
  });

  final String type;
  final Uri url;
  final int priority;
  /// Relay-only: routing id used by the relay room.
  final String? relayServerId;
  /// Relay-only: X25519 public key (base64url), the E2EE trust anchor.
  final String? hostEncPubKey;

  bool get isTunnel => type == 'tunnel';
  bool get isRelay => type == 'relay';

  String get displayKind {
    switch (type) {
      case 'tunnel':
        return '公网直连';
      case 'lan':
        return '局域网';
      case 'relay':
        return '私有中继';
      default:
        return type;
    }
  }

  JsonMap toJson() => {
    'type': type,
    if (isRelay) 'relayUrl': url.toString() else 'url': url.toString(),
    'priority': priority,
    if (relayServerId != null) 'serverId': relayServerId,
    if (hostEncPubKey != null)
      'hostEncPubJwk': {'kty': 'OKP', 'crv': 'X25519', 'x': hostEncPubKey},
  };

  static PairingCandidate? fromJson(Object? value, int fallbackPriority) {
    final map = asMap(value);
    final type = asStringOrNull(map['type']) ?? 'lan';
    final priority = asIntOrNull(map['priority']) ?? fallbackPriority;
    if (type == 'relay') {
      final rawUrl = asStringOrNull(map['relayUrl']) ?? asStringOrNull(map['url']);
      final serverId = asStringOrNull(map['serverId']);
      final jwk = asMap(map['hostEncPubJwk']);
      final key = asStringOrNull(jwk['x']);
      if (rawUrl == null || serverId == null || key == null) return null;
      if (jwk['kty'] != 'OKP' || jwk['crv'] != 'X25519') return null;
      final uri = Uri.tryParse(rawUrl);
      if (uri == null || (uri.scheme != 'ws' && uri.scheme != 'wss')) {
        return null;
      }
      return PairingCandidate(
        type: 'relay',
        url: uri,
        priority: priority,
        relayServerId: serverId,
        hostEncPubKey: key,
      );
    }
    final rawUrl = asStringOrNull(map['url']);
    if (rawUrl == null) return null;
    final uri = Uri.tryParse(rawUrl);
    if (uri == null || !uri.hasScheme || uri.host.isEmpty) return null;
    if (uri.scheme != 'http' && uri.scheme != 'https') return null;
    return PairingCandidate(type: type, url: uri, priority: priority);
  }
}

/// The v2 pairing link. `secret` is one-shot and must never be logged or put
/// into a URL query beyond the link the server generated.
class PairingPayload {
  PairingPayload({
    required this.version,
    required this.pairingId,
    required this.secret,
    required this.candidates,
    this.serverId,
    this.fingerprint,
    this.label,
    this.expiresAt,
  });

  final int version;
  final String pairingId;
  final String secret;
  final List<PairingCandidate> candidates;
  final String? serverId;
  final String? fingerprint;
  final String? label;
  final DateTime? expiresAt;

  bool get isExpired {
    final expiry = expiresAt;
    return expiry != null && DateTime.now().toUtc().isAfter(expiry.toUtc());
  }

  /// Contract order: priority ascending. Equal priorities keep the payload
  /// order via the candidate's own priority fallback; URL is the deterministic
  /// tie-breaker so two scans cannot produce different try orders.
  List<PairingCandidate> get sortedCandidates {
    final seen = <String>{};
    final unique = <PairingCandidate>[];
    for (final candidate in candidates) {
      final key = candidate.url.toString();
      if (seen.add(key)) unique.add(candidate);
    }
    unique.sort((a, b) {
      final byPriority = a.priority.compareTo(b.priority);
      if (byPriority != 0) return byPriority;
      final byType = a.type.compareTo(b.type);
      if (byType != 0) return byType;
      return a.url.toString().compareTo(b.url.toString());
    });
    return unique;
  }

  static PairingPayload parseLink(String raw) {
    final text = raw.trim();
    if (text.isEmpty) {
      throw PairingException('配对链接为空');
    }
    final uri = Uri.tryParse(text);
    if (uri == null ||
        uri.scheme != kPairingScheme ||
        uri.host != kPairingHost) {
      throw PairingException('不是 Denia 配对二维码');
    }
    if (asIntOrNull(uri.queryParameters['v']) != 2) {
      throw PairingException('配对链接版本不受支持，请更新手机 App');
    }
    final encoded = uri.queryParameters['p'];
    if (encoded == null || encoded.isEmpty) {
      throw PairingException('配对链接缺少载荷');
    }

    final JsonMap payload;
    try {
      payload = asMap(jsonDecode(_decodeBase64Url(encoded)));
    } on FormatException {
      throw PairingException('配对链接已损坏');
    }

    final candidates = <PairingCandidate>[];
    final rawCandidates = payload['candidates'];
    if (rawCandidates is List) {
      for (var index = 0; index < rawCandidates.length; index += 1) {
        final candidate = PairingCandidate.fromJson(
          rawCandidates[index],
          index * 10,
        );
        if (candidate != null) candidates.add(candidate);
      }
    }
    if (candidates.isEmpty) {
      throw PairingException('配对链接里没有可用地址');
    }

    final pairingId = asStringOrNull(payload['pairingId']);
    final secret = asStringOrNull(payload['secret']);
    if (pairingId == null || secret == null) {
      throw PairingException('配对链接已损坏');
    }

    return PairingPayload(
      version: asInt(payload['v'], 2),
      pairingId: pairingId,
      secret: secret,
      candidates: candidates,
      serverId: asStringOrNull(payload['serverId']),
      fingerprint: asStringOrNull(payload['fingerprint']),
      label: asStringOrNull(payload['label']),
      expiresAt: asDate(payload['expiresAt']),
    );
  }
}

String _decodeBase64Url(String input) {
  var normalized = input.replaceAll('-', '+').replaceAll('_', '/');
  final remainder = normalized.length % 4;
  if (remainder == 1) throw const FormatException('bad base64url');
  if (remainder > 0) {
    normalized = normalized.padRight(normalized.length + 4 - remainder, '=');
  }
  return utf8.decode(base64.decode(normalized));
}

/// Manual-entry addresses have no payload to normalise them. Accept a bare
/// host:port and default to HTTP; reject anything that is not HTTP(S).
Uri normalizeServerAddress(String raw) {
  var text = raw.trim();
  if (text.isEmpty) throw PairingException('请输入桌面端地址');
  if (!text.contains('://')) text = 'http://$text';
  final uri = Uri.tryParse(text);
  if (uri == null || uri.host.isEmpty) {
    throw PairingException('地址格式不正确');
  }
  if (uri.scheme != 'http' && uri.scheme != 'https') {
    throw PairingException('只支持 http:// 或 https:// 地址');
  }
  if (uri.hasQuery || uri.hasFragment) {
    throw PairingException('地址不能带参数');
  }
  var path = uri.path;
  while (path.endsWith('/')) {
    path = path.substring(0, path.length - 1);
  }
  return uri.replace(path: path);
}
