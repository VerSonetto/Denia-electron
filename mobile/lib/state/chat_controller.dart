import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';

import '../core/errors.dart';
import '../core/json.dart';
import '../data/api_client.dart';
import '../data/sse.dart';
import '../models/session.dart';
import '../models/transcript.dart';

typedef ApiProvider = DeniaApi Function();
typedef CatalogProvider = ModelCatalog? Function();

/// One session's live view: cold tail snapshot, SSE replay, transcript fold,
/// approval state, and composer actions.
class ChatController extends ChangeNotifier {
  ChatController({
    required this.sessionId,
    required SessionSummary summary,
    required ApiProvider apiProvider,
    required VoidCallback onAuthLost,
    CatalogProvider? catalogProvider,
    bool initiallyRunning = false,
  }) : _summary = summary,
       _apiProvider = apiProvider,
       _onAuthLost = onAuthLost,
       _catalogProvider = catalogProvider,
       _runningFallback = initiallyRunning;

  final String sessionId;
  final SessionSummary _summary;
  final ApiProvider _apiProvider;
  final VoidCallback _onAuthLost;
  final CatalogProvider? _catalogProvider;

  TranscriptFolder folder = TranscriptFolder();
  SessionHeader? header;

  final List<SessionEnvelope> _envelopes = [];
  final Set<int> _seen = {};
  int _lastSeq = 0;
  int _oldestSeq = 0;
  bool _hasMoreBefore = false;
  bool _runningFallback;
  ModelChoice? _pageSelection;
  PermissionChoice? _pagePermission;
  ModelChoice? _explicitSelection;

  bool _loading = true;
  bool _loaded = false;
  String? _error;
  String? _title;
  bool _sending = false;
  bool _cancelling = false;
  bool _paused = false;
  bool _connected = false;
  bool _authNotified = false;
  bool _disposed = false;

  StreamSubscription<SseFrame>? _followSub;
  Timer? _watchdog;
  Timer? _reconnect;
  Timer? _notifyTimer;
  Timer? _sseProbe;
  bool _polling = false;
  int _followGeneration = 0;
  int _followAttempt = 0;
  int _pollGeneration = 0;

  bool get loading => _loading;
  bool get loaded => _loaded;
  bool get connected => _connected;
  bool get sending => _sending;
  bool get cancelling => _cancelling;
  bool get running => folder.running;
  bool get hasMoreBefore => _hasMoreBefore;
  String? get error => _error;
  List<TranscriptItem> get items => folder.items;
  PendingApproval? get pendingApproval => folder.pendingApproval;
  String get title => folder.title ?? _title ?? _summary.displayTitle;
  String get location => header?.cwdName ?? _summary.cwdName;
  ModelChoice? get selection =>
      _explicitSelection ??
      folder.selection ??
      _pageSelection ??
      _fallbackSelection();

  /// A draft/new session has no log projection yet. Match the console: start
  /// from the first model the catalog offers so the visible label is also the
  /// model that will carry the first prompt.
  ModelChoice? _fallbackSelection() {
    final catalog = _catalogProvider?.call();
    if (catalog == null) return null;
    for (final group in catalog.groups) {
      if (group.models.isEmpty) continue;
      final model = group.models.first;
      return ModelChoice(
        provider: group.id,
        model: model.id,
        reasoningEffort:
            model.defaultEffort ??
            (model.efforts.isNotEmpty ? model.efforts.first : null),
      );
    }
    return null;
  }

  PermissionChoice get permission =>
      folder.permission ?? _pagePermission ?? PermissionChoice.autoEdit;

  Future<void> load() async {
    if (_loading && _loaded) return;
    _loading = true;
    _error = null;
    _notifyNow();
    try {
      final api = _apiProvider();
      final page = await api.fetchSessionPage(sessionId, limit: 300);
      _applyInitialPage(page);
      _loading = false;
      _loaded = true;
      _error = null;
      _notifyNow();
      _startFollow();
    } on ApiException catch (error) {
      _loading = false;
      _loaded = false;
      _error = error.message;
      if (error.isAuthFailure) _notifyAuthLost();
      _notifyNow();
    } catch (error) {
      _loading = false;
      _loaded = false;
      _error = describeFailure(error);
      _notifyNow();
    }
  }

  Future<void> retry() async {
    if (_loaded) {
      if (_polling) {
        _startPolling();
      } else {
        _startFollow();
      }
      return;
    }
    await load();
  }

  Future<void> loadOlder() async {
    if (_loading || !_hasMoreBefore || _oldestSeq <= 0) return;
    _loading = true;
    _notifyNow();
    try {
      final api = _apiProvider();
      final page = await api.fetchSessionPage(
        sessionId,
        before: _oldestSeq,
        limit: 200,
      );
      for (final raw in page.events) {
        final envelope = SessionEnvelope.fromJson(raw);
        if (envelope == null) continue;
        if (!_seen.add(envelope.seq)) continue;
        _envelopes.add(envelope);
      }
      _envelopes.sort((a, b) => a.seq.compareTo(b.seq));
      _hasMoreBefore = page.hasMoreBefore;
      if (_envelopes.isNotEmpty) _oldestSeq = _envelopes.first.seq;
      _rebuildFolder();
    } on ApiException catch (error) {
      if (error.isAuthFailure) {
        _notifyAuthLost();
      } else {
        _error = error.message;
      }
    } catch (error) {
      _error = describeFailure(error);
    } finally {
      _loading = false;
      _notifyNow();
    }
  }

  Future<String?> send(String text) async {
    final prompt = text.trim();
    if (prompt.isEmpty) return '消息不能为空';
    if (_sending) return null;
    final DeniaApi api;
    try {
      api = _apiProvider();
    } catch (error) {
      return describeFailure(error);
    }
    _sending = true;
    _notifyNow();
    try {
      if (folder.running) {
        try {
          await api.steer(sessionId, prompt);
        } on ApiException catch (error) {
          // The turn ended between the UI snapshot and the request. Fall back
          // to a normal prompt instead of dropping the message.
          if (error.status == 409) {
            await api.sendPrompt(sessionId, prompt, selection: selection);
            folder.running = true;
          } else {
            rethrow;
          }
        }
      } else {
        try {
          await api.sendPrompt(sessionId, prompt, selection: selection);
        } on ApiException catch (error) {
          if (error.status == 409) {
            await api.steer(sessionId, prompt);
          } else {
            rethrow;
          }
        }
        folder.running = true;
        _runningFallback = false;
        _notifyNow();
      }
      _error = null;
      return null;
    } on ApiException catch (error) {
      if (error.isAuthFailure) {
        _notifyAuthLost();
      } else {
        _error = error.message;
      }
      return error.message;
    } catch (error) {
      final message = describeFailure(error);
      _error = message;
      return message;
    } finally {
      _sending = false;
      _notifyNow();
    }
  }

  Future<String?> cancelTurn() async {
    if (_cancelling || !folder.running) return null;
    final DeniaApi api;
    try {
      api = _apiProvider();
    } catch (error) {
      return describeFailure(error);
    }
    _cancelling = true;
    _notifyNow();
    try {
      await api.cancelSession(sessionId);
      return null;
    } on ApiException catch (error) {
      if (error.isAuthFailure) _notifyAuthLost();
      return error.message;
    } catch (error) {
      return describeFailure(error);
    } finally {
      _cancelling = false;
      _notifyNow();
    }
  }

  /// Physically truncates the host log at [toSeq] and restores the files that
  /// branch had touched. A running turn is interrupted first, mirroring the
  /// console; the caller resends the target prompt from the composer.
  Future<({String? error, RewindResult? result})> rewindTo(int toSeq) async {
    final DeniaApi api;
    try {
      api = _apiProvider();
    } catch (error) {
      return (error: describeFailure(error), result: null);
    }

    if (folder.running) {
      final stopError = await cancelTurn();
      if (stopError != null && folder.running) {
        return (error: stopError, result: null);
      }
      final stopped = await _waitUntilStopped(const Duration(seconds: 5));
      if (!stopped) {
        return (error: 'AI 未能在 5 秒内停止，请稍后再试', result: null);
      }
    }

    try {
      final result = await api.rewindSession(sessionId, toSeq);
      await _reloadAfterRewind();
      return (error: null, result: result);
    } on ApiException catch (error) {
      final message = error.code == 'session/running'
          ? '当前回复还在运行，请稍后再试'
          : error.message;
      if (error.isAuthFailure) {
        _notifyAuthLost();
      } else {
        _error = message;
        _notifyNow();
      }
      return (error: message, result: null);
    } catch (error) {
      final message = describeFailure(error);
      _error = message;
      _notifyNow();
      return (error: message, result: null);
    }
  }

  Future<bool> _waitUntilStopped(Duration timeout) async {
    if (!folder.running) return true;
    final completer = Completer<bool>();
    void listener() {
      if (!folder.running && !completer.isCompleted) completer.complete(true);
    }

    addListener(listener);
    final timer = Timer(timeout, () {
      if (!completer.isCompleted) completer.complete(false);
    });
    try {
      return await completer.future;
    } finally {
      removeListener(listener);
      timer.cancel();
    }
  }

  Future<void> _reloadAfterRewind() async {
    if (_disposed) return;
    _followGeneration += 1;
    _pollGeneration += 1;
    _sseProbe?.cancel();
    _sseProbe = null;
    _watchdog?.cancel();
    _watchdog = null;
    _reconnect?.cancel();
    _reconnect = null;
    _notifyTimer?.cancel();
    _notifyTimer = null;
    final follow = _followSub;
    _followSub = null;
    await follow?.cancel();
    _polling = false;
    _connected = false;
    _envelopes.clear();
    _seen.clear();
    _lastSeq = 0;
    _oldestSeq = 0;
    _hasMoreBefore = false;
    _runningFallback = false;
    _followAttempt = 0;
    _pageSelection = null;
    _pagePermission = null;
    _loading = false;
    _loaded = false;
    _error = null;
    _title = null;
    header = null;
    folder = TranscriptFolder();
    _notifyNow();
    await load();
  }

  Future<String?> answerApproval(String decision) async {
    final approval = folder.pendingApproval;
    if (approval == null) return null;
    final DeniaApi api;
    try {
      api = _apiProvider();
    } catch (error) {
      return describeFailure(error);
    }
    folder.pendingApproval = null;
    _notifyNow();
    try {
      await api.answerApproval(sessionId, approval.requestId, decision);
      return null;
    } on ApiException catch (error) {
      if (error.isAuthFailure) {
        _notifyAuthLost();
        return error.message;
      }
      if (error.status != 404) {
        folder.pendingApproval = approval;
        _notifyNow();
      }
      return error.status == 404 ? '该审批已结算' : error.message;
    } catch (error) {
      folder.pendingApproval = approval;
      _notifyNow();
      return describeFailure(error);
    }
  }

  Future<String?> setPermission(PermissionChoice choice) async {
    final previous = folder.permission;
    final DeniaApi api;
    try {
      api = _apiProvider();
    } catch (error) {
      return describeFailure(error);
    }
    folder.permission = choice;
    _notifyNow();
    try {
      await api.setPermission(sessionId, choice);
      return null;
    } on ApiException catch (error) {
      folder.permission = previous;
      _notifyNow();
      if (error.isAuthFailure) _notifyAuthLost();
      return error.message;
    } catch (error) {
      folder.permission = previous;
      _notifyNow();
      return describeFailure(error);
    }
  }

  void selectModel(ModelChoice choice) {
    _explicitSelection = choice;
    _notifyNow();
  }

  void clearError() {
    if (_error == null) return;
    _error = null;
    _notifyNow();
  }

  void pause() {
    if (_paused) return;
    _paused = true;
    _followGeneration += 1;
    _pollGeneration += 1;
    _sseProbe?.cancel();
    _sseProbe = null;
    unawaited(_followSub?.cancel());
    _followSub = null;
    _watchdog?.cancel();
    _watchdog = null;
    _reconnect?.cancel();
    _reconnect = null;
    _connected = false;
    _notifyNow();
  }

  void resume() {
    if (!_paused) return;
    _paused = false;
    if (!_loaded || _disposed) return;
    if (_polling) {
      _startPolling();
    } else {
      _startFollow();
    }
  }

  void _applyInitialPage(SessionPage page) {
    header = page.header;
    _title = null;
    _pageSelection = page.lastSelection;
    _pagePermission = page.lastPermission;
    _envelopes.clear();
    _seen.clear();
    _lastSeq = 0;
    _oldestSeq = 0;

    final next = TranscriptFolder()
      ..selection = page.lastSelection
      ..permission = page.lastPermission;
    for (final raw in page.events) {
      final envelope = SessionEnvelope.fromJson(raw);
      if (envelope == null) continue;
      if (!_seen.add(envelope.seq)) continue;
      _envelopes.add(envelope);
      next.apply(envelope);
      if (envelope.type == 'turn-start' || envelope.type == 'turn-end') {
        _runningFallback = false;
      }
    }
    _envelopes.sort((a, b) => a.seq.compareTo(b.seq));
    _lastSeq = next.lastSeq;
    if (_envelopes.isNotEmpty) _oldestSeq = _envelopes.first.seq;
    _hasMoreBefore = page.hasMoreBefore;
    if (_runningFallback) next.running = true;
    folder = next;
  }

  void _rebuildFolder() {
    final next = TranscriptFolder()
      ..selection = _pageSelection
      ..permission = _pagePermission;
    for (final envelope in _envelopes) {
      next.apply(envelope);
      if (envelope.type == 'turn-start' || envelope.type == 'turn-end') {
        _runningFallback = false;
      }
    }
    if (_runningFallback) next.running = true;
    folder = next;
  }

  void _ingestEnvelope(SessionEnvelope envelope) {
    if (!_seen.add(envelope.seq)) return;
    final isGapFill = envelope.seq <= _lastSeq;
    _envelopes.add(envelope);
    if (isGapFill) {
      _envelopes.sort((a, b) => a.seq.compareTo(b.seq));
      _rebuildFolder();
    } else {
      folder.apply(envelope);
      if (envelope.type == 'turn-start' || envelope.type == 'turn-end') {
        _runningFallback = false;
      }
      if (_oldestSeq == 0 || envelope.seq < _oldestSeq) {
        _oldestSeq = envelope.seq;
      }
    }
    if (envelope.seq > _lastSeq) _lastSeq = envelope.seq;
    switch (envelope.type) {
      case 'assistant-chunk':
      case 'tool-output-chunk':
        _notifySoon();
        return;
      default:
        _notifyNow();
    }
  }

  // —— session follow stream ——

  void _startFollow() {
    if (_disposed || _paused || !_loaded) return;
    _pollGeneration += 1;
    _polling = false;
    _sseProbe?.cancel();
    _sseProbe = null;
    final DeniaApi api;
    try {
      api = _apiProvider();
    } catch (error) {
      _error = describeFailure(error);
      _notifyNow();
      return;
    }
    _followGeneration += 1;
    final generation = _followGeneration;
    unawaited(_followSub?.cancel());
    _followSub = null;
    _reconnect?.cancel();
    _reconnect = null;

    _followSub = api
        .stream(
          '/api/sessions/${Uri.encodeComponent(sessionId)}/follow?after=$_lastSeq',
          onOpen: () {
            if (generation != _followGeneration || _disposed) return;
            _connected = true;
            _followAttempt = 0;
            _error = null;
            _resetWatchdog(generation);
            _armSseProbe(generation);
            _notifyNow();
          },
        )
        .listen(
          (frame) {
            if (generation != _followGeneration || _disposed) return;
            _sseProbe?.cancel();
            _sseProbe = null;
            _connected = true;
            _followAttempt = 0;
            _resetWatchdog(generation);
            _onFollowFrame(frame);
          },
          onError: (Object error) {
            if (generation != _followGeneration || _disposed) return;
            _sseProbe?.cancel();
            _sseProbe = null;
            if (error is ApiException && error.isAuthFailure) {
              _notifyAuthLost();
              return;
            }
            _scheduleFollowReconnect(generation);
          },
          onDone: () {
            if (generation != _followGeneration || _disposed) return;
            _sseProbe?.cancel();
            _sseProbe = null;
            _scheduleFollowReconnect(generation);
          },
          cancelOnError: true,
        );
    _resetWatchdog(generation);
  }

  void _onFollowFrame(SseFrame frame) {
    if (frame.data.isEmpty) return;
    final JsonMap payload;
    try {
      payload = asMap(jsonDecode(frame.data));
    } catch (_) {
      return;
    }
    if (asString(payload['type']) == 'hb') return;
    final envelope = SessionEnvelope.fromJson(payload);
    if (envelope == null) return;
    _ingestEnvelope(envelope);
  }

  void _armSseProbe(int generation) {
    _sseProbe?.cancel();
    _sseProbe = Timer(const Duration(seconds: 4), () {
      if (generation != _followGeneration || _disposed) return;
      // Headers arrived but no body frame: a buffering proxy (Cloudflare Quick
      // Tunnel does this) has swallowed the stream. Switch to the host's
      // existing long-poll endpoint instead of waiting for the watchdog.
      _startPolling();
    });
  }

  void _startPolling() {
    if (_disposed || _paused || !_loaded) return;
    _polling = true;
    _followGeneration += 1;
    _pollGeneration += 1;
    final generation = _pollGeneration;
    _sseProbe?.cancel();
    _sseProbe = null;
    unawaited(_followSub?.cancel());
    _followSub = null;
    _reconnect?.cancel();
    _reconnect = null;
    _watchdog?.cancel();
    _watchdog = null;
    _connected = true;
    _error = null;
    _notifyNow();
    unawaited(_pollLoop(generation));
  }

  Future<void> _pollLoop(int generation) async {
    var failures = 0;
    while (!_disposed && !_paused && generation == _pollGeneration) {
      final DeniaApi api;
      try {
        api = _apiProvider();
      } catch (error) {
        _connected = false;
        _error = describeFailure(error);
        _notifyNow();
        await Future<void>.delayed(const Duration(seconds: 5));
        continue;
      }
      try {
        final result = await api.pollSessionEvents(sessionId, after: _lastSeq);
        if (generation != _pollGeneration) return;
        _connected = true;
        failures = 0;
        if (_error != null) {
          _error = null;
          _notifyNow();
        }
        for (final raw in result.envelopes) {
          final envelope = SessionEnvelope.fromJson(raw);
          if (envelope != null) _ingestEnvelope(envelope);
        }
        await Future<void>.delayed(const Duration(seconds: 2));
      } on ApiException catch (error) {
        if (error.isAuthFailure) {
          _notifyAuthLost();
          return;
        }
        failures += 1;
        _connected = false;
        _error = error.message;
        _notifyNow();
        await Future<void>.delayed(Duration(seconds: min(10, 2 + failures)));
      } catch (error) {
        failures += 1;
        _connected = false;
        _error = describeFailure(error);
        _notifyNow();
        await Future<void>.delayed(Duration(seconds: min(10, 2 + failures)));
      }
    }
  }

  void _resetWatchdog(int generation) {
    _watchdog?.cancel();
    _watchdog = Timer(const Duration(seconds: 45), () {
      if (generation != _followGeneration || _disposed) return;
      _scheduleFollowReconnect(generation);
    });
  }

  void _scheduleFollowReconnect(int generation) {
    if (_disposed || _paused || generation != _followGeneration) return;
    _watchdog?.cancel();
    _watchdog = null;
    unawaited(_followSub?.cancel());
    _followSub = null;
    _connected = false;
    _notifySoon();
    if (_reconnect != null) return;
    _followAttempt += 1;
    final delay = _backoff(_followAttempt);
    _reconnect = Timer(delay, () {
      _reconnect = null;
      if (generation != _followGeneration || _disposed || _paused) return;
      _startFollow();
    });
  }

  void _notifyAuthLost() {
    if (_authNotified) return;
    _authNotified = true;
    _connected = false;
    _error = '设备授权已失效，请重新配对';
    _notifyNow();
    _onAuthLost();
  }

  void _notifyNow() {
    if (_disposed) return;
    _notifyTimer?.cancel();
    _notifyTimer = null;
    notifyListeners();
  }

  void _notifySoon() {
    if (_disposed || _notifyTimer != null) return;
    _notifyTimer = Timer(const Duration(milliseconds: 40), () {
      _notifyTimer = null;
      if (!_disposed) notifyListeners();
    });
  }

  static Duration _backoff(int attempt) {
    const seconds = [1, 2, 4, 8, 15, 30];
    final index = min(max(attempt - 1, 0), seconds.length - 1);
    final jitter = Random().nextInt(500);
    return Duration(seconds: seconds[index], milliseconds: jitter);
  }

  @override
  void dispose() {
    _disposed = true;
    _followGeneration += 1;
    _pollGeneration += 1;
    _sseProbe?.cancel();
    _followSub?.cancel();
    _followSub = null;
    _watchdog?.cancel();
    _reconnect?.cancel();
    _notifyTimer?.cancel();
    super.dispose();
  }
}
