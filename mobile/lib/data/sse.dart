/// One parsed SSE frame. `data` is the joined data payload, exactly as the
/// spec defines it; the Denia host sends a single JSON line per frame.
class SseFrame {
  const SseFrame({this.event, this.data = '', this.id, this.retry});

  final String? event;
  final String data;
  final String? id;
  final int? retry;

  bool get isEmpty => data.isEmpty && event == null;
}

/// Incremental SSE parser. Accepts arbitrary chunk boundaries, including a
/// CRLF split between two chunks.
class SseParser {
  String _buffer = '';
  String? _event;
  final List<String> _data = [];
  String? _id;
  int? _retry;

  /// The last `retry:` value seen, for callers that honour server backoff.
  int? get retryHint => _retry;

  void add(String chunk, void Function(SseFrame frame) emit) {
    if (chunk.isEmpty) return;
    _buffer += chunk;
    var start = 0;
    while (true) {
      final index = _lineBreakIndex(_buffer, start);
      if (index == null) break;
      final isCr = _buffer.codeUnitAt(index) == 13;
      // A trailing CR may be the first half of CRLF. Keep it buffered until
      // the next chunk resolves the ambiguity.
      if (isCr && index == _buffer.length - 1) break;
      var next = index + 1;
      if (isCr && next < _buffer.length && _buffer.codeUnitAt(next) == 10) {
        next += 1;
      }
      final line = _buffer.substring(start, index);
      _processLine(line, emit);
      start = next;
    }
    if (start > 0) _buffer = _buffer.substring(start);
  }

  /// Flush whatever is left when the connection closes. An unterminated final
  /// line is still data per the stream-reading shape used here.
  void close(void Function(SseFrame frame) emit) {
    if (_buffer.isNotEmpty) {
      final line = _buffer;
      _buffer = '';
      _processLine(line, emit);
    }
    _dispatch(emit);
  }

  void _processLine(String line, void Function(SseFrame frame) emit) {
    if (line.isEmpty) {
      _dispatch(emit);
      return;
    }
    if (line.startsWith(':')) return;
    final colon = line.indexOf(':');
    final field = colon < 0 ? line : line.substring(0, colon);
    var value = colon < 0 ? '' : line.substring(colon + 1);
    if (value.startsWith(' ')) value = value.substring(1);
    switch (field) {
      case 'event':
        _event = value;
        return;
      case 'data':
        _data.add(value);
        return;
      case 'id':
        _id = value;
        return;
      case 'retry':
        final parsed = int.tryParse(value);
        if (parsed != null) _retry = parsed;
        return;
      default:
        return;
    }
  }

  void _dispatch(void Function(SseFrame frame) emit) {
    if (_data.isEmpty) {
      _event = null;
      _id = null;
      return;
    }
    final frame = SseFrame(
      event: _event,
      data: _data.join('\n'),
      id: _id,
      retry: _retry,
    );
    _event = null;
    _data.clear();
    _id = null;
    emit(frame);
  }

  static int? _lineBreakIndex(String value, int start) {
    for (var index = start; index < value.length; index += 1) {
      final code = value.codeUnitAt(index);
      if (code == 10 || code == 13) return index;
    }
    return null;
  }
}
