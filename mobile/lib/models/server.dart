import '../core/json.dart';
import 'pairing.dart';

/// A paired desktop host. The bearer token lives only inside this record and
/// the record itself is stored in Android Keystore-backed secure storage.

/// Rebuilds the candidate list from the host's current status.
///
/// The relay and Quick Tunnel addresses can change; LAN candidates stay valid
/// and are preserved. A missing status value means "host did not report it"
/// (older host or transient failure), so the previous entry is kept instead
/// of throwing away the only working path.
List<PairingCandidate> mergePairingCandidates({
  required List<PairingCandidate> current,
  PairingCandidate? relay,
  String? tunnelUrl,
}) {
  final next = <PairingCandidate>[];
  final seen = <String>{};
  void add(PairingCandidate candidate) {
    if (seen.add(candidate.url.toString())) next.add(candidate);
  }

  for (final candidate in current) {
    if (!candidate.isRelay && !candidate.isTunnel) add(candidate);
  }

  final relayNext = relay ?? _firstOfType(current, 'relay');
  if (relayNext != null) add(relayNext);

  Uri? tunnelUri;
  if (tunnelUrl != null) {
    final uri = Uri.tryParse(tunnelUrl);
    if (uri != null &&
        (uri.scheme == 'http' || uri.scheme == 'https') &&
        uri.host.isNotEmpty) {
      tunnelUri = uri;
    }
  }
  if (tunnelUri != null) {
    add(
      PairingCandidate(
        type: 'tunnel',
        url: tunnelUri,
        priority: relayNext == null ? 10 : 30,
      ),
    );
  } else {
    final tunnelNext = _firstOfType(current, 'tunnel');
    if (tunnelNext != null) add(tunnelNext);
  }

  next.sort((a, b) {
    final byPriority = a.priority.compareTo(b.priority);
    if (byPriority != 0) return byPriority;
    final byType = a.type.compareTo(b.type);
    if (byType != 0) return byType;
    return a.url.toString().compareTo(b.url.toString());
  });
  return next;
}

PairingCandidate? _firstOfType(List<PairingCandidate> candidates, String type) {
  for (final candidate in candidates) {
    if (candidate.type == type) return candidate;
  }
  return null;
}

class PairedServer {
  PairedServer({
    required this.serverId,
    required this.label,
    required this.candidates,
    required this.token,
    required this.clientId,
    required this.pairedAt,
    this.fingerprint,
    this.activeUrl,
  });

  final String serverId;
  final String label;
  final String? fingerprint;
  final List<PairingCandidate> candidates;
  final String token;
  final String clientId;
  final int pairedAt;
  final String? activeUrl;

  PairedServer copyWith({
    String? label,
    String? fingerprint,
    List<PairingCandidate>? candidates,
    String? token,
    String? clientId,
    String? activeUrl,
  }) {
    return PairedServer(
      serverId: serverId,
      label: label ?? this.label,
      fingerprint: fingerprint ?? this.fingerprint,
      candidates: candidates ?? this.candidates,
      token: token ?? this.token,
      clientId: clientId ?? this.clientId,
      pairedAt: pairedAt,
      activeUrl: activeUrl ?? this.activeUrl,
    );
  }

  /// The last URL that actually answered goes first; then the payload order.
  List<PairingCandidate> get tryOrder {
    final active = activeUrl;
    final ordered = <PairingCandidate>[];
    if (active != null) {
      for (final candidate in candidates) {
        if (candidate.url.toString() == active) ordered.add(candidate);
      }
    }
    for (final candidate in candidates) {
      if (!ordered.any(
        (entry) => entry.url.toString() == candidate.url.toString(),
      )) {
        ordered.add(candidate);
      }
    }
    return ordered;
  }

  String get shortId =>
      serverId.length <= 8 ? serverId : serverId.substring(0, 8);

  JsonMap toJson() => {
    'serverId': serverId,
    'label': label,
    if (fingerprint != null) 'fingerprint': fingerprint,
    'candidates': candidates.map((candidate) => candidate.toJson()).toList(),
    'token': token,
    'clientId': clientId,
    'pairedAt': pairedAt,
    if (activeUrl != null) 'activeUrl': activeUrl,
  };

  static PairedServer? fromJson(Object? value) {
    final map = asMap(value);
    final serverId = asStringOrNull(map['serverId']);
    final token = asStringOrNull(map['token']);
    final clientId = asStringOrNull(map['clientId']);
    if (serverId == null || token == null || clientId == null) return null;

    final candidates = <PairingCandidate>[];
    final rawCandidates = map['candidates'];
    if (rawCandidates is List) {
      for (var index = 0; index < rawCandidates.length; index += 1) {
        final candidate = PairingCandidate.fromJson(
          rawCandidates[index],
          index * 10,
        );
        if (candidate != null) candidates.add(candidate);
      }
    }
    if (candidates.isEmpty) return null;

    return PairedServer(
      serverId: serverId,
      label: asStringOrNull(map['label']) ?? '桌面端',
      fingerprint: asStringOrNull(map['fingerprint']),
      candidates: candidates,
      token: token,
      clientId: clientId,
      pairedAt: asInt(map['pairedAt'], DateTime.now().millisecondsSinceEpoch),
      activeUrl: asStringOrNull(map['activeUrl']),
    );
  }
}
