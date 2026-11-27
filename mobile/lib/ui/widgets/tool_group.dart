import 'package:material_ui/material_ui.dart';

import '../../models/transcript.dart';
import '../../theme.dart';
import 'tool_card.dart';

/// A run of consecutive tool calls, folded into one quiet summary row while it
/// runs or after it finishes. Expanding it shows the individual rows on a thin
/// thread, so a long tool chain does not turn the transcript into a stack of
/// cards.
class ToolGroupView extends StatefulWidget {
  const ToolGroupView({super.key, required this.tools});

  final List<ToolItem> tools;

  @override
  State<ToolGroupView> createState() => _ToolGroupViewState();
}

class _ToolGroupViewState extends State<ToolGroupView> {
  late bool _expanded;
  bool _touched = false;

  bool get _running => widget.tools.any((tool) => tool.isRunning);

  @override
  void initState() {
    super.initState();
    _expanded = _running;
  }

  @override
  void didUpdateWidget(ToolGroupView oldWidget) {
    super.didUpdateWidget(oldWidget);
    final wasRunning = oldWidget.tools.any((tool) => tool.isRunning);
    if (_running && !wasRunning) {
      _expanded = true;
      return;
    }
    // Let a completed chain settle closed unless the reader opened it while it
    // was running.
    if (!_running && wasRunning && !_touched) {
      _expanded = false;
    }
  }

  void _toggle() {
    setState(() {
      _touched = true;
      _expanded = !_expanded;
    });
  }

  @override
  Widget build(BuildContext context) {
    final names = widget.tools.map((tool) => tool.name).toList(growable: false);
    final summary = names.length <= 3
        ? names.join(' · ')
        : '${names.take(3).join(' · ')} +${names.length - 3}';
    final error = widget.tools.any((tool) => tool.result?.isError == true);
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Material(
            color: Colors.transparent,
            child: InkWell(
              borderRadius: BorderRadius.circular(10),
              onTap: _toggle,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(4, 8, 4, 8),
                child: Row(
                  children: [
                    Icon(
                      Icons.account_tree_outlined,
                      size: 15,
                      color: error ? context.deniaDanger : context.deniaMuted,
                    ),
                    const SizedBox(width: 8),
                    Text(
                      '${widget.tools.length} 个工具调用',
                      style: const TextStyle(
                        fontSize: 12.5,
                        fontWeight: FontWeight.w500,
                        height: 1.25,
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        summary,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 11.5,
                          height: 1.3,
                          color: context.deniaFaint,
                          fontFamily: 'monospace',
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    if (_running)
                      SizedBox(
                        width: 12,
                        height: 12,
                        child: CircularProgressIndicator(
                          strokeWidth: 1.5,
                          color: context.deniaMuted,
                        ),
                      )
                    else if (error)
                      Icon(
                        Icons.error_outline_rounded,
                        size: 15,
                        color: context.deniaDanger,
                      )
                    else
                      Icon(
                        Icons.check_rounded,
                        size: 15,
                        color: context.deniaFaint,
                      ),
                    const SizedBox(width: 2),
                    AnimatedRotation(
                      turns: _expanded ? 0.5 : 0,
                      duration: const Duration(milliseconds: 180),
                      curve: Curves.easeOut,
                      child: Icon(
                        Icons.expand_more_rounded,
                        size: 16,
                        color: context.deniaFaint,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
          AnimatedSize(
            duration: const Duration(milliseconds: 200),
            curve: Curves.easeOut,
            alignment: Alignment.topLeft,
            child: _expanded
                ? Padding(
                    padding: const EdgeInsets.only(left: 7, bottom: 2),
                    child: Container(
                      width: double.infinity,
                      decoration: BoxDecoration(
                        border: Border(
                          left: BorderSide(color: context.deniaBorder),
                        ),
                      ),
                      padding: const EdgeInsets.only(left: 10),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          for (final tool in widget.tools)
                            ToolCard(
                              key: ValueKey('tool:${tool.callId}'),
                              item: tool,
                            ),
                        ],
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
