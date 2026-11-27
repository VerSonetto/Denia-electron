import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:material_ui/material_ui.dart';

import '../../models/session.dart';
import '../../models/transcript.dart';
import '../../theme.dart';
import 'markdown_view.dart';

class UserMessageView extends StatelessWidget {
  const UserMessageView({
    super.key,
    required this.item,
    this.showRewind = false,
    this.onTap,
    this.onRewind,
  });

  final UserMessageItem item;
  final bool showRewind;
  final VoidCallback? onTap;
  final VoidCallback? onRewind;

  @override
  Widget build(BuildContext context) {
    final maxWidth = MediaQuery.sizeOf(context).width * 0.82;
    return Padding(
      padding: EdgeInsets.only(bottom: showRewind ? 8 : 18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              _MessageTap(
                onTap: onTap,
                child: ConstrainedBox(
                  constraints: BoxConstraints(maxWidth: maxWidth),
                  child: Container(
                    padding: const EdgeInsets.fromLTRB(15, 10, 15, 10),
                    decoration: BoxDecoration(
                      color: context.deniaRaised,
                      borderRadius: const BorderRadius.only(
                        topLeft: Radius.circular(20),
                        topRight: Radius.circular(20),
                        bottomLeft: Radius.circular(20),
                        bottomRight: Radius.circular(6),
                      ),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        if (item.text.trim().isNotEmpty)
                          SelectionArea(
                            child: Text(
                              item.text,
                              style: const TextStyle(
                                fontSize: 15,
                                height: 1.55,
                              ),
                            ),
                          ),
                        if (item.images.isNotEmpty) ...[
                          if (item.text.trim().isNotEmpty)
                            const SizedBox(height: 8),
                          Wrap(
                            spacing: 6,
                            runSpacing: 6,
                            children: [
                              for (final image in item.images)
                                _UserImage(image: image),
                            ],
                          ),
                        ],
                      ],
                    ),
                  ),
                ),
              ),
            ],
          ),
          AnimatedSize(
            duration: const Duration(milliseconds: 160),
            curve: Curves.easeOut,
            alignment: Alignment.topRight,
            child: showRewind && onRewind != null
                ? Padding(
                    padding: const EdgeInsets.only(top: 1, right: 2),
                    child: Tooltip(
                      message: '回退到此消息',
                      child: Material(
                        color: Colors.transparent,
                        borderRadius: BorderRadius.circular(12),
                        child: InkWell(
                          borderRadius: BorderRadius.circular(12),
                          onTap: onRewind,
                          child: Padding(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 7,
                              vertical: 4,
                            ),
                            child: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Icon(
                                  Icons.undo_rounded,
                                  size: 12,
                                  color: context.deniaFaint,
                                ),
                                const SizedBox(width: 4),
                                Text(
                                  '回退',
                                  style: TextStyle(
                                    fontSize: 10.5,
                                    color: context.deniaFaint,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ),
                    ),
                  )
                : const SizedBox.shrink(),
          ),
        ],
      ),
    );
  }
}

/// Raw-pointer tap detection: a SelectionArea inside the bubble wins the
/// gesture arena for taps, so a normal GestureDetector never sees them. This
/// listener still gets the pointer stream and only fires for a short, still tap;
/// long-press and drag selection stay untouched.
class _MessageTap extends StatefulWidget {
  const _MessageTap({required this.child, this.onTap});

  final Widget child;
  final VoidCallback? onTap;

  @override
  State<_MessageTap> createState() => _MessageTapState();
}

class _MessageTapState extends State<_MessageTap> {
  Offset? _origin;
  DateTime? _downAt;
  bool _moved = false;

  void _down(PointerDownEvent event) {
    _origin = event.position;
    _downAt = DateTime.now();
    _moved = false;
  }

  void _move(PointerMoveEvent event) {
    final origin = _origin;
    if (origin != null && (event.position - origin).distance > 7) {
      _moved = true;
    }
  }

  void _up(PointerUpEvent event) {
    final downAt = _downAt;
    final isTap =
        !_moved &&
        downAt != null &&
        DateTime.now().difference(downAt) < Duration(milliseconds: 420);
    _origin = null;
    _downAt = null;
    _moved = false;
    if (isTap) widget.onTap?.call();
  }

  void _cancel(PointerCancelEvent event) {
    _origin = null;
    _downAt = null;
    _moved = false;
  }

  @override
  Widget build(BuildContext context) {
    return Listener(
      behavior: HitTestBehavior.translucent,
      onPointerDown: _down,
      onPointerMove: _move,
      onPointerUp: _up,
      onPointerCancel: _cancel,
      child: widget.child,
    );
  }
}

class _UserImage extends StatelessWidget {
  const _UserImage({required this.image});

  final ImageAttachment image;

  @override
  Widget build(BuildContext context) {
    Uint8List? bytes;
    try {
      bytes = base64Decode(image.data);
    } catch (_) {
      bytes = null;
    }
    if (bytes == null) {
      return Container(
        width: 120,
        height: 90,
        color: context.deniaSurface,
        alignment: Alignment.center,
        child: Icon(Icons.broken_image_outlined, color: context.deniaMuted),
      );
    }
    return ClipRRect(
      borderRadius: BorderRadius.circular(12),
      child: Image.memory(
        bytes,
        width: 160,
        height: 180,
        fit: BoxFit.cover,
        errorBuilder: (context, error, stack) => Container(
          width: 160,
          height: 120,
          color: context.deniaSurface,
          alignment: Alignment.center,
          child: Icon(Icons.broken_image_outlined, color: context.deniaMuted),
        ),
      ),
    );
  }
}

/// The assistant answer is deliberately frameless: the page is the canvas, and
/// the only chrome is the thinking pill and a quiet action row at the end.
/// This follows the reference chat UI's "reading first" hierarchy while keeping
/// Denia's monochrome palette.
class AssistantMessageView extends StatelessWidget {
  const AssistantMessageView({super.key, required this.item});

  final AssistantItem item;

  @override
  Widget build(BuildContext context) {
    final reasoning = item.reasoningText;
    final texts = item.blocks
        .where(
          (block) =>
              block.kind == AssistantBlockKind.text &&
              block.text.trim().isNotEmpty,
        )
        .toList(growable: false);
    final bodyText = texts.map((block) => block.text).join('\n\n').trim();
    final hasBody = reasoning.isNotEmpty || texts.isNotEmpty;
    return Padding(
      padding: const EdgeInsets.only(bottom: 22),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (reasoning.isNotEmpty)
            _ThinkingPill(
              text: reasoning,
              active: item.streaming && texts.isEmpty,
              streaming: item.streaming,
            ),
          if (texts.isNotEmpty)
            for (final block in texts)
              Padding(
                padding: const EdgeInsets.only(bottom: 2),
                child: MarkdownView(block.text, streaming: item.streaming),
              ),
          if (!hasBody && item.streaming)
            const Padding(
              padding: EdgeInsets.only(top: 2, bottom: 4),
              child: _WaitingReply(),
            ),
          if (item.interrupted)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    Icons.stop_circle_outlined,
                    size: 13,
                    color: context.deniaMuted,
                  ),
                  const SizedBox(width: 5),
                  Text(
                    '已中断',
                    style: TextStyle(fontSize: 11.5, color: context.deniaMuted),
                  ),
                ],
              ),
            ),
          if (item.streaming && hasBody)
            Padding(
              padding: const EdgeInsets.only(top: 5),
              child: BlinkingCaret(color: context.deniaMuted),
            ),
          if (!item.streaming && bodyText.isNotEmpty)
            _AssistantActions(text: bodyText, usage: item.usage),
        ],
      ),
    );
  }
}

class _WaitingReply extends StatelessWidget {
  const _WaitingReply();

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        const _LiveDot(),
        const SizedBox(width: 8),
        Text(
          'Denia 正在思考',
          style: TextStyle(fontSize: 12.5, color: context.deniaMuted),
        ),
        const SizedBox(width: 9),
        SizedBox(
          width: 12,
          height: 12,
          child: CircularProgressIndicator(
            strokeWidth: 1.5,
            color: context.deniaFaint,
          ),
        ),
      ],
    );
  }
}

class _AssistantActions extends StatelessWidget {
  const _AssistantActions({required this.text, required this.usage});

  final String text;
  final TokenUsage? usage;

  Future<void> _copy(BuildContext context) async {
    await Clipboard.setData(ClipboardData(text: text));
    if (!context.mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(const SnackBar(content: Text('回答已复制')));
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 2),
      child: Row(
        children: [
          TextButton.icon(
            onPressed: () => _copy(context),
            icon: const Icon(Icons.copy_rounded, size: 13),
            label: const Text('复制'),
            style: TextButton.styleFrom(
              foregroundColor: context.deniaMuted,
              minimumSize: const Size(0, 30),
              padding: const EdgeInsets.symmetric(horizontal: 6),
              visualDensity: VisualDensity.compact,
              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
              textStyle: const TextStyle(
                fontSize: 11.5,
                fontWeight: FontWeight.w500,
              ),
            ),
          ),
          const Spacer(),
          if (usage != null && usage!.outputTokens > 0)
            Text(
              '${compactTokens(usage!.outputTokens)} tokens',
              style: TextStyle(fontSize: 10.5, color: context.deniaFaint),
            ),
        ],
      ),
    );
  }
}

/// A compact thinking pill rather than a boxed panel: one line when closed,
/// the full reasoning quietly below when opened.
class _ThinkingPill extends StatefulWidget {
  const _ThinkingPill({
    required this.text,
    required this.active,
    required this.streaming,
  });

  final String text;
  final bool active;
  final bool streaming;

  @override
  State<_ThinkingPill> createState() => _ThinkingPillState();
}

class _ThinkingPillState extends State<_ThinkingPill> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final canOpen = widget.text.trim().isNotEmpty;
    final label = widget.active ? '正在思考' : '思考过程';
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Align(
            alignment: Alignment.centerLeft,
            child: Material(
              color: Colors.transparent,
              child: InkWell(
                borderRadius: BorderRadius.circular(16),
                onTap: canOpen
                    ? () => setState(() => _expanded = !_expanded)
                    : null,
                child: Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 10,
                    vertical: 6,
                  ),
                  decoration: BoxDecoration(
                    color: context.deniaSurface,
                    borderRadius: BorderRadius.circular(16),
                    border: Border.all(color: context.deniaBorder),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      if (widget.active)
                        SizedBox(
                          width: 12,
                          height: 12,
                          child: CircularProgressIndicator(
                            strokeWidth: 1.4,
                            color: context.deniaMuted,
                          ),
                        )
                      else
                        Icon(
                          Icons.auto_awesome_outlined,
                          size: 13,
                          color: context.deniaFaint,
                        ),
                      const SizedBox(width: 6),
                      Text(
                        label,
                        style: TextStyle(
                          fontSize: 11.5,
                          fontWeight: FontWeight.w500,
                          color: context.deniaMuted,
                        ),
                      ),
                      const SizedBox(width: 6),
                      Text(
                        '${widget.text.length} 字',
                        style: TextStyle(
                          fontSize: 10.5,
                          color: context.deniaFaint,
                        ),
                      ),
                      if (canOpen) ...[
                        const SizedBox(width: 2),
                        AnimatedRotation(
                          turns: _expanded ? 0.5 : 0,
                          duration: const Duration(milliseconds: 180),
                          curve: Curves.easeOut,
                          child: Icon(
                            Icons.expand_more_rounded,
                            size: 15,
                            color: context.deniaFaint,
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
            ),
          ),
          AnimatedSize(
            duration: const Duration(milliseconds: 200),
            curve: Curves.easeOut,
            alignment: Alignment.topLeft,
            child: _expanded && canOpen
                ? Container(
                    width: double.infinity,
                    margin: const EdgeInsets.only(top: 6),
                    padding: const EdgeInsets.fromLTRB(12, 10, 12, 11),
                    decoration: BoxDecoration(
                      color: context.deniaSurface,
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(color: context.deniaBorder),
                    ),
                    child: SelectionArea(
                      child: Text(
                        widget.text,
                        style: TextStyle(
                          fontSize: 13,
                          height: 1.6,
                          color: context.deniaMuted,
                        ),
                      ),
                    ),
                  )
                : const SizedBox(width: double.infinity),
          ),
        ],
      ),
    );
  }
}

class NoticeView extends StatefulWidget {
  const NoticeView({super.key, required this.item});

  final NoticeItem item;

  @override
  State<NoticeView> createState() => _NoticeViewState();
}

class _NoticeViewState extends State<NoticeView> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final item = widget.item;
    final color = switch (item.kind) {
      NoticeKind.error => context.deniaDanger,
      NoticeKind.warning => context.deniaWarning,
      _ => context.deniaMuted,
    };
    final icon = switch (item.kind) {
      NoticeKind.error => Icons.error_outline,
      NoticeKind.warning => Icons.info_outline,
      NoticeKind.compaction => Icons.compress,
      NoticeKind.command => Icons.chevron_right,
      NoticeKind.info => Icons.info_outline,
    };
    final expandable =
        item.kind == NoticeKind.compaction ||
        (item.kind == NoticeKind.command && item.text.length > 240);
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: InkWell(
        borderRadius: BorderRadius.circular(10),
        onTap: expandable ? () => setState(() => _expanded = !_expanded) : null,
        child: Container(
          width: double.infinity,
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
          decoration: BoxDecoration(
            color: context.deniaSurface,
            borderRadius: BorderRadius.circular(10),
            border: Border.all(
              color: item.kind == NoticeKind.error
                  ? color.withValues(alpha: 0.35)
                  : context.deniaBorder,
            ),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(icon, size: 14, color: color),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      item.title,
                      style: TextStyle(
                        fontSize: 12,
                        height: 1.4,
                        fontWeight: FontWeight.w500,
                        color: item.kind == NoticeKind.info
                            ? context.deniaMuted
                            : color,
                      ),
                    ),
                  ),
                  if (expandable)
                    Icon(
                      _expanded ? Icons.expand_less : Icons.expand_more,
                      size: 16,
                      color: context.deniaFaint,
                    ),
                ],
              ),
              if (item.text.trim().isNotEmpty && (_expanded || !expandable))
                Padding(
                  padding: const EdgeInsets.only(top: 4, left: 20),
                  child: item.kind == NoticeKind.command
                      ? Text(
                          item.text,
                          style: monoStyle(context, size: 11.5),
                          maxLines: _expanded ? null : 6,
                          overflow: _expanded ? null : TextOverflow.ellipsis,
                        )
                      : Text(
                          item.text,
                          style: TextStyle(
                            fontSize: 12.5,
                            height: 1.55,
                            color: context.deniaMuted,
                          ),
                        ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _LiveDot extends StatefulWidget {
  const _LiveDot();

  @override
  State<_LiveDot> createState() => _LiveDotState();
}

class _LiveDotState extends State<_LiveDot>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 900),
  )..repeat(reverse: true);

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return FadeTransition(
      opacity: Tween<double>(begin: 0.25, end: 1).animate(_controller),
      child: Container(
        width: 5,
        height: 5,
        decoration: BoxDecoration(
          color: context.deniaSuccess,
          shape: BoxShape.circle,
        ),
      ),
    );
  }
}

class BlinkingCaret extends StatefulWidget {
  const BlinkingCaret({super.key, required this.color});

  final Color color;

  @override
  State<BlinkingCaret> createState() => _BlinkingCaretState();
}

class _BlinkingCaretState extends State<BlinkingCaret>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 700),
  )..repeat(reverse: true);

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return FadeTransition(
      opacity: Tween<double>(begin: 0.2, end: 0.9).animate(_controller),
      child: Container(
        width: 7,
        height: 14,
        decoration: BoxDecoration(
          color: widget.color,
          borderRadius: BorderRadius.circular(2),
        ),
      ),
    );
  }
}

String compactTokens(int value) {
  if (value >= 1000) {
    return '${(value / 1000).toStringAsFixed(value >= 10000 ? 0 : 1)}k';
  }
  return '$value';
}
