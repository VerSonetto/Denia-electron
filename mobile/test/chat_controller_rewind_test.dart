import 'package:denia_mobile/data/api_client.dart';
import 'package:denia_mobile/data/sse.dart';
import 'package:denia_mobile/models/session.dart';
import 'package:denia_mobile/state/chat_controller.dart';
import 'package:flutter_test/flutter_test.dart';

class _RewindApi extends DeniaApi {
  _RewindApi() : super(baseUrl: 'http://127.0.0.1:1');

  int? rewoundTo;

  @override
  Future<SessionPage> fetchSessionPage(
    String sessionId, {
    int? before,
    int limit = 300,
  }) async {
    return SessionPage(
      header: SessionHeader(
        id: sessionId,
        cwd: 'D:/work',
        createdAt: DateTime(2026, 1, 1),
      ),
      events: const [],
      total: 0,
      hasMoreBefore: false,
      anchors: const [],
    );
  }

  @override
  Future<RewindResult> rewindSession(String sessionId, int toSeq) async {
    rewoundTo = toSeq;
    return const RewindResult(
      toSeq: 7,
      toMessage: '重新发送这条消息',
      removedEvents: 4,
      changedFiles: ['lib/main.dart'],
    );
  }

  @override
  Stream<SseFrame> stream(String path, {void Function()? onOpen}) {
    return const Stream<SseFrame>.empty();
  }
}

void main() {
  test('rewind refreshes the branch and returns the restored prompt', () async {
    final api = _RewindApi();
    final controller = ChatController(
      sessionId: 'session-1',
      summary: SessionSummary(
        id: 'session-1',
        createdAt: DateTime(2026, 1, 1),
        cwd: 'D:/work',
      ),
      apiProvider: () => api,
      onAuthLost: () {},
    );
    addTearDown(controller.dispose);

    final outcome = await controller.rewindTo(7);

    expect(outcome.error, isNull);
    expect(outcome.result?.toMessage, '重新发送这条消息');
    expect(outcome.result?.changedFiles, ['lib/main.dart']);
    expect(api.rewoundTo, 7);
    expect(controller.loaded, isTrue);
    expect(controller.items, isEmpty);
    expect(controller.error, isNull);
  });
}
