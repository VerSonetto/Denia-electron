import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:material_ui/material_ui.dart';

import '../../core/format.dart';
import '../../models/transcript.dart';
import '../../theme.dart';

/// One tool call as a quiet, single-line row. The default state is collapsed:
/// the transcript stays readable, and a tap opens the arguments/output in a
/// code well below. Consecutive calls are grouped by [ToolGroupView].
class ToolCard extends StatefulWidget {
  const ToolCard({super.key, required this.item});

  final ToolItem item;

  @override
  State<ToolCard> createState() => _ToolCardState();
}

class _ToolCardState extends State<ToolCard> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final item = widget.item;
    final result = item.result;
    final isError = result?.isError ?? false;
    final summary = _summary(item);
    final expandable = item.hasExpandableBody;
    return Padding(
      padding: const EdgeInsets.only(bottom: 2),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Material(
            color: Colors.transparent,
            child: InkWell(
              borderRadius: BorderRadius.circular(10),
              onTap: expandable
                  ? () => setState(() => _expanded = !_expanded)
                  : null,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(4, 8, 4, 8),
                child: Row(
                  children: [
                    Icon(
                      _iconFor(item.name),
                      size: 15,
                      color: isError ? context.deniaDanger : context.deniaMuted,
                    ),
                    const SizedBox(width: 8),
                    Text(
                      item.name,
                      style: const TextStyle(
                        fontSize: 12.8,
                        fontWeight: FontWeight.w500,
                        height: 1.25,
                      ),
                    ),
                    if (summary.isNotEmpty) ...[
                      const SizedBox(width: 6),
                      Text(
                        '·',
                        style: TextStyle(
                          fontSize: 12,
                          color: context.deniaFaint,
                        ),
                      ),
                      const SizedBox(width: 6),
                      Expanded(
                        child: Text(
                          summary,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 11.8,
                            height: 1.3,
                            color: context.deniaMuted,
                            fontFamily: 'monospace',
                          ),
                        ),
                      ),
                    ] else
                      const Spacer(),
                    const SizedBox(width: 8),
                    _StatusMark(running: item.isRunning, isError: isError),
                    if (expandable) ...[
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
                  ],
                ),
              ),
            ),
          ),
          AnimatedSize(
            duration: const Duration(milliseconds: 200),
            curve: Curves.easeOut,
            alignment: Alignment.topCenter,
            child: _expanded && expandable
                ? Padding(
                    padding: const EdgeInsets.fromLTRB(23, 2, 2, 8),
                    child: _ToolDetail(item: item),
                  )
                : const SizedBox(width: double.infinity),
          ),
        ],
      ),
    );
  }
}

class _StatusMark extends StatelessWidget {
  const _StatusMark({required this.running, required this.isError});

  final bool running;
  final bool isError;

  @override
  Widget build(BuildContext context) {
    if (running) {
      return SizedBox(
        width: 12,
        height: 12,
        child: CircularProgressIndicator(
          strokeWidth: 1.5,
          color: context.deniaMuted,
        ),
      );
    }
    if (isError) {
      return Icon(
        Icons.error_outline_rounded,
        size: 15,
        color: context.deniaDanger,
      );
    }
    return Icon(Icons.check_rounded, size: 15, color: context.deniaFaint);
  }
}

class _ToolDetail extends StatelessWidget {
  const _ToolDetail({required this.item});

  final ToolItem item;

  @override
  Widget build(BuildContext context) {
    final result = item.result;
    final output = (result?.content ?? item.liveOutput).trimRight();
    final hasArgs = item.args.trim().isNotEmpty;
    final hasOutput = output.isNotEmpty || item.isRunning;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(11, 10, 11, 10),
      decoration: BoxDecoration(
        color: context.deniaSurface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: context.deniaBorder),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (hasArgs) ...[
            _SectionLabel(text: '参数'),
            const SizedBox(height: 5),
            _CodeWell(text: _prettyArgs(item.args), maxHeight: 180),
          ],
          if (hasArgs && hasOutput) const SizedBox(height: 10),
          if (hasOutput) ...[
            Row(
              children: [
                _SectionLabel(
                  text: result?.isError == true ? '错误' : '输出',
                  color: result?.isError == true ? context.deniaDanger : null,
                ),
                const Spacer(),
                if (output.isNotEmpty)
                  InkWell(
                    borderRadius: BorderRadius.circular(6),
                    onTap: () async {
                      await Clipboard.setData(ClipboardData(text: output));
                      if (!context.mounted) return;
                      ScaffoldMessenger.of(context)
                          .showSnackBar(const SnackBar(content: Text('输出已复制')));
                    },
                    child: Padding(
                      padding: const EdgeInsets.all(4),
                      child: Icon(
                        Icons.copy_rounded,
                        size: 14,
                        color: context.deniaMuted,
                      ),
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 5),
            if (output.isEmpty)
              Text(
                '等待输出…',
                style: TextStyle(fontSize: 12, color: context.deniaMuted),
              )
            else
              _CodeWell(
                text: output,
                maxHeight: 300,
                color: result?.isError == true ? context.deniaDanger : null,
              ),
          ],
        ],
      ),
    );
  }
}

class _SectionLabel extends StatelessWidget {
  const _SectionLabel({required this.text, this.color});

  final String text;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    return Text(
      text,
      style: TextStyle(
        fontSize: 9.5,
        letterSpacing: 0.7,
        fontWeight: FontWeight.w600,
        color: color ?? context.deniaFaint,
      ),
    );
  }
}

class _CodeWell extends StatelessWidget {
  const _CodeWell({required this.text, required this.maxHeight, this.color});

  final String text;
  final double maxHeight;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      constraints: BoxConstraints(maxHeight: maxHeight),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: context.isDark
            ? const Color(0xFF0C0C0C)
            : const Color(0xFFF2F2F2),
        borderRadius: BorderRadius.circular(9),
      ),
      child: SingleChildScrollView(
        child: SelectableText(
          text,
          style: monoStyle(context, size: 11.5, color: color),
        ),
      ),
    );
  }
}

String _prettyArgs(String raw) {
  try {
    final decoded = jsonDecode(raw);
    return const JsonEncoder.withIndent('  ').convert(decoded);
  } catch (_) {
    return raw;
  }
}

String _summary(ToolItem item) {
  final raw = item.args.trim();
  if (raw.isEmpty) return shortCallId(item.callId);
  try {
    final decoded = jsonDecode(raw);
    if (decoded is Map) {
      final todos = decoded['todos'];
      if (todos is List && todos.isNotEmpty && todos.first is Map) {
        final content = (todos.first as Map)['content'];
        if (content is String && content.trim().isNotEmpty) {
          return collapseWhitespace(content, max: 110);
        }
      }
      for (final key in const [
        'command',
        'path',
        'file_path',
        'filePath',
        'query',
        'url',
        'pattern',
        'description',
        'prompt',
        'name',
      ]) {
        final value = decoded[key];
        if (value is String && value.trim().isNotEmpty) {
          return collapseWhitespace(value, max: 110);
        }
      }
      String? first;
      for (final value in decoded.values.whereType<String>()) {
        if (value.trim().isNotEmpty) {
          first = value;
          break;
        }
      }
      if (first != null) {
        return collapseWhitespace(first, max: 110);
      }
    }
  } catch (_) {
    // Not JSON; show the raw argument snippet.
  }
  return collapseWhitespace(raw, max: 110);
}

IconData _iconFor(String name) {
  final lower = name.toLowerCase();
  if (lower.contains('bash') ||
      lower.contains('shell') ||
      lower.contains('terminal') ||
      lower.contains('exec')) {
    return Icons.terminal_rounded;
  }
  if (lower.contains('read') ||
      lower.contains('file') ||
      lower.contains('cat')) {
    return Icons.description_outlined;
  }
  if (lower.contains('write') ||
      lower.contains('edit') ||
      lower.contains('patch')) {
    return Icons.edit_note_rounded;
  }
  if (lower.contains('search') ||
      lower.contains('grep') ||
      lower.contains('find')) {
    return Icons.search_rounded;
  }
  if (lower.contains('web') ||
      lower.contains('fetch') ||
      lower.contains('browser')) {
    return Icons.public_rounded;
  }
  if (lower.contains('todo') || lower.contains('plan')) {
    return Icons.checklist_rounded;
  }
  if (lower.contains('agent') || lower.contains('task')) {
    return Icons.hub_outlined;
  }
  return Icons.build_circle_outlined;
}
