import 'dart:async';

import 'package:flutter/services.dart';
import 'package:material_ui/material_ui.dart';

import '../core/errors.dart';
import '../models/session.dart';
import '../models/transcript.dart';
import '../state/app_controller.dart';
import '../state/chat_controller.dart';
import '../theme.dart';
import 'widgets/approval_card.dart';
import 'widgets/composer.dart';
import 'widgets/model_picker.dart';
import 'widgets/chat_empty_state.dart';
import 'widgets/chat_header_bar.dart';
import 'widgets/tool_card.dart';
import 'widgets/tool_group.dart';
import 'widgets/turn_process.dart';
import 'widgets/transcript_items.dart';

class ChatScreen extends StatefulWidget {
  const ChatScreen({super.key, required this.app, required this.summary});

  final AppController app;
  final SessionSummary summary;

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> with WidgetsBindingObserver {
  late final ChatController _chat;
  final TextEditingController _input = TextEditingController();
  final FocusNode _focus = FocusNode();
  final ScrollController _scroll = ScrollController();
  Timer? _graceTimer;
  bool _graceElapsed = false;
  bool _approvalBusy = false;
  bool _creatingSession = false;
  bool _rewindBusy = false;
  int? _rewindMessageSeq;
  bool _atBottom = true;
  bool _followScheduled = false;
  AppPhase? _lastPhase;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _lastPhase = widget.app.phase;
    widget.app.addListener(_onAppChanged);
    _chat = ChatController(
      sessionId: widget.summary.id,
      summary: widget.summary,
      apiProvider: () => widget.app.api,
      onAuthLost: _onAuthLost,
      catalogProvider: () => widget.app.catalog,
      initiallyRunning: widget.app.isRunning(widget.summary.id),
    );
    _chat.load();
    _chat.addListener(_onChatFollow);
    _scroll.addListener(_handleScroll);
    _graceTimer = Timer(const Duration(seconds: 2), () {
      if (mounted) setState(() => _graceElapsed = true);
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    widget.app.removeListener(_onAppChanged);
    _graceTimer?.cancel();
    _chat.removeListener(_onChatFollow);
    _chat.dispose();
    _scroll.removeListener(_handleScroll);
    _input.dispose();
    _focus.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _handleScroll() {
    if (!_scroll.hasClients) return;
    final position = _scroll.position;
    final atBottom = position.maxScrollExtent - position.pixels <= 24;
    if (atBottom == _atBottom) return;
    setState(() => _atBottom = atBottom);
  }

  /// Non-reverse lists start at the top; when the reader is at the bottom we
  /// follow the stream after each layout, so a short conversation stays top
  /// aligned and a long one still follows new output.
  void _onChatFollow() {
    if (!_atBottom || _followScheduled) return;
    _followScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _followScheduled = false;
      if (!mounted || !_atBottom || !_scroll.hasClients) return;
      final max = _scroll.position.maxScrollExtent;
      if ((max - _scroll.offset).abs() > 1) _scroll.jumpTo(max);
    });
  }

  void _scrollToLatest() {
    if (!_scroll.hasClients) return;
    _atBottom = true;
    _scroll.animateTo(
      _scroll.position.maxScrollExtent,
      duration: const Duration(milliseconds: 240),
      curve: Curves.easeOutCubic,
    );
  }

  void _loadOlder() {
    // The reader explicitly moved to the top; do not follow the new content
    // back to the bottom.
    _atBottom = false;
    _chat.loadOlder();
  }

  Future<void> _confirmRewind(UserMessageItem message) async {
    if (_rewindBusy) return;
    setState(() {
      _rewindBusy = true;
      _rewindMessageSeq = null;
    });
    HapticFeedback.selectionClick();
    try {
      final changes = await widget.app.api.checkpointDiff(
        widget.summary.id,
        message.seq,
      );
      if (!mounted) return;
      final confirmed = await showModalBottomSheet<bool>(
        context: context,
        showDragHandle: true,
        isScrollControlled: true,
        builder: (context) => _RewindSheet(
          message: message.text,
          changes: changes,
          running: _chat.running,
        ),
      );
      if (confirmed != true || !mounted) return;

      HapticFeedback.mediumImpact();
      final messenger = ScaffoldMessenger.of(context);
      messenger.showSnackBar(
        const SnackBar(
          duration: Duration(minutes: 1),
          content: Row(
            children: [
              SizedBox(
                width: 14,
                height: 14,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
              SizedBox(width: 10),
              Text('正在回退…'),
            ],
          ),
        ),
      );
      final outcome = await _chat.rewindTo(message.seq);
      messenger.hideCurrentSnackBar();
      if (!mounted) return;
      if (outcome.error != null) {
        messenger.showSnackBar(SnackBar(content: Text(outcome.error!)));
        return;
      }
      final result = outcome.result;
      if (result == null) return;
      final text = result.toMessage ?? message.text;
      _input.value = TextEditingValue(
        text: text,
        selection: TextSelection.collapsed(offset: text.length),
      );
      _atBottom = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _scrollToLatest();
      });
      final restored = result.changedFiles.length;
      messenger.showSnackBar(
        SnackBar(
          content: Text(
            restored == 0 ? '已回退，消息已放回输入框' : '已回退，恢复 $restored 个文件；消息已放回输入框',
          ),
        ),
      );
      unawaited(widget.app.refreshSessions());
    } on ApiException catch (error) {
      if (!mounted) return;
      if (error.isAuthFailure) {
        _onAuthLost();
      } else {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(error.message)));
      }
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(describeFailure(error))));
    } finally {
      if (mounted) setState(() => _rewindBusy = false);
    }
  }

  void _fillSuggestion(String text) {
    _input.value = TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: text.length),
    );
    _focus.requestFocus();
  }

  Future<void> _createNewSession() async {
    if (_creatingSession) return;
    setState(() => _creatingSession = true);
    final projectId = widget.summary.projectId ?? widget.app.defaultProject?.id;
    final session = await widget.app.createSession(projectId: projectId);
    if (!mounted) return;
    setState(() => _creatingSession = false);
    if (session == null) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(widget.app.lastError ?? '新建会话失败')));
      return;
    }
    await Navigator.of(context).pushReplacement(
      MaterialPageRoute<void>(
        builder: (_) => ChatScreen(app: widget.app, summary: session),
      ),
    );
  }

  void _onAppChanged() {
    if (!mounted) return;
    final phase = widget.app.phase;
    if (phase == _lastPhase) return;
    _lastPhase = phase;
    if (phase == AppPhase.authLost) {
      Navigator.of(context).popUntil((route) => route.isFirst);
      return;
    }
    setState(() {});
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.hidden) {
      _chat.pause();
    } else if (state == AppLifecycleState.resumed) {
      _chat.resume();
    }
  }

  void _onAuthLost() {
    widget.app.markAuthLost();
    if (!mounted) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      Navigator.of(context).popUntil((route) => route.isFirst);
    });
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _chat,
      builder: (context, _) {
        final connected = widget.app.online && _chat.loaded;
        final linked = widget.app.online && _chat.connected;
        final hasContent =
            _chat.items.isNotEmpty ||
            (widget.summary.excerpt?.trim().isNotEmpty ?? false) ||
            (widget.summary.title?.trim().isNotEmpty ?? false) ||
            widget.summary.lastSelection != null;
        final systemUi = context.deniaSystemUi.copyWith(
          systemNavigationBarColor: context.deniaBg,
        );
        return AnnotatedRegion<SystemUiOverlayStyle>(
          value: systemUi,
          child: Scaffold(
            backgroundColor: context.deniaBg,
            body: SafeArea(
              bottom: false,
              child: Column(
                children: [
                  ChatHeaderBar(
                    title: _chat.title,
                    status: _headerStatus(linked),
                    running: _chat.running,
                    connected: linked,
                    hasContent: hasContent,
                    creating: _creatingSession,
                    modelLabel: _modelLabel() ?? '选择模型',
                    onBack: () => Navigator.of(context).maybePop(),
                    onNewSession: _createNewSession,
                    onModelTap: _pickModel,
                  ),
                  if (_chat.error != null && _chat.items.isNotEmpty)
                    _ChatBanner(
                      text: _chat.error!,
                      actionLabel: '重试',
                      onAction: _chat.retry,
                      onClose: _chat.clearError,
                      danger: true,
                    )
                  else if (_graceElapsed && _chat.loaded && !_chat.connected)
                    _ChatBanner(
                      text: '实时连接中断，正在自动重连…',
                      actionLabel: '立即重试',
                      onAction: _reconnect,
                    ),
                  Expanded(
                    child: Stack(
                      children: [
                        Positioned.fill(child: _buildTranscript(context)),
                        Positioned(
                          left: 0,
                          right: 0,
                          bottom: 0,
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              if (_chat.pendingApproval != null)
                                ApprovalCard(
                                  approval: _chat.pendingApproval!,
                                  busy: _approvalBusy,
                                  onDecide: _decideApproval,
                                ),
                              Composer(
                                controller: _input,
                                focusNode: _focus,
                                running: _chat.running,
                                sending: _chat.sending,
                                cancelling: _chat.cancelling,
                                connected: connected,
                                modelLabel: _modelLabel(),
                                onSend: _send,
                                onStop: _stop,
                                onAddTap: _composerActions,
                                onModelTap: _pickModel,
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }

  String _headerStatus(bool linked) {
    return [
      if (_chat.location.isNotEmpty && _chat.location != 'default')
        _chat.location,
      if (_chat.running)
        '运行中'
      else if (linked)
        widget.app.usingRelay ? '私有中继' : '已连接'
      else if (!_chat.loaded)
        '连接中'
      else
        '重连中',
      _chat.permission.label,
    ].join(' · ');
  }

  double _composerDockInset(BuildContext context) {
    final safeBottom = MediaQuery.viewPaddingOf(context).bottom;
    return (_chat.pendingApproval == null ? 148.0 : 368.0) + safeBottom;
  }

  Widget _buildTranscript(BuildContext context) {
    final items = _chat.items;
    if (_chat.loading && items.isEmpty) {
      return const Center(
        child: SizedBox(
          width: 22,
          height: 22,
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
      );
    }
    if (items.isEmpty) {
      if (_chat.error != null) {
        return _CenteredError(message: _chat.error!, onRetry: _chat.retry);
      }
      return ChatEmptyState(onSuggestion: _fillSuggestion);
    }
    final rows = _displayRows(items);
    return Stack(
      children: [
        ListView.builder(
          controller: _scroll,
          reverse: false,
          scrollCacheExtent: const ScrollCacheExtent.pixels(800),
          padding: EdgeInsets.fromLTRB(
            16,
            14,
            16,
            _composerDockInset(context) + 18,
          ),
          keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
          itemCount: rows.length + (_chat.hasMoreBefore ? 1 : 0),
          itemBuilder: (context, index) {
            final leading = _chat.hasMoreBefore ? 1 : 0;
            if (index == 0 && leading == 1) {
              return _LoadOlderButton(
                loading: _chat.loading,
                onPressed: _loadOlder,
              );
            }
            final row = rows[index - leading];
            return KeyedSubtree(
              key: ValueKey(row.key),
              child: RepaintBoundary(child: _rowWidget(row)),
            );
          },
        ),
        Positioned(
          right: 14,
          bottom: _composerDockInset(context) + 6,
          child: AnimatedOpacity(
            opacity: _atBottom ? 0 : 1,
            duration: const Duration(milliseconds: 160),
            child: IgnorePointer(
              ignoring: _atBottom,
              child: _ScrollLatestButton(onTap: _scrollToLatest),
            ),
          ),
        ),
      ],
    );
  }

  List<_DisplayRow> _displayRows(List<TranscriptItem> items) {
    final rows = <_DisplayRow>[];
    var index = 0;
    while (index < items.length) {
      final item = items[index];
      if (item is UserMessageItem) {
        rows.add(_ItemDisplayRow(item));
        index += 1;
        var end = index;
        while (end < items.length && items[end] is! UserMessageItem) {
          end += 1;
        }
        rows.addAll(
          _segmentRows(items.sublist(index, end), isLast: end == items.length),
        );
        index = end;
        continue;
      }
      var end = index;
      while (end < items.length && items[end] is! UserMessageItem) {
        end += 1;
      }
      rows.addAll(
        _segmentRows(items.sublist(index, end), isLast: end == items.length),
      );
      index = end;
    }
    return rows;
  }

  List<_DisplayRow> _segmentRows(
    List<TranscriptItem> segment, {
    required bool isLast,
  }) {
    if (segment.isEmpty) return const [];
    final active =
        segment.any(
          (item) =>
              (item is AssistantItem && item.streaming) ||
              (item is ToolItem && item.isRunning),
        ) ||
        (isLast && _chat.running);
    final problem = segment.any(
      (item) =>
          (item is AssistantItem && item.interrupted) ||
          (item is NoticeItem &&
              (item.kind == NoticeKind.error ||
                  item.kind == NoticeKind.warning)),
    );
    if (active || problem) return _contentRows(segment);

    AssistantItem? answer;
    for (final item in segment) {
      if (item is AssistantItem && _assistantHasText(item)) answer = item;
    }
    if (answer == null || !identical(segment.last, answer)) {
      return _contentRows(segment);
    }
    final answerIndex = segment.indexOf(answer);
    final process = segment.sublist(0, answerIndex);
    final tools = process.whereType<ToolItem>().length;
    final messages = process
        .whereType<AssistantItem>()
        .where(_assistantHasText)
        .length;
    if (process.isEmpty || (tools == 0 && messages < 2)) {
      return _contentRows(segment);
    }
    final label = [
      '已完成',
      if (tools > 0) '$tools 个工具调用',
      if (messages > 0) '$messages 条消息',
    ].join(' · ');
    return [
      _TurnProcessDisplayRow(
        processKey: 'tp:${answer.turn}:${segment.first.seq}',
        label: label,
        rows: _contentRows(process),
      ),
      _ItemDisplayRow(answer),
    ];
  }

  List<_DisplayRow> _contentRows(List<TranscriptItem> items) {
    final rows = <_DisplayRow>[];
    var index = 0;
    while (index < items.length) {
      final item = items[index];
      if (item is ToolItem) {
        var end = index + 1;
        while (end < items.length && items[end] is ToolItem) {
          end += 1;
        }
        final run = items.sublist(index, end).cast<ToolItem>();
        if (run.length >= 3) {
          rows.add(_ToolGroupDisplayRow(run));
        } else {
          for (final tool in run) {
            rows.add(_ItemDisplayRow(tool));
          }
        }
        index = end;
        continue;
      }
      rows.add(_ItemDisplayRow(item));
      index += 1;
    }
    return rows;
  }

  bool _assistantHasText(AssistantItem item) {
    return item.blocks.any(
      (block) =>
          block.kind == AssistantBlockKind.text && block.text.trim().isNotEmpty,
    );
  }

  Widget _rowWidget(_DisplayRow row) {
    if (row is _ToolGroupDisplayRow) {
      return ToolGroupView(tools: row.tools);
    }
    if (row is _TurnProcessDisplayRow) {
      return TurnProcessView(
        label: row.label,
        children: [for (final child in row.rows) _rowWidget(child)],
      );
    }
    final item = (row as _ItemDisplayRow).item;
    if (item is UserMessageItem) {
      return UserMessageView(
        item: item,
        showRewind: !_rewindBusy && _rewindMessageSeq == item.seq,
        onTap: _rewindBusy
            ? null
            : () {
                setState(() {
                  _rewindMessageSeq = _rewindMessageSeq == item.seq
                      ? null
                      : item.seq;
                });
              },
        onRewind: _rewindBusy
            ? null
            : () {
                setState(() => _rewindMessageSeq = null);
                _confirmRewind(item);
              },
      );
    }
    if (item is AssistantItem) {
      if (!item.hasVisibleContent && !item.streaming) {
        return const SizedBox.shrink();
      }
      return AssistantMessageView(item: item);
    }
    if (item is ToolItem) return ToolCard(item: item);
    if (item is NoticeItem) return NoticeView(item: item);
    return const SizedBox.shrink();
  }

  String? _modelLabel() {
    final selection = _chat.selection;
    if (selection == null) return null;
    return widget.app.catalog?.labelOf(selection) ?? selection.model;
  }

  Future<void> _send() async {
    final text = _input.text.trim();
    if (text.isEmpty) return;
    HapticFeedback.lightImpact();
    _input.clear();
    _atBottom = true;
    _onChatFollow();
    final error = await _chat.send(text);
    if (!mounted) return;
    if (error != null) {
      if (_input.text.trim().isEmpty) _input.text = text;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(error)));
      return;
    }
    _focus.requestFocus();
  }

  Future<void> _stop() async {
    HapticFeedback.mediumImpact();
    final error = await _chat.cancelTurn();
    if (!mounted) return;
    if (error != null) {
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(error)));
    }
  }

  Future<void> _decideApproval(String decision) async {
    if (_approvalBusy) return;
    setState(() => _approvalBusy = true);
    final error = await _chat.answerApproval(decision);
    if (!mounted) return;
    setState(() => _approvalBusy = false);
    if (error != null) {
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(error)));
    }
  }

  Future<void> _reconnect() async {
    if (!widget.app.online) await widget.app.retryConnection();
    if (mounted) _chat.retry();
  }

  Future<void> _composerActions() async {
    final action = await showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      builder: (sheet) {
        return SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Padding(
                padding: EdgeInsets.fromLTRB(20, 0, 20, 6),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: Text(
                    '输入选项',
                    style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600),
                  ),
                ),
              ),
              ListTile(
                leading: const Icon(Icons.auto_awesome_outlined),
                title: const Text('模型'),
                subtitle: Text(_modelLabel() ?? '选择模型'),
                trailing: const Icon(Icons.chevron_right_rounded),
                onTap: () => Navigator.pop(sheet, 'model'),
              ),
              ListTile(
                leading: const Icon(Icons.shield_outlined),
                title: const Text('权限'),
                subtitle: Text(_chat.permission.label),
                trailing: const Icon(Icons.chevron_right_rounded),
                onTap: () => Navigator.pop(sheet, 'permission'),
              ),
              const SizedBox(height: 8),
            ],
          ),
        );
      },
    );
    if (!mounted) return;
    if (action == 'model') await _pickModel();
    if (action == 'permission') await _pickPermission();
  }

  Future<void> _pickModel() async {
    final catalog = widget.app.catalog;
    if (catalog == null || catalog.isEmpty) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('模型目录还没加载好，请稍后再试')));
      return;
    }
    final picked = await showModelPicker(
      context: context,
      catalog: catalog,
      current: _chat.selection,
    );
    if (picked == null || !mounted) return;
    _chat.selectModel(picked);
  }

  Future<void> _pickPermission() async {
    final selected = await showModalBottomSheet<PermissionChoice>(
      context: context,
      showDragHandle: true,
      builder: (context) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(20, 0, 20, 8),
              child: Text(
                '权限档位',
                style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600),
              ),
            ),
            for (final choice in PermissionChoice.values)
              ListTile(
                leading: Icon(
                  switch (choice) {
                    PermissionChoice.readOnly => Icons.visibility_outlined,
                    PermissionChoice.autoEdit => Icons.edit_outlined,
                    PermissionChoice.plan => Icons.map_outlined,
                    PermissionChoice.approveForMe =>
                      Icons.verified_user_outlined,
                    PermissionChoice.full => Icons.gpp_maybe_outlined,
                  },
                  color: choice == PermissionChoice.full
                      ? context.deniaDanger
                      : null,
                ),
                title: Text(
                  choice.label,
                  style: TextStyle(
                    color: choice == PermissionChoice.full
                        ? context.deniaDanger
                        : null,
                  ),
                ),
                subtitle: Text(
                  choice.description,
                  style: const TextStyle(fontSize: 11.5, height: 1.4),
                ),
                trailing: _chat.permission == choice
                    ? const Icon(Icons.check, size: 18)
                    : null,
                onTap: () => Navigator.pop(context, choice),
              ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 6, 20, 14),
              child: Text(
                '档位会在电脑端立即生效；完全访问会跳过所有工具审批。',
                style: TextStyle(
                  fontSize: 11,
                  height: 1.5,
                  color: context.deniaMuted,
                ),
              ),
            ),
          ],
        ),
      ),
    );
    if (selected == null || selected == _chat.permission) return;
    final error = await _chat.setPermission(selected);
    if (!mounted) return;
    if (error != null) {
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(error)));
    }
  }
}

class _RewindSheet extends StatelessWidget {
  const _RewindSheet({
    required this.message,
    required this.changes,
    required this.running,
  });

  final String message;
  final List<FileDiffEntry> changes;
  final bool running;

  @override
  Widget build(BuildContext context) {
    final preview = message.trim();
    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.sizeOf(context).height * 0.78,
        ),
        child: ListView(
          shrinkWrap: true,
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
          children: [
            const Text(
              '回退到此消息？',
              style: TextStyle(
                fontSize: 18,
                fontWeight: FontWeight.w600,
                letterSpacing: -0.2,
              ),
            ),
            const SizedBox(height: 10),
            Container(
              padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
              decoration: BoxDecoration(
                color: context.deniaRaised,
                borderRadius: BorderRadius.circular(12),
              ),
              child: Text(
                preview.isEmpty ? '（图片消息）' : preview,
                maxLines: 3,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 12.5,
                  height: 1.5,
                  color: context.deniaMuted,
                ),
              ),
            ),
            const SizedBox(height: 14),
            Text(
              changes.isEmpty
                  ? '将删除这条消息及之后的对话，没有文件变化。此操作不可撤销。'
                  : '将删除这条消息及之后的对话，并恢复 ${changes.length} 个文件。此操作不可撤销。',
              style: TextStyle(
                fontSize: 12.5,
                height: 1.55,
                color: context.deniaMuted,
              ),
            ),
            if (running) ...[
              const SizedBox(height: 10),
              Container(
                padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
                decoration: BoxDecoration(
                  color: context.deniaWarning.withValues(alpha: 0.08),
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(
                    color: context.deniaWarning.withValues(alpha: 0.25),
                    width: 0.5,
                  ),
                ),
                child: Row(
                  children: [
                    Icon(
                      Icons.stop_circle_outlined,
                      size: 15,
                      color: context.deniaWarning,
                    ),
                    const SizedBox(width: 7),
                    Expanded(
                      child: Text(
                        '当前回复还在运行，回退前会先中断这一轮。',
                        style: TextStyle(
                          fontSize: 11.5,
                          height: 1.4,
                          color: context.deniaWarning,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ],
            if (changes.isNotEmpty) ...[
              const SizedBox(height: 16),
              Text(
                '文件变化',
                style: TextStyle(
                  fontSize: 10,
                  fontWeight: FontWeight.w600,
                  letterSpacing: 0.7,
                  color: context.deniaMuted,
                ),
              ),
              const SizedBox(height: 5),
              for (final change in changes.take(8))
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 3),
                  child: Row(
                    children: [
                      Icon(
                        change.restores
                            ? Icons.settings_backup_restore_rounded
                            : Icons.delete_outline_rounded,
                        size: 14,
                        color: change.restores
                            ? context.deniaMuted
                            : context.deniaDanger,
                      ),
                      const SizedBox(width: 7),
                      Expanded(
                        child: Text(
                          change.path,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: monoStyle(
                            context,
                            size: 11.5,
                            color: context.deniaMuted,
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Text(
                        change.restores ? '恢复' : '删除',
                        style: TextStyle(
                          fontSize: 10,
                          color: change.restores
                              ? context.deniaFaint
                              : context.deniaDanger,
                        ),
                      ),
                    ],
                  ),
                ),
              if (changes.length > 8)
                Padding(
                  padding: const EdgeInsets.only(top: 3),
                  child: Text(
                    '还有 ${changes.length - 8} 个文件…',
                    style: TextStyle(fontSize: 10.5, color: context.deniaFaint),
                  ),
                ),
            ],
            const SizedBox(height: 20),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: () => Navigator.of(context).pop(false),
                    child: const Text('取消'),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: FilledButton(
                    onPressed: () => Navigator.of(context).pop(true),
                    style: FilledButton.styleFrom(
                      backgroundColor: context.deniaDanger,
                      foregroundColor: context.isDark
                          ? Colors.black
                          : Colors.white,
                    ),
                    child: const Text('确认回退'),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _ChatBanner extends StatelessWidget {
  const _ChatBanner({
    required this.text,
    required this.actionLabel,
    required this.onAction,
    this.onClose,
    this.danger = false,
  });

  final String text;
  final String actionLabel;
  final VoidCallback onAction;
  final VoidCallback? onClose;
  final bool danger;

  @override
  Widget build(BuildContext context) {
    final color = danger ? context.deniaDanger : context.deniaMuted;
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 4, 12, 2),
      padding: const EdgeInsets.fromLTRB(11, 6, 4, 6),
      decoration: BoxDecoration(
        color: danger
            ? context.deniaDanger.withValues(alpha: 0.07)
            : context.deniaSurface,
        borderRadius: BorderRadius.circular(9),
        border: Border.all(
          color: danger
              ? context.deniaDanger.withValues(alpha: 0.25)
              : context.deniaBorder,
        ),
      ),
      child: Row(
        children: [
          Expanded(
            child: Text(
              text,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 11.5, height: 1.4, color: color),
            ),
          ),
          TextButton(
            onPressed: onAction,
            style: TextButton.styleFrom(
              minimumSize: const Size(0, 30),
              visualDensity: VisualDensity.compact,
            ),
            child: Text(actionLabel, style: const TextStyle(fontSize: 11.5)),
          ),
          if (onClose != null)
            IconButton(
              onPressed: onClose,
              visualDensity: VisualDensity.compact,
              icon: Icon(
                Icons.close_rounded,
                size: 15,
                color: context.deniaFaint,
              ),
            ),
        ],
      ),
    );
  }
}

sealed class _DisplayRow {
  const _DisplayRow();
  String get key;
}

class _ItemDisplayRow extends _DisplayRow {
  const _ItemDisplayRow(this.item);
  final TranscriptItem item;

  @override
  String get key {
    final value = item;
    if (value is UserMessageItem) return 'u:${value.seq}';
    if (value is AssistantItem) return 'a:${value.turn}:${value.step}';
    if (value is ToolItem) return 't:${value.callId}';
    if (value is NoticeItem) return 'n:${value.seq}';
    return 'i:${value.seq}';
  }
}

class _ToolGroupDisplayRow extends _DisplayRow {
  const _ToolGroupDisplayRow(this.tools);
  final List<ToolItem> tools;

  @override
  String get key => 'g:${tools.first.callId}';
}

class _TurnProcessDisplayRow extends _DisplayRow {
  const _TurnProcessDisplayRow({
    required this.processKey,
    required this.label,
    required this.rows,
  });

  final String processKey;
  final String label;
  final List<_DisplayRow> rows;

  @override
  String get key => processKey;
}

class _ScrollLatestButton extends StatelessWidget {
  const _ScrollLatestButton({required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: context.deniaSurface,
      shape: const CircleBorder(),
      clipBehavior: Clip.antiAlias,
      elevation: 2,
      shadowColor: Colors.black.withValues(alpha: 0.35),
      child: InkWell(
        onTap: onTap,
        child: Container(
          width: 36,
          height: 36,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            border: Border.all(color: context.deniaBorder),
          ),
          child: Icon(
            Icons.arrow_downward_rounded,
            size: 17,
            color: context.deniaMuted,
          ),
        ),
      ),
    );
  }
}

class _LoadOlderButton extends StatelessWidget {
  const _LoadOlderButton({required this.loading, required this.onPressed});

  final bool loading;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Center(
        child: loading
            ? const SizedBox(
                width: 16,
                height: 16,
                child: CircularProgressIndicator(strokeWidth: 1.6),
              )
            : TextButton.icon(
                onPressed: onPressed,
                icon: const Icon(Icons.history_rounded, size: 16),
                label: const Text('加载更早的消息', style: TextStyle(fontSize: 12)),
              ),
      ),
    );
  }
}

class _CenteredError extends StatelessWidget {
  const _CenteredError({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.cloud_off_outlined, size: 34, color: context.deniaMuted),
            const SizedBox(height: 12),
            Text(
              message,
              textAlign: TextAlign.center,
              style: TextStyle(
                fontSize: 13,
                height: 1.5,
                color: context.deniaMuted,
              ),
            ),
            const SizedBox(height: 16),
            OutlinedButton(onPressed: onRetry, child: const Text('重试')),
          ],
        ),
      ),
    );
  }
}
