import 'dart:async';
import 'dart:math';

import 'package:flutter/services.dart';
import 'package:markdown/markdown.dart' as md;
import 'package:material_ui/material_ui.dart';

import '../../theme.dart';

/// Lightweight Markdown renderer: block structure as widgets, inline runs as
/// spans. No HTML, no remote images, no link launching — a remote chat should
/// never turn untrusted model output into an implicit network request.
///
/// Parsing is throttled while [streaming]: the transcript rebuilds for every
/// token, but the Markdown AST refreshes on a size-aware cadence. A completed
/// message is parsed once more and kept in the LRU cache.
class MarkdownView extends StatefulWidget {
  const MarkdownView(
    this.text, {
    super.key,
    this.compact = false,
    this.streaming = false,
  });

  final String text;
  final bool compact;
  final bool streaming;

  @override
  State<MarkdownView> createState() => _MarkdownViewState();
}

class _MarkdownViewState extends State<MarkdownView> {
  static final Map<String, List<md.Node>> _astCache = <String, List<md.Node>>{};
  static const int _astCacheLimit = 80;
  static const int _astCacheChars = 200000;
  static int _cachedChars = 0;

  late List<md.Node> _nodes;
  String _parsedText = '';
  DateTime _lastParse = DateTime.fromMillisecondsSinceEpoch(0);
  Timer? _pendingParse;

  static List<md.Node> _parse(String text, {required bool cache}) {
    if (cache) {
      final hit = _astCache.remove(text);
      if (hit != null) {
        _astCache[text] = hit;
        return hit;
      }
    }
    final document = md.Document(
      extensionSet: md.ExtensionSet.gitHubFlavored,
      encodeHtml: false,
    );
    final nodes = document.parse(text);
    if (cache) _remember(text, nodes);
    return nodes;
  }

  static void _remember(String text, List<md.Node> nodes) {
    if (_astCache.containsKey(text)) return;
    _astCache[text] = nodes;
    _cachedChars += text.length;
    while (_astCache.length > _astCacheLimit || _cachedChars > _astCacheChars) {
      final oldest = _astCache.keys.first;
      final removed = _astCache.remove(oldest);
      if (removed == null) break;
      _cachedChars -= oldest.length;
    }
  }

  @override
  void initState() {
    super.initState();
    _nodes = _parse(widget.text, cache: !widget.streaming);
    _parsedText = widget.text;
    _lastParse = DateTime.now();
  }

  @override
  void didUpdateWidget(MarkdownView oldWidget) {
    super.didUpdateWidget(oldWidget);
    final textChanged = oldWidget.text != widget.text;
    final streamEnded = oldWidget.streaming && !widget.streaming;
    if (!textChanged && !streamEnded) return;

    if (!widget.streaming) {
      _pendingParse?.cancel();
      _pendingParse = null;
      if (_parsedText == widget.text) {
        _remember(widget.text, _nodes);
      } else {
        _nodes = _parse(widget.text, cache: true);
        _parsedText = widget.text;
      }
      _lastParse = DateTime.now();
      return;
    }

    _scheduleStreamingParse();
  }

  int get _streamParseDelayMs {
    final length = widget.text.length;
    if (length > 16000) return 140;
    if (length > 6000) return 90;
    return 55;
  }

  void _scheduleStreamingParse() {
    final elapsed = DateTime.now().difference(_lastParse).inMilliseconds;
    final wait = _streamParseDelayMs - elapsed;
    if (wait <= 0) {
      _pendingParse?.cancel();
      _pendingParse = null;
      _nodes = _parse(widget.text, cache: false);
      _parsedText = widget.text;
      _lastParse = DateTime.now();
      return;
    }
    _pendingParse ??= Timer(Duration(milliseconds: wait), () {
      _pendingParse = null;
      if (!mounted) return;
      setState(() {
        _nodes = _parse(widget.text, cache: false);
        _parsedText = widget.text;
        _lastParse = DateTime.now();
      });
    });
  }

  @override
  void dispose() {
    _pendingParse?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final bodyStyle = TextStyle(
      fontSize: widget.compact ? 13.5 : 15,
      height: widget.compact ? 1.55 : 1.68,
      color: context.deniaText,
    );
    final blocks = <Widget>[];
    for (var index = 0; index < _nodes.length; index += 1) {
      blocks.add(_block(context, _nodes[index], bodyStyle, first: index == 0));
    }
    final content = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: blocks,
    );
    // Selection is only useful once a message has settled. Skipping the
    // SelectionArea during streaming keeps token updates lighter.
    return widget.streaming ? content : SelectionArea(child: content);
  }

  Widget _block(
    BuildContext context,
    md.Node node,
    TextStyle bodyStyle, {
    bool first = false,
  }) {
    if (node is md.Text) {
      return Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: Text(node.text, style: bodyStyle),
      );
    }
    if (node is! md.Element) return const SizedBox.shrink();
    switch (node.tag) {
      case 'p':
        return Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: _rich(context, node.children ?? const [], bodyStyle),
        );
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        final size = switch (node.tag) {
          'h1' => 24.0,
          'h2' => 20.5,
          'h3' => 17.5,
          'h4' => 16.0,
          'h5' => 15.0,
          _ => 14.5,
        };
        final top = first
            ? 0.0
            : switch (node.tag) {
                'h1' => 18.0,
                'h2' => 14.0,
                'h3' => 11.0,
                'h4' => 8.0,
                _ => 6.0,
              };
        return Padding(
          padding: EdgeInsets.only(top: top, bottom: 7),
          child: _rich(
            context,
            node.children ?? const [],
            bodyStyle.copyWith(
              fontSize: size,
              fontWeight: FontWeight.w600,
              height: 1.3,
              letterSpacing: -0.2,
            ),
          ),
        );
      case 'pre':
        return Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: _CodeBlock(element: node),
        );
      case 'blockquote':
        return _blockquote(context, node, bodyStyle);
      case 'ul':
        return Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: _list(context, node, bodyStyle, ordered: false),
        );
      case 'ol':
        return Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: _list(context, node, bodyStyle, ordered: true),
        );
      case 'hr':
        return Padding(
          padding: const EdgeInsets.symmetric(vertical: 18),
          child: Divider(height: 1, color: context.deniaBorder),
        );
      case 'table':
        return _table(context, node, bodyStyle);
      case 'li':
        return _rich(context, node.children ?? const [], bodyStyle);
      default:
        if (node.children != null && node.children!.isNotEmpty) {
          return Padding(
            padding: const EdgeInsets.only(bottom: 4),
            child: _rich(context, node.children!, bodyStyle),
          );
        }
        return const SizedBox.shrink();
    }
  }

  Widget _blockquote(
    BuildContext context,
    md.Element element,
    TextStyle bodyStyle,
  ) {
    final quoteStyle = bodyStyle.copyWith(color: context.deniaMuted);
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      decoration: BoxDecoration(
        color: context.deniaRaised.withValues(
          alpha: context.isDark ? 0.42 : 0.62,
        ),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(
          color: context.deniaBorder.withValues(alpha: 0.65),
          width: 0.5,
        ),
      ),
      child: Stack(
        children: [
          Positioned(
            left: 0,
            top: 9,
            bottom: 9,
            child: Container(
              width: 2,
              decoration: BoxDecoration(
                color: context.deniaMuted.withValues(alpha: 0.5),
                borderRadius: BorderRadius.circular(2),
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 10, 12, 2),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (final child in element.children ?? const <md.Node>[])
                  _block(context, child, quoteStyle),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _list(
    BuildContext context,
    md.Element element,
    TextStyle bodyStyle, {
    required bool ordered,
  }) {
    final children =
        element.children?.whereType<md.Element>().toList() ??
        const <md.Element>[];
    var number = 1;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final item in children)
          Padding(
            padding: const EdgeInsets.only(bottom: 4),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: 22,
                  child: ordered
                      ? Text(
                          '${number++}.',
                          style: bodyStyle.copyWith(color: context.deniaMuted),
                        )
                      : Padding(
                          padding: EdgeInsets.only(
                            top: (bodyStyle.fontSize ?? 15) * 0.58,
                            left: 2,
                          ),
                          child: Align(
                            alignment: Alignment.topLeft,
                            child: Container(
                              width: 4,
                              height: 4,
                              decoration: BoxDecoration(
                                color: context.deniaMuted,
                                shape: BoxShape.circle,
                              ),
                            ),
                          ),
                        ),
                ),
                Expanded(child: _listItem(context, item, bodyStyle)),
              ],
            ),
          ),
      ],
    );
  }

  Widget _listItem(BuildContext context, md.Element item, TextStyle bodyStyle) {
    final children = item.children ?? const <md.Node>[];
    final inline = <md.Node>[];
    final blocks = <Widget>[];

    void flushInline() {
      if (inline.isEmpty) return;
      blocks.add(
        Padding(
          padding: const EdgeInsets.only(bottom: 3),
          child: _rich(context, List<md.Node>.of(inline), bodyStyle),
        ),
      );
      inline.clear();
    }

    for (final child in children) {
      if (child is md.Element && _isBlockTag(child.tag)) {
        flushInline();
        if (child.tag == 'ul' || child.tag == 'ol') {
          blocks.add(
            Padding(
              padding: EdgeInsets.only(top: blocks.isEmpty ? 0 : 4),
              child: _list(
                context,
                child,
                bodyStyle,
                ordered: child.tag == 'ol',
              ),
            ),
          );
        } else if (child.tag == 'p') {
          blocks.add(
            Padding(
              padding: const EdgeInsets.only(bottom: 3),
              child: _rich(context, child.children ?? const [], bodyStyle),
            ),
          );
        } else {
          blocks.add(_block(context, child, bodyStyle));
        }
      } else {
        inline.add(child);
      }
    }
    flushInline();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: blocks,
    );
  }

  static bool _isBlockTag(String tag) {
    return const {
      'p',
      'ul',
      'ol',
      'pre',
      'blockquote',
      'table',
      'hr',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
    }.contains(tag);
  }

  Widget _table(BuildContext context, md.Element element, TextStyle bodyStyle) {
    final rawRows = <md.Element>[];
    for (final child in element.children ?? const <md.Node>[]) {
      if (child is! md.Element) continue;
      if (child.tag == 'tr') {
        rawRows.add(child);
      } else if (child.tag == 'thead' || child.tag == 'tbody') {
        rawRows.addAll(child.children?.whereType<md.Element>() ?? const []);
      }
    }
    final rows = rawRows
        .map(
          (row) =>
              row.children?.whereType<md.Element>().toList() ??
              const <md.Element>[],
        )
        .toList(growable: false);
    final columns = rows.map((row) => row.length).fold<int>(0, max);
    if (rows.isEmpty || columns == 0) return const SizedBox.shrink();
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: context.deniaBorder, width: 0.5),
      ),
      clipBehavior: Clip.antiAlias,
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Table(
          defaultColumnWidth: const IntrinsicColumnWidth(),
          defaultVerticalAlignment: TableCellVerticalAlignment.middle,
          border: TableBorder(
            horizontalInside: BorderSide(
              color: context.deniaBorder.withValues(alpha: 0.75),
              width: 0.5,
            ),
          ),
          children: [
            for (final row in rows)
              TableRow(
                decoration: row.any((cell) => cell.tag == 'th')
                    ? BoxDecoration(
                        color: context.deniaRaised.withValues(
                          alpha: context.isDark ? 0.6 : 0.7,
                        ),
                      )
                    : null,
                children: [
                  for (var index = 0; index < columns; index += 1)
                    Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 10,
                        vertical: 7,
                      ),
                      child: index < row.length
                          ? _rich(
                              context,
                              row[index].children ?? const [],
                              bodyStyle.copyWith(
                                fontWeight: row[index].tag == 'th'
                                    ? FontWeight.w600
                                    : FontWeight.w400,
                                fontSize: row[index].tag == 'th' ? 12.5 : 13.5,
                                height: 1.45,
                              ),
                            )
                          : const SizedBox.shrink(),
                    ),
                ],
              ),
          ],
        ),
      ),
    );
  }

  Widget _rich(BuildContext context, List<md.Node> nodes, TextStyle base) {
    return Text.rich(
      TextSpan(
        style: base,
        children: [for (final node in nodes) _inline(context, node, base)],
      ),
    );
  }

  InlineSpan _inline(BuildContext context, md.Node node, TextStyle style) {
    if (node is md.Text) return TextSpan(text: node.text, style: style);
    if (node is! md.Element) return const TextSpan();
    switch (node.tag) {
      case 'strong':
        return TextSpan(
          style: style.copyWith(fontWeight: FontWeight.w600),
          children: _children(
            context,
            node,
            style.copyWith(fontWeight: FontWeight.w600),
          ),
        );
      case 'em':
        return TextSpan(
          style: style.copyWith(fontStyle: FontStyle.italic),
          children: _children(
            context,
            node,
            style.copyWith(fontStyle: FontStyle.italic),
          ),
        );
      case 'del':
        return TextSpan(
          style: style.copyWith(decoration: TextDecoration.lineThrough),
          children: _children(context, node, style),
        );
      case 'code':
        return TextSpan(
          text: node.textContent,
          style: style.copyWith(
            fontFamily: 'monospace',
            fontFamilyFallback: const ['Menlo', 'Consolas', 'Roboto Mono'],
            fontSize: (style.fontSize ?? 15) * 0.88,
            fontWeight: FontWeight.w500,
            backgroundColor: context.isDark
                ? const Color(0xFF29292D)
                : const Color(0xFFECECEF),
            color: context.deniaText,
          ),
        );
      case 'a':
        return TextSpan(
          style: style.copyWith(
            decoration: TextDecoration.underline,
            decorationColor: context.deniaMuted,
            color: context.deniaText,
          ),
          children: _children(context, node, style),
        );
      case 'br':
        return const TextSpan(text: '\n');
      case 'img':
        final alt = node.attributes['alt']?.trim();
        return TextSpan(
          text: alt == null || alt.isEmpty ? ' [图片]' : ' [图片：$alt]',
          style: style.copyWith(
            color: context.deniaMuted,
            fontStyle: FontStyle.italic,
          ),
        );
      case 'input':
        final checked = node.attributes.containsKey('checked');
        return TextSpan(text: checked ? '☑ ' : '☐ ');
      default:
        final children = node.children;
        if (children == null) {
          final text = node.textContent;
          return text.isEmpty
              ? const TextSpan()
              : TextSpan(text: text, style: style);
        }
        return TextSpan(
          style: style,
          children: _children(context, node, style),
        );
    }
  }

  List<InlineSpan> _children(
    BuildContext context,
    md.Element node,
    TextStyle style,
  ) {
    final children = node.children;
    if (children == null) return const [];
    return [for (final child in children) _inline(context, child, style)];
  }
}

class _CodeBlock extends StatefulWidget {
  const _CodeBlock({required this.element});

  final md.Element element;

  @override
  State<_CodeBlock> createState() => _CodeBlockState();
}

class _CodeBlockState extends State<_CodeBlock> {
  static const _background = Color(0xFF141417);
  static const _banner = Color(0xFF1C1C20);
  static const _border = Color(0xFF2B2B31);
  static const _text = Color(0xFFE9E9ED);
  static const _muted = Color(0xFF9C9CA5);

  Timer? _copiedTimer;
  bool _copied = false;

  @override
  void dispose() {
    _copiedTimer?.cancel();
    super.dispose();
  }

  md.Element? _findCode() {
    for (final child in widget.element.children ?? const <md.Node>[]) {
      if (child is md.Element && child.tag == 'code') return child;
    }
    return null;
  }

  static String? _languageOf(md.Element? code) {
    final className = code?.attributes['class'];
    if (className == null) return null;
    for (final part in className.split(' ')) {
      if (part.startsWith('language-') && part.length > 9) {
        return part.substring(9);
      }
    }
    return className.isEmpty ? null : className;
  }

  Future<void> _copy(String text) async {
    await Clipboard.setData(ClipboardData(text: text));
    await HapticFeedback.lightImpact();
    if (!mounted) return;
    _copiedTimer?.cancel();
    setState(() => _copied = true);
    _copiedTimer = Timer(const Duration(milliseconds: 1400), () {
      if (mounted) setState(() => _copied = false);
    });
  }

  @override
  Widget build(BuildContext context) {
    final code = _findCode();
    final language = _languageOf(code);
    final source = code?.textContent ?? widget.element.textContent;
    final trimmed = source.replaceFirst(RegExp(r'\n$'), '');
    return Container(
      width: double.infinity,
      decoration: BoxDecoration(
        color: _background,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: _border, width: 0.5),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            height: 34,
            padding: const EdgeInsets.fromLTRB(13, 0, 5, 0),
            decoration: const BoxDecoration(
              color: _banner,
              border: Border(bottom: BorderSide(color: _border, width: 0.5)),
            ),
            child: Row(
              children: [
                const Icon(Icons.terminal_rounded, size: 13, color: _muted),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    (language ?? 'code').toUpperCase(),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: 10.5,
                      height: 1.2,
                      fontWeight: FontWeight.w600,
                      letterSpacing: 0.7,
                      color: _muted,
                    ),
                  ),
                ),
                Material(
                  color: Colors.transparent,
                  borderRadius: BorderRadius.circular(8),
                  clipBehavior: Clip.antiAlias,
                  child: InkWell(
                    onTap: () => _copy(trimmed),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 7,
                        vertical: 6,
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          AnimatedSwitcher(
                            duration: const Duration(milliseconds: 140),
                            child: Icon(
                              _copied
                                  ? Icons.check_rounded
                                  : Icons.copy_rounded,
                              key: ValueKey(_copied),
                              size: 13,
                              color: _muted,
                            ),
                          ),
                          const SizedBox(width: 4),
                          Text(
                            _copied ? '已复制' : '复制',
                            style: const TextStyle(
                              fontSize: 10.5,
                              height: 1.2,
                              color: _muted,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.fromLTRB(14, 12, 14, 14),
            child: Text(
              trimmed,
              style: monoStyle(
                context,
                size: 12.5,
                color: _text,
              ).copyWith(height: 1.6, letterSpacing: 0.05),
            ),
          ),
        ],
      ),
    );
  }
}
