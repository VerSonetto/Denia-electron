import 'package:denia_mobile/core/json.dart';
import 'package:denia_mobile/models/session.dart';
import 'package:denia_mobile/models/transcript.dart';
import 'package:flutter_test/flutter_test.dart';

SessionEnvelope _event(int seq, String type, [JsonMap data = const {}]) {
  return SessionEnvelope(
    seq: seq,
    time: seq * 10,
    type: type,
    data: {'type': type, 'seq': seq, 'time': seq * 10, ...data},
  );
}

TranscriptFolder _fold(List<SessionEnvelope> events) {
  final folder = TranscriptFolder();
  for (final event in events) {
    folder.apply(event);
  }
  return folder;
}

void main() {
  group('assistant streaming', () {
    test(
      'accumulates text deltas and replaces with the authoritative message',
      () {
        final folder = _fold([
          _event(1, 'turn-start', {'turn': 1}),
          _event(2, 'assistant-chunk', {
            'turn': 1,
            'step': 1,
            'chunk': {'type': 'block-start', 'index': 0, 'block_type': 'text'},
          }),
          _event(3, 'assistant-chunk', {
            'turn': 1,
            'step': 1,
            'chunk': {'type': 'text-delta', 'index': 0, 'text': 'Hello'},
          }),
          _event(4, 'assistant-chunk', {
            'turn': 1,
            'step': 1,
            'chunk': {'type': 'text-delta', 'index': 0, 'text': ' world'},
          }),
        ]);
        expect(folder.items, hasLength(1));
        final streaming = folder.items.single as AssistantItem;
        expect(streaming.blocks.single.text, 'Hello world');
        expect(streaming.streaming, isTrue);

        folder.apply(
          _event(5, 'assistant-message', {
            'turn': 1,
            'step': 1,
            'blocks': [
              {'type': 'text', 'text': 'Hello world'},
            ],
          }),
        );
        expect(folder.items, hasLength(1));
        final settled = folder.items.single as AssistantItem;
        expect(settled.streaming, isFalse);
        expect(settled.blocks.single.text, 'Hello world');
      },
    );

    test(
      'separates reasoning from text and handles reasoning-first deltas',
      () {
        final folder = _fold([
          _event(1, 'assistant-chunk', {
            'turn': 1,
            'step': 1,
            'chunk': {'type': 'reasoning-delta', 'index': 0, 'text': 'think'},
          }),
          _event(2, 'assistant-chunk', {
            'turn': 1,
            'step': 1,
            'chunk': {'type': 'text-delta', 'index': 1, 'text': 'answer'},
          }),
        ]);
        final item = folder.items.single as AssistantItem;
        expect(item.blocks, hasLength(2));
        expect(item.blocks[0].kind, AssistantBlockKind.reasoning);
        expect(item.blocks[0].text, 'think');
        expect(item.blocks[1].kind, AssistantBlockKind.text);
        expect(item.reasoningText, 'think');
      },
    );

    test('an out-of-range index appends instead of creating holes', () {
      final folder = _fold([
        _event(1, 'assistant-chunk', {
          'turn': 1,
          'step': 1,
          'chunk': {'type': 'text-delta', 'index': 7, 'text': 'late'},
        }),
      ]);
      final item = folder.items.single as AssistantItem;
      expect(item.blocks, hasLength(1));
      expect(item.blocks.single.text, 'late');
    });

    test('assistant-message without live chunks creates one item', () {
      final folder = _fold([
        _event(1, 'assistant-message', {
          'turn': 2,
          'step': 1,
          'blocks': [
            {'type': 'text', 'text': 'from history'},
          ],
        }),
      ]);
      expect(folder.items, hasLength(1));
      expect((folder.items.single as AssistantItem).streaming, isFalse);
    });
  });

  group('tools', () {
    test('pairs a tool call with its result', () {
      final folder = _fold([
        _event(1, 'tool-call', {
          'call_id': 'c1',
          'name': 'bash',
          'arguments': '{"command":"ls"}',
        }),
        _event(2, 'tool-result', {
          'call_id': 'c1',
          'content': 'a.txt',
          'is_error': false,
        }),
      ]);
      final tool = folder.items.single as ToolItem;
      expect(tool.name, 'bash');
      expect(tool.result?.content, 'a.txt');
      expect(tool.isRunning, isFalse);
    });

    test('creates an orphan row when the call is outside the window', () {
      final folder = _fold([
        _event(1, 'tool-result', {
          'call_id': 'outside',
          'content': 'partial output',
          'is_error': true,
        }),
      ]);
      final tool = folder.items.single as ToolItem;
      expect(tool.callId, 'outside');
      expect(tool.result?.isError, isTrue);
    });

    test('ignores in-place replacement results', () {
      final folder = _fold([
        _event(1, 'tool-result', {
          'call_id': 'c1',
          'content': 'replacement',
          'is_error': false,
          'replaces': 9,
        }),
      ]);
      expect(folder.items, isEmpty);
    });

    test('buffers live output and clears it when the result arrives', () {
      final folder = _fold([
        _event(1, 'tool-call', {
          'call_id': 'c1',
          'name': 'bash',
          'arguments': '{}',
        }),
        _event(2, 'tool-output-chunk', {
          'call_id': 'c1',
          'stream': 'stdout',
          'text': 'run',
        }),
        _event(3, 'tool-output-chunk', {
          'call_id': 'c1',
          'stream': 'stdout',
          'text': 'ning',
        }),
      ]);
      final tool = folder.items.single as ToolItem;
      expect(tool.liveOutput, 'running');

      folder.apply(
        _event(4, 'tool-result', {
          'call_id': 'c1',
          'content': 'done',
          'is_error': false,
        }),
      );
      expect(tool.liveOutput, isEmpty);
      expect(tool.result?.content, 'done');
    });
  });

  group('state projections', () {
    test('tracks the latest unresolved approval', () {
      final folder = _fold([
        _event(1, 'approval-asked', {
          'request_id': 'r1',
          'call_id': 'c1',
          'tool': 'bash',
          'args_preview': 'rm -rf build',
          'reason': 'destructive',
        }),
      ]);
      expect(folder.pendingApproval?.requestId, 'r1');
      expect(folder.pendingApproval?.reason, 'destructive');

      folder.apply(
        _event(2, 'approval-decided', {
          'request_id': 'r2',
          'outcome': 'rejected',
        }),
      );
      expect(folder.pendingApproval, isNotNull);

      folder.apply(
        _event(3, 'approval-decided', {
          'request_id': 'r1',
          'outcome': 'allowed-once',
        }),
      );
      expect(folder.pendingApproval, isNull);
    });

    test('maps permission selection and request headers', () {
      final folder = _fold([
        _event(1, 'permission-selection', {
          'sandbox': 'danger-full-access',
          'approval': 'never',
          'reviewer': 'user',
          'collaboration': 'default',
        }),
        _event(2, 'request-header', {
          'header': {
            'config': {
              'provider': 'openai',
              'model': 'gpt-5',
              'reasoningEffort': 'high',
            },
          },
        }),
      ]);
      expect(folder.permission, PermissionChoice.full);
      expect(folder.selection?.provider, 'openai');
      expect(folder.selection?.model, 'gpt-5');
      expect(folder.selection?.reasoningEffort, 'high');
    });

    test('turn-end closes the running state and records failures', () {
      final folder = _fold([
        _event(1, 'turn-start', {'turn': 1}),
        _event(2, 'turn-end', {
          'turn': 1,
          'reason': {
            'kind': 'error',
            'failure': {'message': 'upstream exploded', 'code': 'x'},
          },
        }),
      ]);
      expect(folder.running, isFalse);
      final notice = folder.items.single as NoticeItem;
      expect(notice.kind, NoticeKind.error);
      expect(notice.text, 'upstream exploded');
    });

    test('skips injected user messages but keeps real ones', () {
      final folder = _fold([
        _event(1, 'user-message', {'text': 'context', 'injected': true}),
        _event(2, 'user-message', {'text': 'real', 'injected': false}),
      ]);
      expect(folder.items, hasLength(1));
      expect((folder.items.single as UserMessageItem).text, 'real');
    });
  });
}
