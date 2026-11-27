/// An HTTP error answered by the host. [code] is the stable machine code from
/// `{ "error": { "code", "message" } }`.
class ApiException implements Exception {
  ApiException(this.status, this.code, this.message);

  final int status;
  final String code;
  final String message;

  bool get isAuthFailure => status == 401;

  @override
  String toString() => 'ApiException($status, $code): $message';
}

/// The transport never produced an HTTP answer (DNS, TLS, timeout, socket).
class TransportException implements Exception {
  TransportException(this.message, [this.cause]);

  final String message;
  final Object? cause;

  @override
  String toString() => 'TransportException: $message';
}

/// Pairing problems are user-facing; the message is ready to display.
class PairingException implements Exception {
  PairingException(this.message);

  final String message;

  @override
  String toString() => message;
}

String describeFailure(Object? error) {
  if (error is ApiException) return error.message;
  if (error is TransportException) return error.message;
  if (error is PairingException) return error.message;
  return '未知错误：$error';
}
