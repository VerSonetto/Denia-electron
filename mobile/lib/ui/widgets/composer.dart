import 'package:material_ui/material_ui.dart';

import '../../theme.dart';
import 'composer_morph.dart';
import 'input_surface.dart';

/// A collapsible elevated composer in the reference material.
///
/// Closed: [+ add] [draft ....................] [send/stop]
/// Open:   [draft ...................................]
///         [+ add] [model]                    [send/stop]
///
/// The add key exists before expansion. Once the key drops to the action row,
/// the draft slides back to the card's line head. Permission lives in the
/// header/menu instead of competing with the draft.
class Composer extends StatefulWidget {
  const Composer({
    super.key,
    required this.controller,
    required this.focusNode,
    required this.running,
    required this.sending,
    required this.cancelling,
    required this.connected,
    required this.modelLabel,
    required this.onSend,
    required this.onStop,
    required this.onAddTap,
    required this.onModelTap,
  });

  final TextEditingController controller;
  final FocusNode focusNode;
  final bool running;
  final bool sending;
  final bool cancelling;
  final bool connected;
  final String? modelLabel;
  final Future<void> Function() onSend;
  final Future<void> Function() onStop;
  final VoidCallback onAddTap;
  final VoidCallback onModelTap;

  @override
  State<Composer> createState() => _ComposerState();
}

class _ComposerState extends State<Composer>
    with SingleTickerProviderStateMixin {
  late final AnimationController _open = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 240),
  );
  late final Animation<double> _fade = CurvedAnimation(
    parent: _open,
    curve: const Interval(0.18, 1, curve: Curves.easeOut),
  );

  @override
  void initState() {
    super.initState();
    widget.focusNode.addListener(_syncOpen);
    widget.controller.addListener(_syncOpen);
    _syncOpen();
  }

  @override
  void didUpdateWidget(Composer oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.focusNode != widget.focusNode) {
      oldWidget.focusNode.removeListener(_syncOpen);
      widget.focusNode.addListener(_syncOpen);
    }
    if (oldWidget.controller != widget.controller) {
      oldWidget.controller.removeListener(_syncOpen);
      widget.controller.addListener(_syncOpen);
    }
    _syncOpen();
  }

  @override
  void dispose() {
    widget.focusNode.removeListener(_syncOpen);
    widget.controller.removeListener(_syncOpen);
    _open.dispose();
    super.dispose();
  }

  void _syncOpen() {
    final shouldOpen =
        widget.focusNode.hasFocus || widget.controller.text.trim().isNotEmpty;
    if (shouldOpen) {
      if (!_open.isForwardOrCompleted) _open.forward();
    } else if (!_open.isDismissed) {
      _open.reverse();
    }
  }

  @override
  Widget build(BuildContext context) {
    final selectorFill = context.isDark
        ? DeniaTheme.darkInputSelector
        : DeniaTheme.lightInputSelector;

    final field = TextField(
      controller: widget.controller,
      focusNode: widget.focusNode,
      minLines: 1,
      maxLines: 5,
      keyboardType: TextInputType.multiline,
      textInputAction: TextInputAction.newline,
      style: const TextStyle(fontSize: 15, height: 1.4),
      cursorWidth: 1.6,
      decoration: InputDecoration(
        isDense: true,
        filled: false,
        border: InputBorder.none,
        enabledBorder: InputBorder.none,
        focusedBorder: InputBorder.none,
        disabledBorder: InputBorder.none,
        errorBorder: InputBorder.none,
        focusedErrorBorder: InputBorder.none,
        contentPadding: const EdgeInsets.fromLTRB(4, 10, 4, 10),
        hintText: widget.connected ? '给 Denia 发消息…' : '连接断开，等待重连…',
      ),
    );

    final add = _AddKey(onTap: widget.onAddTap, fill: selectorFill);

    final footer = FadeTransition(
      opacity: _fade,
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxWidth: MediaQuery.sizeOf(context).width * 0.5,
        ),
        child: _ModelPill(
          label: widget.modelLabel ?? '选择模型',
          fill: selectorFill,
          onTap: widget.onModelTap,
        ),
      ),
    );

    final trailing = ValueListenableBuilder<TextEditingValue>(
      valueListenable: widget.controller,
      builder: (context, value, _) {
        final empty = value.text.trim().isEmpty;
        final stop = widget.running && empty;
        return _PrimaryKey(
          busy: stop ? widget.cancelling : widget.sending,
          enabled:
              widget.connected &&
              !(stop ? widget.cancelling : widget.sending) &&
              (stop || !empty),
          tooltip: stop
              ? '停止本轮'
              : widget.running
              ? '发送引导'
              : '发送消息',
          icon: stop
              ? Icons.stop_rounded
              : widget.running
              ? Icons.bolt_rounded
              : Icons.arrow_upward_rounded,
          onPressed: stop ? widget.onStop : widget.onSend,
        );
      },
    );

    return SafeArea(
      top: false,
      minimum: const EdgeInsets.only(bottom: 8),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(10, 4, 10, 0),
        child: InputSurface(
          radius: 28,
          padding: const EdgeInsets.all(7),
          child: ComposerMorph(
            open: _open,
            children: [field, add, footer, trailing],
          ),
        ),
      ),
    );
  }
}

class _AddKey extends StatelessWidget {
  const _AddKey({required this.onTap, required this.fill});

  final VoidCallback onTap;
  final Color fill;

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: '模型与权限',
      child: SizedBox(
        width: 40,
        height: 40,
        child: Center(
          child: Material(
            color: fill,
            shape: const CircleBorder(),
            clipBehavior: Clip.antiAlias,
            child: InkWell(
              onTap: onTap,
              customBorder: const CircleBorder(),
              child: SizedBox(
                width: 32,
                height: 32,
                child: Icon(
                  Icons.add_rounded,
                  size: 18,
                  color: context.deniaText,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _ModelPill extends StatelessWidget {
  const _ModelPill({
    required this.label,
    required this.fill,
    required this.onTap,
  });

  final String label;
  final Color fill;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: fill,
      borderRadius: BorderRadius.circular(16),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Container(
          height: 28,
          padding: const EdgeInsets.fromLTRB(8, 0, 5, 0),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.auto_awesome, size: 12, color: context.deniaMuted),
              const SizedBox(width: 4),
              Flexible(
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w500,
                    color: context.deniaMuted,
                  ),
                ),
              ),
              const SizedBox(width: 2),
              Icon(
                Icons.expand_more_rounded,
                size: 14,
                color: context.deniaMuted,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _PrimaryKey extends StatelessWidget {
  const _PrimaryKey({
    required this.busy,
    required this.enabled,
    required this.tooltip,
    required this.icon,
    required this.onPressed,
  });

  final bool busy;
  final bool enabled;
  final String tooltip;
  final IconData icon;
  final Future<void> Function() onPressed;

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: tooltip,
      child: SizedBox(
        width: 42,
        height: 42,
        child: FilledButton(
          onPressed: enabled ? () => onPressed() : null,
          style: FilledButton.styleFrom(
            padding: EdgeInsets.zero,
            shape: const CircleBorder(),
          ),
          child: AnimatedSwitcher(
            duration: const Duration(milliseconds: 150),
            transitionBuilder: (child, animation) => ScaleTransition(
              scale: animation,
              child: FadeTransition(opacity: animation, child: child),
            ),
            child: busy
                ? const SizedBox(
                    key: ValueKey('busy'),
                    width: 15,
                    height: 15,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : Icon(icon, key: ValueKey(icon), size: 20),
          ),
        ),
      ),
    );
  }
}
