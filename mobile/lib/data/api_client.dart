import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../core/constants.dart';
import '../core/errors.dart';
import '../core/json.dart';
import '../models/session.dart';
import 'sse.dart';

/// HTTP + SSE client for one base URL and one device token.
///
/// The client is deliberately stateless about pairing and failover: callers
/// probe each candidate and keep the first one whose `serverId` matches.
class DeniaApi {
  DeniaApi({required String baseUrl, String? token, HttpClient? httpClient})
    : _baseUrl = _stripTrailingSlash(baseUrl.trim()),
      _token = token,
      _client = httpClient ?? _newClient(),
      _ownsClient = httpClient == null;

  static const Duration _connectTimeout = Duration(seconds: 12);
  static const Duration _responseTimeout = Duration(seconds: 25);

  final String _baseUrl;
  final String? _token;
  final HttpClient _client;
  final bool _ownsClient;

  String get baseUrl => _baseUrl;

  static HttpClient _newClient() {
    final client = HttpClient()
      ..connectionTimeout = _connectTimeout
      ..idleTimeout = const Duration(seconds: 60)
      ..autoUncompress = true
      ..userAgent = kUserAgent;
    return client;
  }

  void dispose() {
    if (_ownsClient) _client.close(force: true);
  }

  // —— remote pairing ——

  Future<RemoteStatus> status() async {
    return RemoteStatus.fromJson(await _json('GET', '/api/remote/status'));
  }

  Future<RedeemResult> redeem({
    String? link,
    String? code,
    required String deviceName,
    required String dedupeKey,
  }) async {
    final body = <String, dynamic>{
      'clientKind': 'mobile',
      'deviceName': deviceName,
      'devicePlatform': 'android',
      'appVersion': kAppVersion,
      'dedupeKey': dedupeKey,
      if (link != null) 'link': link,
      if (link == null && code != null) 'code': code,
    };
    return RedeemResult.fromJson(
      await _json('POST', '/api/remote/redeem', body: body),
    );
  }

  Future<void> revokeSelf(String clientId) async {
    await _json(
      'DELETE',
      '/api/remote/clients/${Uri.encodeComponent(clientId)}',
    );
  }

  // —— sessions ——

  Future<List<SessionSummary>> listSessions() async {
    final body = await _json('GET', '/api/sessions');
    return asMapList(body['sessions'])
        .map(SessionSummary.fromJson)
        .toList(growable: false);
  }

  Future<SessionSummary> createSession({String? projectId}) async {
    final body = await _json(
      'POST',
      '/api/sessions',
      body: {if (projectId != null) 'projectId': projectId},
    );
    return SessionSummary.fromJson(asMap(body['session']));
  }

  Future<SessionPage> fetchSessionPage(
    String sessionId, {
    int? before,
    int limit = 300,
  }) async {
    final query = StringBuffer('?limit=$limit');
    if (before != null) query.write('&before=$before');
    final body = await _json(
      'GET',
      '/api/sessions/${Uri.encodeComponent(sessionId)}/events$query',
    );
    final anchors = <int>[];
    for (final anchor in asMapList(body['anchors'])) {
      final seq = asIntOrNull(anchor['seq']);
      if (seq != null) anchors.add(seq);
    }
    final selection = asMap(body['last_selection']);
    final provider = asStringOrNull(selection['provider']);
    final model = asStringOrNull(selection['model']);
    return SessionPage(
      header: SessionHeader.fromJson(asMap(body['header'])),
      events: asMapList(body['events']),
      total: asInt(body['total']),
      hasMoreBefore: asBool(body['hasMoreBefore']),
      anchors: anchors,
      lastSelection: provider != null && model != null
          ? ModelChoice(
              provider: provider,
              model: model,
              reasoningEffort: asStringOrNull(selection['reasoningEffort']),
            )
          : null,
      lastPermission: PermissionChoice.parse(
        asStringOrNull(body['last_permission']),
      ),
    );
  }

  Future<SessionEventPoll> pollSessionEvents(
    String sessionId, {
    required int after,
    int waitSeconds = 0,
  }) async {
    final body = await _json(
      'GET',
      '/api/sessions/${Uri.encodeComponent(sessionId)}/follow/poll'
          '?after=$after&wait=$waitSeconds',
    );
    return SessionEventPoll(
      envelopes: asMapList(body['envelopes']),
      seq: asInt(body['seq'], after),
    );
  }

  Future<GlobalEventPoll> pollGlobalEvents({
    required int after,
    int waitSeconds = 0,
  }) async {
    final body = await _json(
      'GET',
      '/api/events/poll?after=$after&wait=$waitSeconds',
    );
    return GlobalEventPoll(
      events: asMapList(body['events']),
      seq: asInt(body['seq'], after),
      running: asStringList(body['running']),
    );
  }

  Future<void> sendPrompt(
    String sessionId,
    String prompt, {
    ModelChoice? selection,
  }) async {
    await _json(
      'POST',
      '/api/sessions/${Uri.encodeComponent(sessionId)}/prompt',
      body: {
        'prompt': prompt,
        if (selection != null) ...selection.toPromptJson(),
      },
    );
  }

  Future<void> steer(String sessionId, String prompt) async {
    await _json(
      'POST',
      '/api/sessions/${Uri.encodeComponent(sessionId)}/steer',
      body: {'prompt': prompt},
    );
  }

  Future<void> cancelSession(String sessionId) async {
    await _json(
      'POST',
      '/api/sessions/${Uri.encodeComponent(sessionId)}/cancel',
      body: const {},
    );
  }

  Future<List<FileDiffEntry>> checkpointDiff(String sessionId, int seq) async {
    final body = await _json(
      'GET',
      '/api/sessions/${Uri.encodeComponent(sessionId)}/checkpoints/$seq/diff',
    );
    return asMapList(body['changes'])
        .map(FileDiffEntry.fromJson)
        .toList(growable: false);
  }

  Future<RewindResult> rewindSession(String sessionId, int toSeq) async {
    final body = await _json(
      'POST',
      '/api/sessions/${Uri.encodeComponent(sessionId)}/rewind',
      body: {'toSeq': toSeq},
    );
    return RewindResult.fromJson(body);
  }

  Future<void> answerApproval(
    String sessionId,
    String requestId,
    String decision,
  ) async {
    await _json(
      'POST',
      '/api/sessions/${Uri.encodeComponent(sessionId)}/approvals/${Uri.encodeComponent(requestId)}',
      body: {'decision': decision},
    );
  }

  Future<void> setPermission(String sessionId, PermissionChoice choice) async {
    await _json(
      'PUT',
      '/api/sessions/${Uri.encodeComponent(sessionId)}/permission',
      body: {'mode': choice.wire},
    );
  }

  Future<void> deleteSession(String sessionId) async {
    await _json('DELETE', '/api/sessions/${Uri.encodeComponent(sessionId)}');
  }

  // —— workspace / models ——

  Future<List<ProjectRecord>> listProjects() async {
    final body = await _json('GET', '/api/projects');
    return asMapList(body['projects'])
        .map(ProjectRecord.fromJson)
        .toList(growable: false);
  }

  Future<ModelCatalog> modelCatalog() async {
    return ModelCatalog.fromJson(await _json('GET', '/api/llm/catalog'));
  }

  // —— event streams ——

  Stream<SseFrame> stream(String path, {void Function()? onOpen}) async* {
    HttpClientRequest? request;
    try {
      request = await _client
          .openUrl('GET', _uri(path))
          .timeout(_connectTimeout);
      _applyHeaders(request, accept: 'text/event-stream');
      request.headers.set(HttpHeaders.cacheControlHeader, 'no-cache');
      final response = await request.close().timeout(_connectTimeout);
      if (response.statusCode < 200 || response.statusCode >= 300) {
        final text = await utf8.decodeStream(response);
        throw _errorFrom(response, text);
      }
      onOpen?.call();
      final parser = SseParser();
      await for (final chunk in response.transform(
        const Utf8Decoder(allowMalformed: true),
      )) {
        final frames = <SseFrame>[];
        parser.add(chunk, frames.add);
        for (final frame in frames) {
          yield frame;
        }
      }
      final tail = <SseFrame>[];
      parser.close(tail.add);
      for (final frame in tail) {
        yield frame;
      }
    } on ApiException {
      rethrow;
    } on TimeoutException {
      throw TransportException('连接事件流超时');
    } on SocketException catch (error) {
      throw TransportException(_socketMessage(error), error);
    } on HandshakeException catch (error) {
      throw TransportException('TLS 握手失败：${error.message}', error);
    } finally {
      request?.abort();
    }
  }

  // —— request plumbing ——

  Future<JsonMap> _json(String method, String path, {JsonMap? body}) async {
    HttpClientRequest? request;
    try {
      request = await _client
          .openUrl(method, _uri(path))
          .timeout(_connectTimeout);
      _applyHeaders(request);
      if (body != null) {
        request.headers.contentType = ContentType.json;
        request.write(jsonEncode(body));
      }
      final response = await request.close().timeout(_responseTimeout);
      final text = await utf8.decodeStream(response).timeout(_responseTimeout);
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw _errorFrom(response, text);
      }
      final trimmed = text.trim();
      if (trimmed.isEmpty) return const {};
      try {
        final decoded = jsonDecode(trimmed);
        if (decoded is! Map) {
          throw ApiException(response.statusCode, 'bad-json', '服务器返回了非对象响应');
        }
        return asMap(decoded);
      } on FormatException {
        throw ApiException(response.statusCode, 'bad-json', '服务器返回了无法解析的响应');
      }
    } on ApiException {
      rethrow;
    } on TimeoutException {
      request?.abort();
      throw TransportException('请求超时');
    } on SocketException catch (error) {
      throw TransportException(_socketMessage(error), error);
    } on HandshakeException catch (error) {
      throw TransportException('TLS 握手失败：${error.message}', error);
    }
  }

  void _applyHeaders(
    HttpClientRequest request, {
    String accept = 'application/json',
  }) {
    request.headers.set(HttpHeaders.acceptHeader, accept);
    request.headers.set(HttpHeaders.userAgentHeader, kUserAgent);
    final token = _token;
    if (token != null && token.isNotEmpty) {
      request.headers.set(HttpHeaders.authorizationHeader, 'Bearer $token');
    }
  }

  ApiException _errorFrom(HttpClientResponse response, String text) {
    var code = 'http-${response.statusCode}';
    var message = response.reasonPhrase;
    final trimmed = text.trim();
    if (trimmed.isNotEmpty) {
      try {
        final decoded = jsonDecode(trimmed);
        final error = asMap(asMap(decoded)['error']);
        code = asString(error['code'], code);
        message = asString(error['message'], message);
      } catch (_) {
        if (trimmed.length <= 300) message = trimmed;
      }
    }
    if (response.statusCode == 401) {
      message = message.isEmpty ? '设备授权已失效，请重新配对' : message;
    }
    return ApiException(response.statusCode, code, message);
  }

  Uri _uri(String path) {
    final normalized = path.startsWith('/') ? path : '/$path';
    return Uri.parse('$_baseUrl$normalized');
  }

  static String _stripTrailingSlash(String value) {
    var text = value;
    while (text.endsWith('/')) {
      text = text.substring(0, text.length - 1);
    }
    return text;
  }

  static String _socketMessage(SocketException error) {
    final host = error.address?.host;
    if (host != null) return '无法连接到 $host';
    switch (error.osError?.errorCode) {
      case 111:
      case 61:
        return '连接被拒绝，桌面端可能未开启远程访问';
      case 110:
      case 60:
        return '连接超时';
      default:
        return '网络不可达';
    }
  }
}
