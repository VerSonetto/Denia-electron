import 'package:material_ui/material_ui.dart';

import '../../theme.dart';
import 'input_surface.dart';

/// Floating chat chrome in the shared input material.
///
/// Existing conversation: [back] [title/status] [+ new session]
/// Empty new session:     [back] [title/status] [model select]
class ChatHeaderBar extends StatelessWidget {
  const ChatHeaderBar({
    super.key,
    required this.title,
    required this.status,
    required this.running,
    required this.connected,
    required this.hasContent,
    required this.creating,
    required this.modelLabel,
    required this.onBack,
    required this.onNewSession,
    required this.onModelTap,
  });

  final String title;
  final String status;
  final bool running;
  final bool connected;
  final bool hasContent;
  final bool creating;
  final String modelLabel;
  final VoidCallback onBack;
  final VoidCallback onNewSession;
  final VoidCallback onModelTap;

  @override
  Widget build(BuildContext context) {
    final statusColor = running
        ? context.deniaText
        : connected
        ? context.deniaMuted
        : context.deniaDanger;
    final dotColor = running || connected
        ? context.deniaSuccess
        : context.deniaDanger;
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
      child: Row(
        children: [
          _CircleKey(
            tooltip: '返回',
            onTap: onBack,
            child: const Icon(Icons.arrow_back_rounded, size: 20),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: InputSurface(
              radius: 21,
              child: Container(
                height: 42,
                padding: const EdgeInsets.fromLTRB(14, 4, 12, 4),
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w600,
                        letterSpacing: -0.15,
                        height: 1.2,
                      ),
                    ),
                    const SizedBox(height: 1),
                    Row(
                      children: [
                        AnimatedContainer(
                          duration: const Duration(milliseconds: 220),
                          width: running ? 7 : 5,
                          height: running ? 7 : 5,
                          decoration: BoxDecoration(
                            color: dotColor,
                            shape: BoxShape.circle,
                          ),
                        ),
                        const SizedBox(width: 6),
                        Expanded(
                          child: Text(
                            status,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontSize: 10,
                              height: 1.15,
                              color: statusColor,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          ),
          const SizedBox(width: 8),
          if (hasContent)
            _CircleKey(
              tooltip: '新会话',
              onTap: creating ? null : onNewSession,
              child: creating
                  ? SizedBox(
                      width: 15,
                      height: 15,
                      child: CircularProgressIndicator(
                        strokeWidth: 1.8,
                        color: context.deniaMuted,
                      ),
                    )
                  : const Icon(Icons.add_rounded, size: 20),
            )
          else
            _ModelKey(label: modelLabel, onTap: onModelTap),
        ],
      ),
    );
  }
}

class _CircleKey extends StatelessWidget {
  const _CircleKey({
    required this.child,
    required this.tooltip,
    required this.onTap,
  });

  final Widget child;
  final String tooltip;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: tooltip,
      child: SizedBox(
        width: 42,
        height: 42,
        child: InputSurface(
          radius: 21,
          child: Material(
            color: Colors.transparent,
            borderRadius: BorderRadius.circular(21),
            clipBehavior: Clip.antiAlias,
            child: InkWell(
              onTap: onTap,
              child: IconTheme(
                data: IconThemeData(color: context.deniaMuted),
                child: Center(child: child),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _ModelKey extends StatelessWidget {
  const _ModelKey({required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return ConstrainedBox(
      constraints: BoxConstraints(
        maxWidth: MediaQuery.sizeOf(context).width * 0.42,
      ),
      child: SizedBox(
        height: 42,
        child: InputSurface(
          radius: 21,
          child: Material(
            color: Colors.transparent,
            borderRadius: BorderRadius.circular(21),
            clipBehavior: Clip.antiAlias,
            child: InkWell(
              onTap: onTap,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(10, 0, 7, 0),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(
                      Icons.auto_awesome,
                      size: 13,
                      color: context.deniaMuted,
                    ),
                    const SizedBox(width: 5),
                    Flexible(
                      child: Text(
                        label,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w500,
                          color: context.deniaText,
                        ),
                      ),
                    ),
                    const SizedBox(width: 2),
                    Icon(
                      Icons.expand_more_rounded,
                      size: 15,
                      color: context.deniaMuted,
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
