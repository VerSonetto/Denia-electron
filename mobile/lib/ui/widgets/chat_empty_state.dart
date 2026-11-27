import 'package:flutter/services.dart';
import 'package:material_ui/material_ui.dart';

import '../../theme.dart';
import 'denia_logo.dart';

class ChatSuggestion {
  const ChatSuggestion({
    required this.icon,
    required this.label,
    required this.detail,
    required this.prompt,
  });

  final IconData icon;
  final String label;
  final String detail;
  final String prompt;
}

const _suggestions = <ChatSuggestion>[
  ChatSuggestion(
    icon: Icons.folder_open_rounded,
    label: '看看项目',
    detail: '目录结构与关键模块',
    prompt: '帮我看看当前项目：先总结目录结构、主要模块和启动方式。',
  ),
  ChatSuggestion(
    icon: Icons.science_outlined,
    label: '运行测试',
    detail: '执行并解释结果',
    prompt: '运行当前项目现有的测试，并告诉我结果和失败原因。',
  ),
  ChatSuggestion(
    icon: Icons.code_rounded,
    label: '解释代码',
    detail: '挑核心路径讲清楚',
    prompt: '挑当前项目最核心的一段代码，解释它解决的问题和关键流程。',
  ),
  ChatSuggestion(
    icon: Icons.checklist_rounded,
    label: '整理待办',
    detail: '从现状推导下一步',
    prompt: '根据当前仓库状态，整理一份接下来可以执行的待办清单。',
  ),
];

/// Empty new-chat surface: greeting, four starting points and one quiet tip.
/// Cards fill the composer instead of sending immediately, so the reader can
/// edit the prompt before it reaches the host.
class ChatEmptyState extends StatefulWidget {
  const ChatEmptyState({super.key, required this.onSuggestion});

  final ValueChanged<String> onSuggestion;

  @override
  State<ChatEmptyState> createState() => _ChatEmptyStateState();
}

class _ChatEmptyStateState extends State<ChatEmptyState>
    with SingleTickerProviderStateMixin {
  late final AnimationController _enter = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 650),
  )..forward();

  @override
  void dispose() {
    _enter.dispose();
    super.dispose();
  }

  String get _greeting {
    final hour = DateTime.now().hour;
    if (hour >= 5 && hour < 11) return '早上好';
    if (hour >= 11 && hour < 14) return '中午好';
    if (hour >= 14 && hour < 18) return '下午好';
    if (hour >= 18 && hour < 23) return '晚上好';
    return '夜深了';
  }

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        return SingleChildScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(22, 26, 22, 26),
          child: ConstrainedBox(
            constraints: BoxConstraints(
              minHeight: (constraints.maxHeight - 52).clamp(0, double.infinity),
            ),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                _Reveal(
                  controller: _enter,
                  index: 0,
                  child: Center(child: DeniaLogo(size: 42, radius: 13)),
                ),
                const SizedBox(height: 18),
                _Reveal(
                  controller: _enter,
                  index: 1,
                  child: Text(
                    _greeting,
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      fontSize: 11.5,
                      fontWeight: FontWeight.w500,
                      letterSpacing: 0.8,
                      color: context.deniaMuted,
                    ),
                  ),
                ),
                const SizedBox(height: 4),
                _Reveal(
                  controller: _enter,
                  index: 2,
                  child: const Text(
                    '今天想做什么？',
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      fontSize: 24,
                      fontWeight: FontWeight.w600,
                      letterSpacing: -0.6,
                      height: 1.2,
                    ),
                  ),
                ),
                const SizedBox(height: 8),
                _Reveal(
                  controller: _enter,
                  index: 3,
                  child: Text(
                    '消息会发送到电脑上的 Denia。\n工具调用、结果和审批都会实时回到手机。',
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      fontSize: 12.5,
                      height: 1.65,
                      color: context.deniaMuted,
                    ),
                  ),
                ),
                const SizedBox(height: 26),
                _Reveal(
                  controller: _enter,
                  index: 4,
                  child: _SuggestionGrid(
                    suggestions: _suggestions,
                    onTap: (suggestion) {
                      HapticFeedback.lightImpact();
                      widget.onSuggestion(suggestion.prompt);
                    },
                  ),
                ),
                const SizedBox(height: 18),
                _Reveal(
                  controller: _enter,
                  index: 5,
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(
                        Icons.lightbulb_outline_rounded,
                        size: 13,
                        color: context.deniaFaint,
                      ),
                      const SizedBox(width: 6),
                      Flexible(
                        child: Text(
                          '运行中可以继续发送引导，不会打断当前轮次',
                          style: TextStyle(
                            fontSize: 10.5,
                            height: 1.4,
                            color: context.deniaFaint,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}

class _SuggestionGrid extends StatelessWidget {
  const _SuggestionGrid({required this.suggestions, required this.onTap});

  final List<ChatSuggestion> suggestions;
  final ValueChanged<ChatSuggestion> onTap;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final width = (constraints.maxWidth - 10) / 2;
        return Wrap(
          spacing: 10,
          runSpacing: 10,
          children: [
            for (final suggestion in suggestions)
              SizedBox(
                width: width,
                child: Material(
                  color: context.deniaSurface,
                  borderRadius: BorderRadius.circular(14),
                  clipBehavior: Clip.antiAlias,
                  child: InkWell(
                    onTap: () => onTap(suggestion),
                    child: Container(
                      height: 88,
                      padding: const EdgeInsets.fromLTRB(12, 11, 12, 10),
                      decoration: BoxDecoration(
                        borderRadius: BorderRadius.circular(14),
                        border: Border.all(color: context.deniaBorder),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Icon(
                            suggestion.icon,
                            size: 17,
                            color: context.deniaMuted,
                          ),
                          const Spacer(),
                          Text(
                            suggestion.label,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              fontSize: 12.8,
                              fontWeight: FontWeight.w600,
                              letterSpacing: -0.1,
                            ),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            suggestion.detail,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontSize: 10.5,
                              height: 1.3,
                              color: context.deniaFaint,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
          ],
        );
      },
    );
  }
}

class _Reveal extends StatelessWidget {
  const _Reveal({
    required this.controller,
    required this.index,
    required this.child,
  });

  final AnimationController controller;
  final int index;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final start = (index * 0.07).clamp(0.0, 0.55);
    final animation = CurvedAnimation(
      parent: controller,
      curve: Interval(start, 1, curve: Curves.easeOutCubic),
    );
    return FadeTransition(
      opacity: animation,
      child: SlideTransition(
        position: Tween<Offset>(
          begin: const Offset(0, 0.035),
          end: Offset.zero,
        ).animate(animation),
        child: child,
      ),
    );
  }
}
