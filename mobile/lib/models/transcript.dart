import '../core/json.dart';
import 'session.dart';

enum AssistantBlockKind { text, reasoning, toolCall }

class AssistantBlock {
  AssistantBlock({
    required this.kind,
    this.text = '',
    this.callId,
    this.toolName,
    this.args = '',
  });

  AssistantBlockKind kind;
  String text;
  String? callId;
  String? toolName;
  String args;

  static AssistantBlock fromJson(Object? value) {
    final map = asMap(value);
    switch (asString(map['type'])) {
      case 'text':
        return AssistantBlock(
          kind: AssistantBlockKind.text,
          text: asString(map['text']),
        );
      case 'reasoning':
        return AssistantBlock(
          kind: AssistantBlockKind.reasoning,
          text: asString(map['text']),
        );
      case 'tool-call':
        return AssistantBlock(
          kind: AssistantBlockKind.toolCall,
          callId: asStringOrNull(map['id']),
          toolName: asStringOrNull(map['name']),
          args: asString(map['arguments']),
        );
      default:
        // Unknown future block types still get their readable text instead of
        // collapsing the whole message.
        return AssistantBlock(
          kind: AssistantBlockKind.text,
          text: asString(map['text'], asString(map['arguments'])),
        );
    }
  }
}

class TokenUsage {
  const TokenUsage({
    required this.inputTokens,
    required this.outputTokens,
    this.cacheReadTokens = 0,
    this.reasoningTokens = 0,
  });

  final int inputTokens;
  final int outputTokens;
  final int cacheReadTokens;
  final int reasoningTokens;

  static TokenUsage? fromJson(Object? value) {
    final map = asMap(value);
    if (map.isEmpty) return null;
    return TokenUsage(
      inputTokens: asInt(map['inputTokens']),
      outputTokens: asInt(map['outputTokens']),
      cacheReadTokens: asInt(map['cacheReadTokens']),
      reasoningTokens: asInt(map['reasoningTokens']),
    );
  }
}

abstract class TranscriptItem {
  TranscriptItem({required this.seq});

  int seq;
}

class UserMessageItem extends TranscriptItem {
  UserMessageItem({
    required super.seq,
    required this.text,
    this.images = const [],
  });

  final String text;
  final List<ImageAttachment> images;
}

class AssistantItem extends TranscriptItem {
  AssistantItem({
    required super.seq,
    required this.turn,
    required this.step,
    List<AssistantBlock>? blocks,
    this.streaming = true,
  }) : blocks = blocks ?? [];

  final int turn;
  final int step;
  List<AssistantBlock> blocks;
  bool streaming;
  bool interrupted = false;
  TokenUsage? usage;

  bool get hasVisibleContent {
    if (interrupted) return true;
    return blocks.any(
      (block) =>
          block.kind != AssistantBlockKind.toolCall &&
          block.text.trim().isNotEmpty,
    );
  }

  String get reasoningText => blocks
      .where((block) => block.kind == AssistantBlockKind.reasoning)
      .map((block) => block.text)
      .join('\n')
      .trim();

  List<AssistantBlock> get readableBlocks => blocks
      .where(
        (block) =>
            block.kind != AssistantBlockKind.toolCall &&
            block.text.trim().isNotEmpty,
      )
      .toList(growable: false);
}

class ToolResultView {
  const ToolResultView({required this.content, required this.isError});

  final String content;
  final bool isError;

  static ToolResultView fromEvent(JsonMap event) {
    return ToolResultView(
      content: asString(event['content']),
      isError: asBool(event['is_error']),
    );
  }
}

class ToolItem extends TranscriptItem {
  ToolItem({
    required super.seq,
    required this.callId,
    required this.name,
    required this.args,
  });

  final String callId;
  final String name;
  String args;
  ToolResultView? result;
  String liveOutput = '';

  bool get isRunning => result == null;
  bool get hasExpandableBody =>
      args.trim().isNotEmpty || result != null || liveOutput.isNotEmpty;
}

enum NoticeKind { info, warning, error, compaction, command }

class NoticeItem extends TranscriptItem {
  NoticeItem({
    required super.seq,
    required this.kind,
    required this.title,
    this.text = '',
    this.turn,
  });

  final NoticeKind kind;
  final String title;
  final String text;
  final int? turn;
}

class PendingApproval {
  const PendingApproval({
    required this.requestId,
    required this.callId,
    required this.tool,
    required this.argsPreview,
    this.reason,
  });

  final String requestId;
  final String callId;
  final String tool;
  final String argsPreview;
  final String? reason;
}

/// Converts the host's append-only event stream into render items.
///
/// The host emits `assistant-chunk` frames only live, while
/// `assistant-message` is the persisted authority. Chunks accumulate into an
/// open item; the message replaces it. Tool calls arrive as their own events,
/// because the dashboard hides tool-call blocks inside assistant messages.
class TranscriptFolder {
  final List<TranscriptItem> items = [];

  final Map<String, AssistantItem> _openAssistants = {};
  final Map<String, ToolItem> _tools = {};

  PendingApproval? pendingApproval;
  PermissionChoice? permission;
  ModelChoice? selection;
  bool running = false;
  String? title;

  int _lastSeq = 0;
  int get lastSeq => _lastSeq;

  void reset() {
    items.clear();
    _openAssistants.clear();
    _tools.clear();
    pendingApproval = null;
    permission = null;
    selection = null;
    running = false;
    title = null;
    _lastSeq = 0;
  }

  void apply(SessionEnvelope event) {
    if (event.seq > _lastSeq) _lastSeq = event.seq;
    final data = event.data;
    switch (event.type) {
      case 'user-message':
        _closeStreaming();
        if (asBool(data['injected'])) return;
        final images = <ImageAttachment>[];
        final rawImages = data['images'];
        if (rawImages is List) {
          for (final rawImage in rawImages) {
            final image = ImageAttachment.fromJson(rawImage);
            if (image != null) images.add(image);
          }
        }
        items.add(
          UserMessageItem(
            seq: event.seq,
            text: asString(data['text']),
            images: images,
          ),
        );
        return;
      case 'assistant-chunk':
        final turn = asInt(data['turn']);
        final step = asInt(data['step']);
        final item = _openAssistant(turn, step, event.seq);
        _applyChunk(item, asMap(data['chunk']));
        return;
      case 'assistant-message':
        _closeStreaming(
          exceptTurn: asInt(data['turn']),
          exceptStep: asInt(data['step']),
        );
        final turn = asInt(data['turn']);
        final step = asInt(data['step']);
        final key = '$turn:$step';
        final item =
            _openAssistants.remove(key) ??
            AssistantItem(
              seq: event.seq,
              turn: turn,
              step: step,
              streaming: false,
            );
        item.blocks = asMapList(data['blocks'])
            .map(AssistantBlock.fromJson)
            .toList(growable: true);
        item.streaming = false;
        item.interrupted = asBool(data['interrupted']);
        item.usage = TokenUsage.fromJson(data['usage']);
        item.seq = event.seq;
        if (!items.contains(item)) items.add(item);
        return;
      case 'tool-call':
        final callId = asStringOrNull(data['call_id']);
        if (callId == null) return;
        final existing = _tools[callId];
        if (existing == null) {
          final item = ToolItem(
            seq: event.seq,
            callId: callId,
            name: asString(data['name'], 'tool'),
            args: asString(data['arguments']),
          );
          _tools[callId] = item;
          items.add(item);
        } else {
          existing.args = asString(data['arguments'], existing.args);
          existing.seq = event.seq;
        }
        return;
      case 'tool-result':
        if (data['replaces'] != null) return;
        final callId = asStringOrNull(data['call_id']);
        if (callId == null) return;
        final item =
            _tools[callId] ??
            _addOrphanTool(
              callId: callId,
              seq: event.seq,
              name: asString(data['name'], 'tool'),
            );
        item.result = ToolResultView.fromEvent(data);
        item.liveOutput = '';
        item.seq = event.seq;
        return;
      case 'tool-output-chunk':
        final callId = asStringOrNull(data['call_id']);
        if (callId == null) return;
        final item = _tools[callId];
        if (item == null || item.result != null) return;
        final text = asString(data['text']);
        if (text.isEmpty) return;
        final combined = '${item.liveOutput}$text';
        item.liveOutput = combined.length <= 16000
            ? combined
            : combined.substring(combined.length - 16000);
        item.seq = event.seq;
        return;
      case 'approval-asked':
        pendingApproval = PendingApproval(
          requestId: asString(data['request_id']),
          callId: asString(data['call_id']),
          tool: asString(data['tool'], 'tool'),
          argsPreview: asString(data['args_preview']),
          reason: asStringOrNull(data['reason']),
        );
        return;
      case 'approval-decided':
        if (pendingApproval?.requestId == asString(data['request_id'])) {
          pendingApproval = null;
        }
        return;
      case 'permission-selection':
        permission = _permissionFromSelection(data) ?? permission;
        return;
      case 'permission-mode':
        permission =
            PermissionChoice.parse(asStringOrNull(data['mode'])) ?? permission;
        return;
      case 'request-header':
        final config = asMap(asMap(data['header'])['config']);
        final provider = asStringOrNull(config['provider']);
        final model = asStringOrNull(config['model']);
        if (provider != null && model != null) {
          selection = ModelChoice(
            provider: provider,
            model: model,
            reasoningEffort: asStringOrNull(config['reasoningEffort']),
          );
        }
        return;
      case 'request-context':
        if (selection != null) return;
        final provider = asStringOrNull(data['provider']);
        final model = asStringOrNull(data['model']);
        if (provider != null && model != null) {
          selection = ModelChoice(provider: provider, model: model);
        }
        return;
      case 'turn-start':
        running = true;
        return;
      case 'turn-end':
        running = false;
        _closeStreaming();
        final notice = _turnEndNotice(data, event.seq);
        if (notice != null) items.add(notice);
        return;
      case 'session-title':
        title = asStringOrNull(data['title']);
        return;
      case 'compaction-summary':
        _closeStreaming();
        items.add(
          NoticeItem(
            seq: event.seq,
            kind: NoticeKind.compaction,
            title: '上下文已压缩',
            text: asString(data['summary']),
            turn: asIntOrNull(data['turn']),
          ),
        );
        return;
      case 'command-run':
        _closeStreaming();
        items.add(
          NoticeItem(
            seq: event.seq,
            kind: NoticeKind.command,
            title: '/${asString(data['name'])}',
            text: asString(data['text']),
          ),
        );
        return;
      default:
        return;
    }
  }

  void _applyChunk(AssistantItem item, JsonMap chunk) {
    final type = asString(chunk['type']);
    final rawIndex = asIntOrNull(chunk['index']);
    switch (type) {
      case 'block-start':
        if (rawIndex == null) return;
        final index = _slot(rawIndex, item.blocks.length);
        if (index < 0) return;
        if (index < item.blocks.length) return;
        item.blocks.add(
          AssistantBlock(kind: _blockKind(asString(chunk['block_type']))),
        );
        return;
      case 'text-delta':
        _appendText(
          item,
          rawIndex,
          asString(chunk['text']),
          AssistantBlockKind.text,
        );
        return;
      case 'reasoning-delta':
        _appendText(
          item,
          rawIndex,
          asString(chunk['text']),
          AssistantBlockKind.reasoning,
        );
        return;
      case 'tool-call-delta':
        if (rawIndex == null) return;
        final index = _slot(rawIndex, item.blocks.length);
        if (index < 0) return;
        if (index == item.blocks.length) {
          item.blocks.add(AssistantBlock(kind: AssistantBlockKind.toolCall));
        }
        final block = item.blocks[index];
        block.args += asString(chunk['arguments_delta']);
        if (asStringOrNull(chunk['id']) != null) {
          block.callId = asString(chunk['id']);
        }
        if (asStringOrNull(chunk['name']) != null) {
          block.toolName = asString(chunk['name']);
        }
        return;
      case 'block-end':
        if (rawIndex == null) return;
        final index = _slot(rawIndex, item.blocks.length);
        if (index < 0 || index >= item.blocks.length) return;
        final settled = AssistantBlock.fromJson(chunk['block']);
        final prior = item.blocks[index];
        if (settled.kind == AssistantBlockKind.text && settled.text.isEmpty) {
          settled.text = prior.text;
        }
        item.blocks[index] = settled;
        return;
      case 'usage':
        item.usage = TokenUsage.fromJson(chunk['usage']) ?? item.usage;
        return;
      default:
        return;
    }
  }

  void _appendText(
    AssistantItem item,
    int? rawIndex,
    String text,
    AssistantBlockKind kind,
  ) {
    if (text.isEmpty || rawIndex == null) return;
    final index = _slot(rawIndex, item.blocks.length);
    if (index < 0) return;
    if (index == item.blocks.length) {
      item.blocks.add(AssistantBlock(kind: kind));
    }
    final block = item.blocks[index];
    if (block.kind == AssistantBlockKind.text &&
        kind == AssistantBlockKind.reasoning) {
      block.kind = AssistantBlockKind.reasoning;
    } else if (block.kind == AssistantBlockKind.toolCall) {
      // A provider sent a text delta into a tool-call slot. Appending to the
      // args would corrupt them; append to a fresh text block instead.
      item.blocks.insert(index, AssistantBlock(kind: kind, text: text));
      return;
    }
    block.text += text;
  }

  AssistantItem _openAssistant(int turn, int step, int seq) {
    final key = '$turn:$step';
    final existing = _openAssistants[key];
    if (existing != null) {
      existing.seq = seq;
      existing.streaming = true;
      return existing;
    }
    final item = AssistantItem(seq: seq, turn: turn, step: step);
    _openAssistants[key] = item;
    items.add(item);
    return item;
  }

  ToolItem _addOrphanTool({
    required String callId,
    required int seq,
    required String name,
  }) {
    final item = ToolItem(seq: seq, callId: callId, name: name, args: '');
    _tools[callId] = item;
    items.add(item);
    return item;
  }

  void _closeStreaming({int? exceptTurn, int? exceptStep}) {
    for (final item in _openAssistants.values) {
      if (exceptTurn != null &&
          item.turn == exceptTurn &&
          item.step == exceptStep) {
        continue;
      }
      item.streaming = false;
    }
    if (exceptTurn == null) _openAssistants.clear();
  }

  NoticeItem? _turnEndNotice(JsonMap data, int seq) {
    final reason = asMap(data['reason']);
    final kind = asString(reason['kind']);
    final turn = asIntOrNull(data['turn']);
    switch (kind) {
      case 'completed':
        return null;
      case 'error':
        final failure = asMap(reason['failure']);
        return NoticeItem(
          seq: seq,
          kind: NoticeKind.error,
          title: '本轮失败',
          text: asString(failure['message'], '模型请求失败'),
          turn: turn,
        );
      case 'aborted':
        final cause = asMap(reason['cause']);
        final causeKind = asString(cause['kind']);
        final text = switch (causeKind) {
          'user' => '已停止本轮',
          'parent' => '上层任务已中止',
          'hook' => asString(cause['reason'], '被钩子中止'),
          _ => '本轮已中止',
        };
        return NoticeItem(
          seq: seq,
          kind: NoticeKind.warning,
          title: text,
          turn: turn,
        );
      case 'max-tokens':
        return NoticeItem(
          seq: seq,
          kind: NoticeKind.warning,
          title: '输出达到上限',
          turn: turn,
        );
      case 'loop-detected':
        return NoticeItem(
          seq: seq,
          kind: NoticeKind.warning,
          title: '检测到重复循环，已停止',
          turn: turn,
        );
      case 'interrupted':
        return NoticeItem(
          seq: seq,
          kind: NoticeKind.warning,
          title: '本轮已中断',
          turn: turn,
        );
      default:
        return null;
    }
  }

  static int _slot(int raw, int length) {
    if (raw < 0) return -1;
    return raw > length ? length : raw;
  }

  static AssistantBlockKind _blockKind(String raw) {
    if (raw == 'reasoning') return AssistantBlockKind.reasoning;
    if (raw == 'tool-call') return AssistantBlockKind.toolCall;
    return AssistantBlockKind.text;
  }

  static PermissionChoice? _permissionFromSelection(JsonMap data) {
    if (asString(data['reviewer']) == 'auto-review') {
      return PermissionChoice.approveForMe;
    }
    if (asString(data['collaboration']) == 'plan') return PermissionChoice.plan;
    if (asString(data['sandbox']) == 'read-only') {
      return PermissionChoice.readOnly;
    }
    if (asString(data['sandbox']) == 'danger-full-access') {
      return PermissionChoice.full;
    }
    return PermissionChoice.autoEdit;
  }
}
