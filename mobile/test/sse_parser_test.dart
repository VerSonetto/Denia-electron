import 'package:denia_mobile/data/sse.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('SseParser', () {
    test('parses a frame split across chunks', () {
      final parser = SseParser();
      final frames = <SseFrame>[];
      parser.add('data: {"type":"assistant-chunk",', frames.add);
      parser.add('"text":"hi"}\n\n', frames.add);
      expect(frames, hasLength(1));
      expect(frames.single.data, '{"type":"assistant-chunk","text":"hi"}');
    });

    test('handles CRLF split exactly between CR and LF', () {
      final parser = SseParser();
      final frames = <SseFrame>[];
      parser.add('event: turn\r', frames.add);
      expect(frames, isEmpty);
      parser.add('\ndata: one\r\n\r\n', frames.add);
      expect(frames, hasLength(1));
      expect(frames.single.event, 'turn');
      expect(frames.single.data, 'one');
    });

    test('joins multiple data lines with newlines', () {
      final parser = SseParser();
      final frames = <SseFrame>[];
      parser.add('data: line1\ndata: line2\n\n', frames.add);
      expect(frames.single.data, 'line1\nline2');
    });

    test('ignores comments and records retry', () {
      final parser = SseParser();
      final frames = <SseFrame>[];
      parser.add(': keepalive\nretry: 2500\ndata: x\n\n', frames.add);
      expect(frames.single.retry, 2500);
      expect(parser.retryHint, 2500);
    });

    test('dispatches only when a blank line closes the frame', () {
      final parser = SseParser();
      final frames = <SseFrame>[];
      parser.add('data: a\n', frames.add);
      expect(frames, isEmpty);
      parser.add('\n', frames.add);
      expect(frames, hasLength(1));
    });

    test('flushes a pending frame on close', () {
      final parser = SseParser();
      final frames = <SseFrame>[];
      parser.add('data: tail', frames.add);
      expect(frames, isEmpty);
      parser.close(frames.add);
      expect(frames.single.data, 'tail');
    });

    test('ignores empty events', () {
      final parser = SseParser();
      final frames = <SseFrame>[];
      parser.add('\n\n\n', frames.add);
      expect(frames, isEmpty);
    });
  });
}
