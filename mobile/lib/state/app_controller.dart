import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/widgets.dart';

import '../core/errors.dart';
import '../core/json.dart';
import '../data/api_client.dart';
import '../data/pairing_service.dart';
import '../data/relay_crypto.dart';
import '../data/relay_transport.dart';
import '../data/server_repository.dart';
import '../data/sse.dart';
import '../models/pairing.dart';
import '../models/server.dart';
import '../models/session.dart';

enum AppPhase { booting, unpaired, connecting, online, offline, authLost }

/// Owns the paired-server list, the active connection, and host-wide lists.
class AppController extends ChangeNotifier with WidgetsBindingObserver {
  AppController({
    required ServerRepository repository,
    PairingService? pairing,
    ApiFactory? apiFactory,
  }) : _repository = repository,
       _pairing = pairing ?? PairingService(),
       _apiFactory =
           apiFactory ??
           ((baseUrl, token) => DeniaApi(baseUrl: baseUrl, token: token));

  final ServerRepository _repository;
  final PairingService _pairing;
  final ApiFactory _apiFactory;

  AppPhase _phase = AppPhase.booting;
  List<PairedServer> _servers = const [];
  PairedServer? _activeServer;
  DeniaApi? _api;
  RelayTransport? _relayTransport;
  String? _installId;
  String? _lastError;
  String? _notice;
  bool _disposed = false;

  List<SessionSummary> _sessions = const [];
  Set<String> _runningIds = <String>{};
  List<ProjectRecord> _projects = const [];
  ModelCatalog? _catalog;
  bool _sessionsLoading = false;

  StreamSubscription<SseFrame>? _globalSub;
  Timer? _globalWatchdog;
  Timer? _globalReconnect;
  Timer? _globalSseProbe;
  Timer? _refreshDebounce;
  int _globalGeneration = 0;
  int _globalConnection = 0;
  int _globalAttempt = 0;
  int _globalPollGeneration = 0;
  int _globalSeq = 0;
  int _globalFailures = 0;
  bool _failoverInFlight = false;
  bool _observingLifecycle = false;

  AppPhase get phase => _phase;
  List<PairedServer> get servers => List.unmodifiable(_servers);
  PairedServer? get activeServer => _activeServer;
  String? get installId => _installId;
  String? get lastError => _lastError;
  String? get notice => _notice;
  List<SessionSummary> get sessions => List.unmodifiable(_sessions);
  Set<String> get runningIds => Set.unmodifiable(_runningIds);
  List<ProjectRecord> get projects => List.unmodifiable(_projects);
  ModelCatalog? get catalog => _catalog;
  bool get sessionsLoading => _sessionsLoading;
  bool get online => _phase == AppPhase.online && _api != null;
  bool get connecting => _phase == AppPhase.connecting;
  bool get usingRelay => _relayTransport != null;

  DeniaApi get api {
    final value = _api;
    if (value == null) throw TransportException('尚未连接到桌面端');
    return value;
  }

  bool isRunning(String sessionId) => _runningIds.contains(sessionId);

  String projectTitle(String? projectId) {
    if (projectId == null) return '默认项目';
    for (final project in _projects) {
      if (project.id == projectId) return project.title;
    }
    return '默认项目';
  }

  ProjectRecord? get defaultProject {
    for (final project in _projects) {
      if (project.isDefault) return project;
    }
    return _projects.isEmpty ? null : _projects.first;
  }

  Future<void> init() async {
    if (!_observingLifecycle) {
      WidgetsBinding.instance.addObserver(this);
      _observingLifecycle = true;
    }
    try {
      final snapshot = await _repository.load();
      _installId = snapshot.installId;
      _servers = snapshot.servers;
      if (_servers.isEmpty) {
        _phase = AppPhase.unpaired;
        notifyListeners();
        return;
      }
      final activeId = snapshot.activeServerId;
      final active = _servers.firstWhere(
        (server) => server.serverId == activeId,
        orElse: () => _servers.first,
      );
      await _connectTo(active);
    } catch (error) {
      _phase = AppPhase.unpaired;
      _lastError = '读取安全存储失败：${describeFailure(error)}';
      notifyListeners();
    }
  }

  Future<bool> retryConnection() async {
    final server = _activeServer ?? (_servers.isEmpty ? null : _servers.first);
    if (server == null) {
      _phase = AppPhase.unpaired;
      notifyListeners();
      return false;
    }
    return _connectTo(server);
  }

  /// Pull the current relay/tunnel address after the host or its tunnel
  /// restarts. Failure is non-fatal: the candidate list stays as it was.
  Future<void> refreshCandidates() async {
    final api = _api;
    final server = _activeServer;
    if (api == null || server == null || _phase != AppPhase.online) return;
    try {
      final status = await api.status();
      if (_disposed) return;
      final updated = _mergeStatusCandidates(server, status);
      if (updated.label == server.label &&
          _sameCandidates(updated.candidates, server.candidates)) {
        return;
      }
      _activeServer = updated;
      _replaceServer(updated);
      notifyListeners();
      await _persist();
    } on ApiException catch (error) {
      if (error.isAuthFailure) _markAuthLost(error.message);
    } catch (_) {
      // Offline is handled by the event loop; keep the old candidates.
    }
  }

  Future<void> switchServer(String serverId) async {
    for (final server in _servers) {
      if (server.serverId == serverId) {
        if (_activeServer?.serverId == serverId && online) return;
        await _connectTo(server);
        return;
      }
    }
  }

  Future<PairedServer> pairWithLink({
    required String link,
    required String deviceName,
  }) async {
    final installId = _installId ?? await _ensureInstallId();
    final server = await _pairing.pairWithLink(
      link: link,
      deviceName: deviceName,
      installId: installId,
    );
    await _adoptPairedServer(server);
    return server;
  }

  Future<PairedServer> pairWithCode({
    required String address,
    required String code,
    required String deviceName,
  }) async {
    final installId = _installId ?? await _ensureInstallId();
    final server = await _pairing.pairWithCode(
      address: address,
      code: code,
      deviceName: deviceName,
      installId: installId,
    );
    await _adoptPairedServer(server);
    return server;
  }

  Future<void> unpair(String serverId) async {
    PairedServer? target;
    for (final server in _servers) {
      if (server.serverId == serverId) {
        target = server;
        break;
      }
    }
    if (target == null) return;
    if (_activeServer?.serverId == serverId && _api != null) {
      try {
        await _api!
            .revokeSelf(target.clientId)
            .timeout(const Duration(seconds: 6));
      } catch (_) {
        // Local removal still wins when the host is unreachable.
      }
    }
    _servers = _servers
        .where((server) => server.serverId != serverId)
        .toList(growable: false);
    if (_activeServer?.serverId == serverId) {
      _stopGlobalEvents();
      _api?.dispose();
      _api = null;
      _relayTransport?.dispose();
      _relayTransport = null;
      _activeServer = null;
      _sessions = const [];
      _runningIds = <String>{};
      _projects = const [];
      _catalog = null;
      if (_servers.isEmpty) {
        _phase = AppPhase.unpaired;
      } else {
        await _connectTo(_servers.first);
      }
    }
    await _persist();
    notifyListeners();
  }

  Future<void> refreshSessions() async {
    final api = _api;
    if (api == null || _phase != AppPhase.online || _sessionsLoading) return;
    _sessionsLoading = true;
    notifyListeners();
    try {
      final sessions = await api.listSessions();
      sessions.sort((a, b) => b.sortTime.compareTo(a.sortTime));
      _sessions = sessions;
      _lastError = null;
    } on ApiException catch (error) {
      if (error.isAuthFailure) {
        _markAuthLost();
        return;
      }
      _lastError = error.message;
    } catch (error) {
      _lastError = describeFailure(error);
    } finally {
      _sessionsLoading = false;
      if (!_disposed) notifyListeners();
    }
  }

  Future<SessionSummary?> createSession({String? projectId}) async {
    final api = _api;
    if (api == null) return null;
    try {
      final session = await api.createSession(projectId: projectId);
      _sessions = [
        session,
        ..._sessions.where((entry) => entry.id != session.id),
      ];
      notifyListeners();
      await refreshSessions();
      return session;
    } on ApiException catch (error) {
      if (error.isAuthFailure) {
        _markAuthLost();
      } else {
        _lastError = error.message;
        notifyListeners();
      }
    } catch (error) {
      _lastError = describeFailure(error);
      notifyListeners();
    }
    return null;
  }

  Future<bool> deleteSession(String sessionId) async {
    final api = _api;
    if (api == null) return false;
    try {
      await api.deleteSession(sessionId);
      _sessions = _sessions
          .where((entry) => entry.id != sessionId)
          .toList(growable: false);
      _runningIds = {..._runningIds}..remove(sessionId);
      notifyListeners();
      return true;
    } on ApiException catch (error) {
      if (error.isAuthFailure) {
        _markAuthLost();
      } else {
        _lastError = error.message;
        notifyListeners();
      }
    } catch (error) {
      _lastError = describeFailure(error);
      notifyListeners();
    }
    return false;
  }

  void markAuthLost([String? message]) {
    _markAuthLost(message);
  }

  void clearNotice() {
    if (_notice == null) return;
    _notice = null;
    notifyListeners();
  }

  void clearLastError() {
    if (_lastError == null) return;
    _lastError = null;
    notifyListeners();
  }

  Future<bool> _connectTo(PairedServer server) async {
    if (_disposed) return false;
    _stopGlobalEvents();
    _api?.dispose();
    _api = null;
    _relayTransport?.dispose();
    _relayTransport = null;
    _activeServer = server;
    _phase = AppPhase.connecting;
    _lastError = null;
    _globalFailures = 0;
    notifyListeners();

    Object? lastFailure;
    for (final candidate in server.tryOrder) {
      if (candidate.isRelay) {
        final relayServerId = candidate.relayServerId;
        final hostKey = candidate.hostEncPubKey;
        if (relayServerId == null || hostKey == null) {
          lastFailure = TransportException('中继配对信息不完整');
          continue;
        }
        final transport = RelayTransport(
          relayUrl: candidate.url.toString(),
          serverId: relayServerId,
          hostPublicKey: decodeBase64Url(hostKey),
        );
        DeniaApi? relayApi;
        try {
          await transport.connect();
          relayApi = _apiFactory(transport.baseUrl, server.token);
          final status = await relayApi.status();
          final identity = status.serverId;
          if (identity == null) {
            lastFailure = TransportException('中继主机不是 Denia 桌面端');
            relayApi.dispose();
            transport.dispose();
            continue;
          }
          if (identity != server.serverId) {
            lastFailure = TransportException('中继主机的身份与已配对电脑不一致');
            relayApi.dispose();
            transport.dispose();
            continue;
          }
          if (!status.authenticated) {
            relayApi.dispose();
            transport.dispose();
            _markAuthLost('设备授权已失效，请重新扫码配对');
            return false;
          }
          _relayTransport = transport;
          _api = relayApi;
          var updated = server.copyWith(
            activeUrl: candidate.url.toString(),
            label: status.serverLabel ?? server.label,
          );
          updated = _mergeStatusCandidates(updated, status);
          _activeServer = updated;
          _replaceServer(updated);
          _sessions = const [];
          _runningIds = <String>{};
          _phase = AppPhase.online;
          _lastError = null;
          notifyListeners();
          await _persist();
          _startGlobalEvents();
          await Future.wait([
            refreshSessions(),
            _loadProjects(),
            _loadCatalog(),
          ]);
          return true;
        } catch (error) {
          relayApi?.dispose();
          transport.dispose();
          lastFailure = error;
          if (error is ApiException && error.isAuthFailure) {
            _markAuthLost(error.message);
            return false;
          }
          continue;
        }
      }
      final api = _apiFactory(candidate.url.toString(), server.token);
      try {
        final status = await api.status();
        final identity = status.serverId;
        if (identity == null) {
          lastFailure = TransportException(
            '${candidate.url.host} 不是 Denia 桌面端',
          );
          api.dispose();
          continue;
        }
        if (identity != server.serverId) {
          lastFailure = TransportException(
            '${candidate.url.host} 的身份与已配对电脑不一致',
          );
          api.dispose();
          continue;
        }
        if (!status.authenticated) {
          api.dispose();
          _markAuthLost('设备授权已失效，请重新扫码配对');
          return false;
        }
        _relayTransport?.dispose();
        _relayTransport = null;
        _api = api;
        var updated = server.copyWith(
          activeUrl: candidate.url.toString(),
          label: status.serverLabel ?? server.label,
        );
        updated = _mergeStatusCandidates(updated, status);
        _activeServer = updated;
        _replaceServer(updated);
        _sessions = const [];
        _runningIds = <String>{};
        _phase = AppPhase.online;
        _lastError = null;
        notifyListeners();
        await _persist();
        _startGlobalEvents();
        await Future.wait([refreshSessions(), _loadProjects(), _loadCatalog()]);
        return true;
      } catch (error) {
        api.dispose();
        lastFailure = error;
        if (error is ApiException && error.isAuthFailure) {
          _markAuthLost(error.message);
          return false;
        }
      }
    }

    _phase = AppPhase.offline;
    _lastError = lastFailure == null
        ? '没有可用的桌面端地址'
        : describeFailure(lastFailure);
    _api = null;
    notifyListeners();
    return false;
  }

  PairedServer _mergeStatusCandidates(
    PairedServer server,
    RemoteStatus status,
  ) {
    final candidates = mergePairingCandidates(
      current: server.candidates,
      relay: status.relayCandidate,
      tunnelUrl: status.publicUrl,
    );
    if (_sameCandidates(server.candidates, candidates)) return server;
    return server.copyWith(candidates: candidates);
  }

  static bool _sameCandidates(
    List<PairingCandidate> left,
    List<PairingCandidate> right,
  ) {
    if (left.length != right.length) return false;
    for (var index = 0; index < left.length; index += 1) {
      if (left[index].url.toString() != right[index].url.toString()) {
        return false;
      }
      if (left[index].type != right[index].type) return false;
    }
    return true;
  }

  Future<void> _adoptPairedServer(PairedServer incoming) async {
    PairedServer merged = incoming;
    for (final existing in _servers) {
      if (existing.serverId != incoming.serverId) continue;
      final candidates = <PairingCandidate>[...incoming.candidates];
      for (final old in existing.candidates) {
        if (!candidates.any(
          (candidate) => candidate.url.toString() == old.url.toString(),
        )) {
          candidates.add(old);
        }
      }
      merged = incoming.copyWith(candidates: candidates);
      break;
    }
    _replaceServer(merged);
    _activeServer = merged;
    await _persist();
    await _connectTo(merged);
  }

  void _replaceServer(PairedServer server) {
    final next = <PairedServer>[];
    var replaced = false;
    for (final existing in _servers) {
      if (existing.serverId == server.serverId) {
        next.add(server);
        replaced = true;
      } else {
        next.add(existing);
      }
    }
    if (!replaced) next.add(server);
    _servers = next;
  }

  Future<void> _loadProjects() async {
    final api = _api;
    if (api == null) return;
    try {
      final projects = await api.listProjects();
      if (_disposed) return;
      _projects = projects;
      notifyListeners();
    } on ApiException catch (error) {
      if (error.isAuthFailure) _markAuthLost();
    } catch (_) {
      // The session list still works without the project registry.
    }
  }

  Future<void> _loadCatalog() async {
    final api = _api;
    if (api == null) return;
    try {
      final catalog = await api.modelCatalog();
      if (_disposed) return;
      _catalog = catalog;
      notifyListeners();
    } on ApiException catch (error) {
      if (error.isAuthFailure) _markAuthLost();
    } catch (_) {
      // Model selection is optional; prompts can fall back to the host default.
    }
  }

  Future<void> _persist() async {
    try {
      await _repository.save(_servers, _activeServer?.serverId);
    } catch (error) {
      _lastError = '配对信息保存失败：${describeFailure(error)}';
      if (!_disposed) notifyListeners();
    }
  }

  Future<String> _ensureInstallId() async {
    final existing = _installId;
    if (existing != null) return existing;
    final snapshot = await _repository.load();
    _installId = snapshot.installId;
    return snapshot.installId;
  }

  void _markAuthLost([String? message]) {
    _stopGlobalEvents();
    _api?.dispose();
    _api = null;
    _relayTransport?.dispose();
    _relayTransport = null;
    _phase = AppPhase.authLost;
    _lastError = message ?? '设备授权已失效，请重新扫码配对';
    notifyListeners();
  }

  // —— global push channel ——

  void _startGlobalEvents() {
    _globalGeneration += 1;
    _globalAttempt = 0;
    _globalPollGeneration += 1;
    _globalSseProbe?.cancel();
    _globalSseProbe = null;
    _openGlobalEvents(_globalGeneration);
  }

  void _openGlobalEvents(int generation) {
    if (_disposed || generation != _globalGeneration) return;
    final api = _api;
    if (api == null || _phase != AppPhase.online) return;
    _globalReconnect?.cancel();
    _globalReconnect = null;
    unawaited(_globalSub?.cancel());
    _globalSub = null;
    final connection = ++_globalConnection;

    _globalSub = api
        .stream(
          '/api/events',
          onOpen: () {
            if (generation != _globalGeneration ||
                connection != _globalConnection) {
              return;
            }
            _globalAttempt = 0;
            _globalFailures = 0;
            _resetGlobalWatchdog(generation, connection);
            _armGlobalProbe(generation, connection);
          },
        )
        .listen(
          (frame) {
            if (generation != _globalGeneration ||
                connection != _globalConnection) {
              return;
            }
            _globalSseProbe?.cancel();
            _globalSseProbe = null;
            _globalAttempt = 0;
            _globalFailures = 0;
            _resetGlobalWatchdog(generation, connection);
            _onGlobalFrame(frame);
          },
          onError: (Object error) {
            if (generation != _globalGeneration ||
                connection != _globalConnection) {
              return;
            }
            _globalSseProbe?.cancel();
            _globalSseProbe = null;
            if (error is ApiException && error.isAuthFailure) {
              _markAuthLost(error.message);
              return;
            }
            _scheduleGlobalReconnect(generation, connection);
          },
          onDone: () {
            _globalSseProbe?.cancel();
            _globalSseProbe = null;
            _scheduleGlobalReconnect(generation, connection);
          },
          cancelOnError: true,
        );
    _resetGlobalWatchdog(generation, connection);
  }

  void _armGlobalProbe(int generation, int connection) {
    _globalSseProbe?.cancel();
    _globalSseProbe = Timer(const Duration(seconds: 4), () {
      if (generation != _globalGeneration || connection != _globalConnection) {
        return;
      }
      // Same buffering problem as session follow: keep the app usable through
      // Cloudflare Quick Tunnel by falling back to the poll endpoint.
      _startGlobalPolling(generation, connection);
    });
  }

  void _startGlobalPolling(int generation, int connection) {
    if (_disposed || _phase != AppPhase.online) return;
    if (generation != _globalGeneration || connection != _globalConnection) {
      return;
    }
    _globalGeneration += 1;
    _globalConnection += 1;
    _globalPollGeneration += 1;
    final pollGeneration = _globalPollGeneration;
    _globalSseProbe?.cancel();
    _globalSseProbe = null;
    unawaited(_globalSub?.cancel());
    _globalSub = null;
    _globalWatchdog?.cancel();
    _globalWatchdog = null;
    _globalReconnect?.cancel();
    _globalReconnect = null;
    unawaited(_pollGlobalLoop(pollGeneration));
  }

  Future<void> _pollGlobalLoop(int generation) async {
    var failures = 0;
    while (!_disposed &&
        _phase == AppPhase.online &&
        generation == _globalPollGeneration) {
      final api = _api;
      if (api == null) return;
      try {
        final result = await api.pollGlobalEvents(after: _globalSeq);
        if (generation != _globalPollGeneration) return;
        failures = 0;
        _globalSeq = max(_globalSeq, result.seq);
        _runningIds = result.running.toSet();
        for (final event in result.events) {
          _handleGlobalEvent(event);
        }
        notifyListeners();
        await Future<void>.delayed(const Duration(seconds: 3));
      } on ApiException catch (error) {
        if (error.isAuthFailure) {
          _markAuthLost(error.message);
          return;
        }
        failures += 1;
        if (failures >= 3) {
          await _failoverConnection();
          return;
        }
        await Future<void>.delayed(const Duration(seconds: 5));
      } catch (_) {
        failures += 1;
        if (failures >= 3) {
          await _failoverConnection();
          return;
        }
        await Future<void>.delayed(const Duration(seconds: 5));
      }
    }
  }

  void _resetGlobalWatchdog(int generation, int connection) {
    _globalWatchdog?.cancel();
    _globalWatchdog = Timer(const Duration(seconds: 40), () {
      if (generation != _globalGeneration || connection != _globalConnection) {
        return;
      }
      _scheduleGlobalReconnect(generation, connection);
    });
  }

  void _scheduleGlobalReconnect(int generation, int connection) {
    if (_disposed || generation != _globalGeneration) return;
    if (connection != _globalConnection) return;
    if (_phase != AppPhase.online) return;
    _globalWatchdog?.cancel();
    _globalWatchdog = null;
    _globalAttempt += 1;
    _globalFailures += 1;
    // Retrying the same dead address forever is the classic remote failure:
    // after a few misses, re-probe every candidate (LAN, relay, tunnel).
    if (_globalFailures >= 3 && !_failoverInFlight) {
      unawaited(_failoverConnection());
      return;
    }
    if (_globalReconnect != null) return;
    final seconds = _backoffSeconds(_globalAttempt);
    _globalReconnect = Timer(Duration(seconds: seconds), () {
      _globalReconnect = null;
      if (generation != _globalGeneration) return;
      _openGlobalEvents(generation);
    });
  }

  Future<void> _failoverConnection() async {
    if (_disposed || _failoverInFlight) return;
    final server = _activeServer;
    if (server == null || _phase != AppPhase.online) return;
    _failoverInFlight = true;
    _phase = AppPhase.connecting;
    _lastError = '连接中断，正在切换线路…';
    notifyListeners();
    try {
      await _connectTo(server);
    } finally {
      _failoverInFlight = false;
    }
  }

  void _onGlobalFrame(SseFrame frame) {
    if (frame.data.isEmpty) return;
    final JsonMap event;
    try {
      event = asMap(jsonDecode(frame.data));
    } catch (_) {
      return;
    }
    _handleGlobalEvent(event);
  }

  void _handleGlobalEvent(JsonMap event) {
    switch (asString(event['type'])) {
      case 'hb':
        return;
      case 'sessions-updated':
        _debounceRefresh();
        return;
      case 'running-snapshot':
        final ids = asStringList(event['ids']);
        _runningIds = ids.toSet();
        notifyListeners();
        return;
      case 'running-changed':
        final id = asStringOrNull(event['id']);
        if (id == null) return;
        final next = {..._runningIds};
        if (asBool(event['running'])) {
          next.add(id);
        } else {
          next.remove(id);
        }
        _runningIds = next;
        notifyListeners();
        return;
      default:
        return;
    }
  }

  void _debounceRefresh() {
    _refreshDebounce?.cancel();
    _refreshDebounce = Timer(const Duration(milliseconds: 350), () {
      unawaited(refreshSessions());
    });
  }

  void _stopGlobalEvents() {
    _globalGeneration += 1;
    _globalConnection += 1;
    _globalPollGeneration += 1;
    _globalSseProbe?.cancel();
    _globalSseProbe = null;
    _globalSub?.cancel();
    _globalSub = null;
    _globalWatchdog?.cancel();
    _globalWatchdog = null;
    _globalReconnect?.cancel();
    _globalReconnect = null;
    _refreshDebounce?.cancel();
    _refreshDebounce = null;
  }

  static int _backoffSeconds(int attempt) {
    const steps = [1, 2, 4, 8, 15, 30];
    final index = min(attempt - 1, steps.length - 1);
    return steps[max(0, index)];
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) return;
    if (_phase == AppPhase.online) {
      unawaited(refreshCandidates());
    } else if (_phase == AppPhase.offline) {
      unawaited(retryConnection());
    }
  }

  @override
  void dispose() {
    _disposed = true;
    if (_observingLifecycle) {
      WidgetsBinding.instance.removeObserver(this);
      _observingLifecycle = false;
    }
    _stopGlobalEvents();
    _api?.dispose();
    _api = null;
    _relayTransport?.dispose();
    _relayTransport = null;
    super.dispose();
  }
}
