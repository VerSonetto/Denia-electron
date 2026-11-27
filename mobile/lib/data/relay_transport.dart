import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import '../core/errors.dart';
import 'relay_crypto.dart';

/// One E2EE WebSocket tunnel to the host, exposed to the rest of the app as a
/// loopback HTTP origin. `DeniaApi` keeps using its normal HttpClient/SSE code;
/// this proxy turns every local request into encrypted tunnel frames.
class RelayTransport {
  RelayTransport({
    required this.relayUrl,
    required this.serverId,
    required this.hostPublicKey,
    this.onStateChanged,
  });

  final String relayUrl;
  final String serverId;
  final Uint8List hostPublicKey;
  final void Function()? onStateChanged;

  WebSocket? _socket;
  HttpServer? _proxy;
  RelayEncryptor? _encryptor;
  RelayDecryptor? _decryptor;
  final Map<int, _ProxyStream> _streams = {};
  int _nextStreamId = 1;
  bool _disposed = false;
  bool _connected = false;
  int _reconnectAttempt = 0;
  Timer? _reconnectTimer;
  Completer<void>? _ready;
  Future<void> _sendQueue = Future<void>.value();
  Future<void> _receiveQueue = Future<void>.value();
  String? _baseUrl;

  bool get connected => _connected;
  String get baseUrl {
    final value = _baseUrl;
    if (value == null) throw TransportException('中继尚未连接');
    return value;
  }

  Future<void> connect() async {
    if (_disposed) throw TransportException('中继已关闭');
    if (_connected) return;
    await _openSocket();
    if (_proxy == null) {
      final proxy = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      proxy.autoCompress = false;
      _proxy = proxy;
      _baseUrl = 'http://127.0.0.1:${proxy.port}';
      proxy.listen(_handleProxyRequest);
    }
  }

  Future<void> _openSocket() async {
    if (_disposed) throw TransportException('中继已关闭');
    final handshake = await RelayClientHandshake.create();
    final publicKey = await handshake.publicKeyBytes();
    final uri = Uri.parse(relayUrl);
    final query = Map<String, String>.from(uri.queryParameters);
    query.addAll({'v': '1', 'role': 'client', 'serverId': serverId});
    final target = uri.replace(queryParameters: query);
    final ready = Completer<void>();
    _ready = ready;
    WebSocket socket;
    try {
      socket = await WebSocket.connect(target.toString())
          .timeout(const Duration(seconds: 12));
      socket.pingInterval = const Duration(seconds: 20);
    } catch (error) {
      throw TransportException('无法连接私有中继', error);
    }
    _socket = socket;
    socket.listen(
      (data) => _enqueueReceive(() => _receive(data, handshake, ready)),
      onError: (Object error) => _fail(error),
      onDone: _onSocketDone,
      cancelOnError: true,
    );
    socket.add(
      jsonEncode({
        't': 'hello',
        'v': relayProtocolVersion,
        'pub': {'kty': 'OKP', 'crv': 'X25519', 'x': encodeBase64Url(publicKey)},
        'nonce': encodeBase64Url(handshake.nonce),
      }),
    );
    try {
      await ready.future.timeout(const Duration(seconds: 12));
    } on TimeoutException {
      _fail(TransportException('中继握手超时'));
      throw TransportException('中继握手超时');
    }
    _connected = true;
    _reconnectAttempt = 0;
    onStateChanged?.call();
  }

  Future<void> _receive(
    dynamic data,
    RelayClientHandshake handshake,
    Completer<void> ready,
  ) async {
    if (!ready.isCompleted) {
      if (data is! String) throw RelayCryptoException('握手帧必须是文本');
      final message = decodeJsonPayload(Uint8List.fromList(utf8.encode(data)));
      if (message['t'] != 'ready' || message['v'] != relayProtocolVersion) {
        throw RelayCryptoException('主机握手响应无效');
      }
      final keys = await handshake.finish(hostPublicKey);
      _encryptor = RelayEncryptor(keys.clientToHost);
      _decryptor = RelayDecryptor(keys.hostToClient);
      ready.complete();
      return;
    }
    if (data is! List<int>) throw RelayCryptoException('加密通道收到了文本帧');
    final plaintext = await _decryptor!.decrypt(Uint8List.fromList(data));
    _dispatchFrame(decodeTunnelFrame(plaintext));
  }

  void _enqueueReceive(Future<void> Function() task) {
    final next = _receiveQueue.then((_) => task());
    _receiveQueue = next.catchError((Object error) {
      _fail(error);
    });
  }

  void _dispatchFrame(RelayTunnelFrame frame) {
    if (frame.type == RelayFrameType.ping) {
      _sendFrame(RelayFrameType.pong, 0, frame.payload).catchError((_) {});
      return;
    }
    final stream = _streams[frame.streamId];
    if (stream == null) return;
    switch (frame.type) {
      case RelayFrameType.httpResponse:
        stream.onHeaders(decodeJsonPayload(frame.payload));
        return;
      case RelayFrameType.httpBody:
        stream.onBody(frame.payload);
        return;
      case RelayFrameType.streamEnd:
        _streams.remove(frame.streamId);
        stream.onEnd();
        return;
      case RelayFrameType.streamAbort:
        _streams.remove(frame.streamId);
        final payload = decodeJsonPayload(frame.payload);
        stream.onAbort('${payload['reason'] ?? '中继中断'}');
        return;
      default:
        return;
    }
  }

  Future<void> _handleProxyRequest(HttpRequest request) async {
    final response = request.response;
    if (!_connected || _encryptor == null) {
      response.statusCode = 503;
      await response.close();
      return;
    }
    final streamId = _nextStreamId++;
    final stream = _ProxyStream(response);
    _streams[streamId] = stream;
    final headers = <String, String>{};
    request.headers.forEach((name, values) {
      final lower = name.toLowerCase();
      if (lower == 'host' ||
          lower == 'connection' ||
          lower == 'keep-alive' ||
          lower == 'transfer-encoding' ||
          lower == 'content-length' ||
          lower == 'accept-encoding' ||
          lower == 'upgrade') {
        return;
      }
      headers[lower] = values.join(', ');
    });
    final method = request.method;
    final hasBody =
        request.contentLength > 0 || request.headers.chunkedTransferEncoding;
    Future<void> sendRequest() async {
      await _sendFrame(
        RelayFrameType.httpRequest,
        streamId,
        encodeJsonPayload({
          'method': method,
          'path': request.uri.path,
          'query': request.uri.query,
          'headers': headers,
          'hasBody': hasBody,
        }),
      );
      if (!hasBody) return;
      try {
        await for (final chunk in request) {
          await _sendFrame(RelayFrameType.httpBody, streamId, chunk);
        }
        await _sendFrame(RelayFrameType.streamEnd, streamId);
      } catch (_) {
        _streams.remove(streamId);
        await _sendFrame(
          RelayFrameType.streamAbort,
          streamId,
          encodeJsonPayload({'reason': 'local request aborted'}),
        ).catchError((_) {});
      }
    }

    unawaited(sendRequest());
  }

  Future<void> _sendFrame(int type, int streamId, [Uint8List? payload]) {
    final next = _sendQueue.then((_) async {
      final encryptor = _encryptor;
      final socket = _socket;
      if (encryptor == null ||
          socket == null ||
          socket.readyState != WebSocket.open) {
        throw TransportException('中继连接已断开');
      }
      final encrypted = await encryptor.encrypt(
        encodeTunnelFrame(type, streamId, payload),
      );
      socket.add(encrypted);
    });
    _sendQueue = next.catchError((_) {});
    return next;
  }

  void _onSocketDone() {
    if (_disposed) return;
    _connected = false;
    _failStreams('中继连接已断开');
    onStateChanged?.call();
    _scheduleReconnect();
  }

  void _fail(Object error) {
    if (_disposed) return;
    _connected = false;
    final ready = _ready;
    if (ready != null && !ready.isCompleted) {
      ready.completeError(error);
    }
    _failStreams('中继错误：$error');
    onStateChanged?.call();
    if (_proxy != null) _scheduleReconnect();
  }

  void _failStreams(String reason) {
    for (final stream in _streams.values) {
      stream.onAbort(reason);
    }
    _streams.clear();
  }

  void _scheduleReconnect() {
    if (_disposed || _reconnectTimer != null) return;
    _reconnectAttempt += 1;
    final seconds = (1 << (_reconnectAttempt - 1).clamp(0, 5)).clamp(1, 30);
    _reconnectTimer = Timer(Duration(seconds: seconds), () async {
      _reconnectTimer = null;
      if (_disposed || _connected) return;
      try {
        await _openSocket();
        onStateChanged?.call();
      } catch (_) {
        _scheduleReconnect();
      }
    });
  }

  Future<void> reset() async {
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    final socket = _socket;
    _socket = null;
    _connected = false;
    _encryptor = null;
    _decryptor = null;
    _failStreams('中继重连');
    await socket?.close();
    _reconnectAttempt = 0;
    await _openSocket();
    onStateChanged?.call();
  }

  void dispose() {
    _disposed = true;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _failStreams('中继已关闭');
    _socket?.close();
    _socket = null;
    _proxy?.close(force: true);
    _proxy = null;
  }
}

class _ProxyStream {
  _ProxyStream(this.response);

  final HttpResponse response;
  bool _headersSent = false;
  bool _closed = false;
  bool _endQueued = false;
  Future<void> _queue = Future<void>.value();

  void _enqueue(Future<void> Function() task) {
    _queue = _queue.then((_) => task()).catchError((_) {});
  }

  void onHeaders(Map<String, dynamic> payload) {
    if (_closed) return;
    final status = (payload['status'] as num?)?.toInt() ?? 502;
    response.statusCode = status;
    final headers = payload['headers'];
    if (headers is Map) {
      headers.forEach((key, value) {
        final name = key.toString();
        final lower = name.toLowerCase();
        if (lower == 'connection' ||
            lower == 'keep-alive' ||
            lower == 'transfer-encoding' ||
            lower == 'content-length' ||
            lower == 'content-encoding') {
          return;
        }
        if (value is String) {
          try {
            response.headers.set(name, value);
          } catch (_) {
            // A hop-by-hop or forbidden header is simply not mirrored.
          }
        }
      });
    }
    response.bufferOutput = false;
    response.contentLength = -1;
    _headersSent = true;
  }

  void onBody(Uint8List payload) {
    if (_closed || !_headersSent) return;
    _enqueue(() async {
      if (_closed) return;
      response.add(payload);
      await response.flush();
    });
  }

  void onEnd() {
    if (_endQueued) return;
    _endQueued = true;
    _enqueue(() async {
      if (_closed) return;
      _closed = true;
      await response.close();
    });
  }

  void onAbort(String reason) {
    if (_endQueued) return;
    _endQueued = true;
    _enqueue(() async {
      if (_closed) return;
      _closed = true;
      if (!_headersSent) {
        response.statusCode = 502;
        response.headers.contentType = ContentType.json;
        response.write(
          '{"error":{"code":"relay/stream-aborted","message":${_jsonString(reason)}}}',
        );
      }
      await response.close();
    });
  }

  static String _jsonString(String value) {
    return '"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')}"';
  }
}
