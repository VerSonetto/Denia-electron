import 'dart:async';

import '../core/errors.dart';
import '../models/pairing.dart';
import '../models/server.dart';
import '../models/session.dart';
import 'api_client.dart';
import 'relay_crypto.dart';
import 'relay_transport.dart';

typedef ApiFactory = DeniaApi Function(String baseUrl, String? token);

/// Probes candidates in contract order, pins the server identity, then
/// redeems exactly once on the first host that proves it owns that identity.
///
/// A 4xx from a verified host is final: the pairing secret is bad or expired.
/// A 4xx from an unverified address just means "not a Denia host" and the next
/// candidate gets a turn.
class PairingService {
  PairingService({ApiFactory? apiFactory})
    : _apiFactory =
          apiFactory ??
          ((baseUrl, token) => DeniaApi(baseUrl: baseUrl, token: token));

  final ApiFactory _apiFactory;

  Future<PairedServer> pairWithLink({
    required String link,
    required String deviceName,
    required String installId,
  }) async {
    final payload = PairingPayload.parseLink(link);
    if (payload.isExpired) {
      throw PairingException('配对二维码已过期，请在桌面端重新生成');
    }
    Object? lastFailure;
    for (final candidate in payload.sortedCandidates) {
      if (candidate.isRelay) {
        try {
          return await _pairOverRelay(
            candidate: candidate,
            payload: payload,
            link: link,
            deviceName: deviceName,
            installId: installId,
          );
        } on PairingException catch (error) {
          lastFailure = error;
          if (error.message.contains('频繁')) rethrow;
        } catch (error) {
          lastFailure = error;
        }
        continue;
      }
      final api = _apiFactory(candidate.url.toString(), null);
      var verified = false;
      try {
        final status = await api.status();
        final identity = status.serverId;
        if (identity == null) {
          lastFailure = PairingException('${candidate.url.host} 不是 Denia 桌面端');
          continue;
        }
        final expected = payload.serverId;
        if (expected != null && expected != identity) {
          lastFailure = PairingException('${candidate.url.host} 的身份与二维码不一致');
          continue;
        }
        verified = true;
        final result = await api.redeem(
          link: link,
          deviceName: deviceName,
          dedupeKey: 'install:$installId',
        );
        return _buildServer(
          result: result,
          status: status,
          candidates: payload.candidates,
          activeUrl: candidate.url.toString(),
          labelFallback: payload.label,
          fingerprintFallback: payload.fingerprint,
        );
      } on ApiException catch (error) {
        lastFailure = error;
        if (error.status == 429) {
          throw PairingException('配对尝试过于频繁，请稍后再试');
        }
        if (verified && error.status >= 400 && error.status < 500) {
          throw PairingException('配对失败：${error.message}');
        }
      } catch (error) {
        lastFailure = error;
      } finally {
        api.dispose();
      }
    }
    throw PairingException(
      lastFailure == null
          ? '二维码里没有可用的桌面端地址'
          : '无法连接到桌面端：${describeFailure(lastFailure)}',
    );
  }

  Future<PairedServer> _pairOverRelay({
    required PairingCandidate candidate,
    required PairingPayload payload,
    required String link,
    required String deviceName,
    required String installId,
  }) async {
    final relayServerId = candidate.relayServerId;
    final hostKey = candidate.hostEncPubKey;
    if (relayServerId == null || hostKey == null) {
      throw PairingException('中继配对信息不完整');
    }
    final transport = RelayTransport(
      relayUrl: candidate.url.toString(),
      serverId: relayServerId,
      hostPublicKey: decodeBase64Url(hostKey),
    );
    DeniaApi? api;
    try {
      await transport.connect();
      api = _apiFactory(transport.baseUrl, null);
      final status = await api.status();
      final identity = status.serverId;
      if (identity == null) {
        throw PairingException('中继主机不是 Denia 桌面端');
      }
      final expected = payload.serverId;
      if (expected != null && expected != identity) {
        throw PairingException('中继主机的身份与二维码不一致');
      }
      final result = await api.redeem(
        link: link,
        deviceName: deviceName,
        dedupeKey: 'install:$installId',
      );
      return _buildServer(
        result: result,
        status: status,
        candidates: payload.candidates,
        activeUrl: candidate.url.toString(),
        labelFallback: payload.label,
        fingerprintFallback: payload.fingerprint,
      );
    } finally {
      api?.dispose();
      transport.dispose();
    }
  }

  Future<PairedServer> pairWithCode({
    required String address,
    required String code,
    required String deviceName,
    required String installId,
  }) async {
    final uri = normalizeServerAddress(address);
    final normalizedCode = code.toUpperCase().replaceAll(
      RegExp(r'[^0-9A-Z]'),
      '',
    );
    if (normalizedCode.length < 6) {
      throw PairingException('配对码不完整');
    }
    final api = _apiFactory(uri.toString(), null);
    try {
      final status = await api.status();
      final identity = status.serverId;
      if (identity == null) {
        throw PairingException('该地址不是 Denia 桌面端');
      }
      final result = await api.redeem(
        code: normalizedCode,
        deviceName: deviceName,
        dedupeKey: 'install:$installId',
      );
      final candidates = <PairingCandidate>[
        PairingCandidate(type: 'lan', url: uri, priority: 0),
      ];
      final publicUrl = status.publicUrl;
      if (publicUrl != null) {
        final tunnel = Uri.tryParse(publicUrl);
        if (tunnel != null && tunnel.hasScheme && tunnel.host.isNotEmpty) {
          candidates.add(
            PairingCandidate(type: 'tunnel', url: tunnel, priority: 10),
          );
        }
      }
      return _buildServer(
        result: result,
        status: status,
        candidates: candidates,
        activeUrl: uri.toString(),
        labelFallback: null,
        fingerprintFallback: null,
      );
    } on ApiException catch (error) {
      if (error.status == 429) {
        throw PairingException('配对尝试过于频繁，请稍后再试');
      }
      throw PairingException('配对失败：${error.message}');
    } finally {
      api.dispose();
    }
  }

  PairedServer _buildServer({
    required RedeemResult result,
    required RemoteStatus status,
    required List<PairingCandidate> candidates,
    required String activeUrl,
    required String? labelFallback,
    required String? fingerprintFallback,
  }) {
    if (result.token.isEmpty) {
      throw PairingException('桌面端没有返回设备令牌');
    }
    final serverId = status.serverId;
    if (serverId == null) {
      throw PairingException('桌面端没有返回身份标识');
    }
    if (result.clientId.isEmpty) {
      throw PairingException('桌面端没有返回设备记录');
    }
    return PairedServer(
      serverId: serverId,
      label: result.serverLabel ?? labelFallback ?? status.serverLabel ?? '桌面端',
      fingerprint: result.fingerprint ?? fingerprintFallback,
      candidates: candidates,
      token: result.token,
      clientId: result.clientId,
      pairedAt: DateTime.now().millisecondsSinceEpoch,
      activeUrl: activeUrl,
    );
  }
}

/// Kept for callers that only need to read a v2 payload without redeeming.
PairingPayload inspectPairingLink(String link) =>
    PairingPayload.parseLink(link);
