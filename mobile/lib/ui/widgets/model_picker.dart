import 'dart:math';

import 'package:flutter/services.dart';
import 'package:material_ui/material_ui.dart';

import '../../core/format.dart';
import '../../models/session.dart';
import '../../theme.dart';
import 'input_surface.dart';

String _effortLabel(String id) {
  return switch (id) {
    'off' => '关闭',
    'low' => '低',
    'medium' => '中',
    'high' => '高',
    'xhigh' => '极高',
    'max' => '最高',
    _ => id,
  };
}

String _defaultEffort(ModelOption model) {
  if (model.efforts.isEmpty) return '';
  final preferred = model.defaultEffort;
  if (preferred != null && model.efforts.contains(preferred)) return preferred;
  return model.efforts.first;
}

/// A single-panel model picker: search, provider filters, current model first,
/// and inline thinking-effort chips. Picking a model with more than one effort
/// reveals its chips instead of closing; picking a chip commits both.
Future<ModelChoice?> showModelPicker({
  required BuildContext context,
  required ModelCatalog catalog,
  ModelChoice? current,
}) {
  return showModalBottomSheet<ModelChoice>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: Colors.transparent,
    barrierColor: Colors.black.withValues(alpha: 0.44),
    builder: (sheetContext) {
      final insets = MediaQuery.viewInsetsOf(sheetContext).bottom;
      final screen = MediaQuery.sizeOf(sheetContext).height;
      final available = screen - insets - 24;
      final height = min(screen * 0.88, max(260.0, available));
      return AnimatedPadding(
        duration: const Duration(milliseconds: 160),
        curve: Curves.easeOut,
        padding: EdgeInsets.only(bottom: insets),
        child: SizedBox(
          height: height,
          child: _ModelPickerSheet(catalog: catalog, current: current),
        ),
      );
    },
  );
}

class _ModelPickerSheet extends StatefulWidget {
  const _ModelPickerSheet({required this.catalog, required this.current});

  final ModelCatalog catalog;
  final ModelChoice? current;

  @override
  State<_ModelPickerSheet> createState() => _ModelPickerSheetState();
}

class _ModelPickerSheetState extends State<_ModelPickerSheet> {
  late final TextEditingController _search;
  String _query = '';
  String? _provider;
  String? _expandedKey;

  @override
  void initState() {
    super.initState();
    _search = TextEditingController();
    _expandedKey = _keyOf(widget.current);
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  static String _keyOf(ModelChoice? choice) {
    return choice == null ? '' : '${choice.provider}/${choice.model}';
  }

  List<ModelGroup> get _baseGroups {
    return widget.catalog.groups
        .where((group) => group.models.isNotEmpty)
        .toList(growable: false);
  }

  bool _matches(ModelGroup group, ModelOption model) {
    final q = _query.trim().toLowerCase();
    if (q.isEmpty) return true;
    return group.name.toLowerCase().contains(q) ||
        group.id.toLowerCase().contains(q) ||
        model.name.toLowerCase().contains(q) ||
        model.id.toLowerCase().contains(q) ||
        (model.description ?? '').toLowerCase().contains(q);
  }

  List<ModelGroup> get _visibleGroups {
    final q = _query.trim();
    var groups = _baseGroups;
    if (_provider != null) {
      groups = groups.where((group) => group.id == _provider).toList();
    }
    if (q.isEmpty) {
      if (_provider == null && widget.current != null) {
        final index = groups.indexWhere(
          (group) => group.id == widget.current!.provider,
        );
        if (index > 0) {
          final current = groups.removeAt(index);
          groups = [current, ...groups];
        }
      }
      return [
        for (final group in groups)
          ModelGroup(
            id: group.id,
            name: group.name,
            models: _currentFirst(group),
          ),
      ];
    }

    return [
      for (final group in groups)
        if (group.models.any((model) => _matches(group, model)))
          ModelGroup(
            id: group.id,
            name: group.name,
            models: _currentFirst(
              group,
              filter: (model) => _matches(group, model),
            ),
          ),
    ];
  }

  List<ModelOption> _currentFirst(
    ModelGroup group, {
    bool Function(ModelOption model)? filter,
  }) {
    final models = group.models
        .where((model) => filter == null || filter(model))
        .toList();
    final selected = widget.current;
    if (selected != null && selected.provider == group.id) {
      final index = models.indexWhere((model) => model.id == selected.model);
      if (index > 0) {
        final current = models.removeAt(index);
        models.insert(0, current);
      }
    }
    return models;
  }

  String _effortFor(String provider, ModelOption model) {
    final selected = widget.current;
    if (selected != null &&
        selected.provider == provider &&
        selected.model == model.id) {
      final effort = selected.reasoningEffort;
      if (effort != null && model.efforts.contains(effort)) return effort;
    }
    return _defaultEffort(model);
  }

  void _pick(String provider, ModelOption model, String? effort) {
    HapticFeedback.selectionClick();
    Navigator.of(context).pop(
      ModelChoice(provider: provider, model: model.id, reasoningEffort: effort),
    );
  }

  void _onModelTap(String provider, ModelOption model) {
    final efforts = model.efforts;
    if (efforts.isEmpty) {
      _pick(provider, model, null);
      return;
    }
    if (efforts.length == 1) {
      _pick(provider, model, efforts.first);
      return;
    }
    final key = '$provider/${model.id}';
    setState(() {
      _expandedKey = _expandedKey == key ? null : key;
    });
  }

  void _clearSearch() {
    _search.clear();
    setState(() => _query = '');
  }

  @override
  Widget build(BuildContext context) {
    final groups = _baseGroups;
    final visibleGroups = _visibleGroups;
    final showHeaders = _query.trim().isEmpty && visibleGroups.length > 1;
    final rows = <Widget>[];
    for (final group in visibleGroups) {
      if (showHeaders) {
        rows.add(
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 12, 20, 3),
            child: Text(
              group.name.toUpperCase(),
              style: TextStyle(
                fontSize: 10,
                fontWeight: FontWeight.w600,
                letterSpacing: 0.8,
                color: context.deniaMuted,
              ),
            ),
          ),
        );
      }
      for (final model in group.models) {
        final key = '${group.id}/${model.id}';
        final selected =
            widget.current?.provider == group.id &&
            widget.current?.model == model.id;
        rows.add(
          _ModelTile(
            model: model,
            providerName: group.name,
            selected: selected,
            expanded: _expandedKey == key && model.efforts.length > 1,
            effort: _effortFor(group.id, model),
            showProvider: !showHeaders,
            onTap: () => _onModelTap(group.id, model),
            onEffort: (effort) => _pick(group.id, model, effort),
          ),
        );
      }
    }

    return Container(
      decoration: BoxDecoration(
        color: context.deniaBg,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
      ),
      clipBehavior: Clip.antiAlias,
      child: SafeArea(
        top: false,
        child: Column(
          children: [
            Container(
              width: 36,
              height: 4,
              margin: const EdgeInsets.only(top: 9, bottom: 4),
              decoration: BoxDecoration(
                color: context.deniaMuted.withValues(alpha: 0.35),
                borderRadius: BorderRadius.circular(2),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 10, 8),
              child: Row(
                children: [
                  const Expanded(
                    child: Text(
                      '选择模型',
                      style: TextStyle(
                        fontSize: 18,
                        fontWeight: FontWeight.w600,
                        letterSpacing: -0.2,
                      ),
                    ),
                  ),
                  IconButton(
                    tooltip: '关闭',
                    visualDensity: VisualDensity.compact,
                    onPressed: () => Navigator.of(context).pop(),
                    icon: Icon(
                      Icons.close_rounded,
                      size: 20,
                      color: context.deniaMuted,
                    ),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: InputSurface(
                radius: 14,
                child: TextField(
                  controller: _search,
                  onChanged: (value) => setState(() => _query = value),
                  textInputAction: TextInputAction.search,
                  style: const TextStyle(fontSize: 14),
                  decoration: InputDecoration(
                    isDense: true,
                    filled: false,
                    border: InputBorder.none,
                    enabledBorder: InputBorder.none,
                    focusedBorder: InputBorder.none,
                    hintText: '搜索模型或提供商',
                    prefixIcon: Icon(
                      Icons.search_rounded,
                      size: 19,
                      color: context.deniaMuted,
                    ),
                    prefixIconConstraints: const BoxConstraints(
                      minWidth: 38,
                      minHeight: 38,
                    ),
                    suffixIcon: _query.isEmpty
                        ? null
                        : IconButton(
                            tooltip: '清空',
                            onPressed: _clearSearch,
                            icon: Icon(
                              Icons.close_rounded,
                              size: 17,
                              color: context.deniaMuted,
                            ),
                          ),
                    suffixIconConstraints: const BoxConstraints(
                      minWidth: 36,
                      minHeight: 36,
                    ),
                    contentPadding: const EdgeInsets.fromLTRB(0, 11, 8, 11),
                  ),
                ),
              ),
            ),
            if (groups.length > 1) ...[
              const SizedBox(height: 10),
              SizedBox(
                height: 32,
                child: ListView.separated(
                  scrollDirection: Axis.horizontal,
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  itemCount: groups.length + 1,
                  separatorBuilder: (_, _) => const SizedBox(width: 6),
                  itemBuilder: (context, index) {
                    final group = index == 0 ? null : groups[index - 1];
                    return _ProviderChip(
                      label: group?.name ?? '全部',
                      selected: _provider == group?.id,
                      onTap: () => setState(() => _provider = group?.id),
                    );
                  },
                ),
              ),
            ],
            const SizedBox(height: 4),
            Expanded(
              child: rows.isEmpty
                  ? _EmptyModels(query: _query)
                  : ListView(
                      keyboardDismissBehavior:
                          ScrollViewKeyboardDismissBehavior.onDrag,
                      padding: const EdgeInsets.only(bottom: 24),
                      children: rows,
                    ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ProviderChip extends StatelessWidget {
  const _ProviderChip({
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: selected ? context.deniaText : Colors.transparent,
      shape: StadiumBorder(
        side: BorderSide(
          color: selected ? Colors.transparent : context.deniaBorder,
          width: 0.5,
        ),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 7),
          child: Text(
            label,
            style: TextStyle(
              fontSize: 11.5,
              fontWeight: FontWeight.w500,
              color: selected ? context.deniaBg : context.deniaMuted,
            ),
          ),
        ),
      ),
    );
  }
}

class _ModelTile extends StatelessWidget {
  const _ModelTile({
    required this.model,
    required this.providerName,
    required this.selected,
    required this.expanded,
    required this.effort,
    required this.showProvider,
    required this.onTap,
    required this.onEffort,
  });

  final ModelOption model;
  final String providerName;
  final bool selected;
  final bool expanded;
  final String effort;
  final bool showProvider;
  final VoidCallback onTap;
  final ValueChanged<String> onEffort;

  @override
  Widget build(BuildContext context) {
    final description = model.description?.trim() ?? '';
    final details = [
      if (showProvider) providerName,
      if (description.isNotEmpty) description,
      if (model.contextWindow != null)
        '${compactNumber(model.contextWindow)} 上下文',
      if (model.efforts.isNotEmpty)
        '思考 ${_effortLabel(effort.isEmpty ? (model.defaultEffort ?? model.efforts.first) : effort)}',
    ].join(' · ');

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 2),
      child: Material(
        color: expanded ? context.deniaSurface : Colors.transparent,
        borderRadius: BorderRadius.circular(14),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 160),
            curve: Curves.easeOut,
            padding: const EdgeInsets.fromLTRB(12, 10, 10, 10),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(14),
              border: Border.all(
                color: expanded
                    ? context.deniaBorder
                    : selected
                    ? context.deniaBorder.withValues(alpha: 0.5)
                    : Colors.transparent,
                width: 0.5,
              ),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        model.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 13.5,
                          fontWeight: selected
                              ? FontWeight.w600
                              : FontWeight.w500,
                          letterSpacing: -0.1,
                        ),
                      ),
                    ),
                    if (selected)
                      Padding(
                        padding: const EdgeInsets.only(left: 6),
                        child: Icon(
                          Icons.check_rounded,
                          size: 16,
                          color: context.deniaText,
                        ),
                      ),
                    if (model.efforts.length > 1)
                      Padding(
                        padding: const EdgeInsets.only(left: 3),
                        child: AnimatedRotation(
                          turns: expanded ? 0.5 : 0,
                          duration: const Duration(milliseconds: 160),
                          child: Icon(
                            Icons.expand_more_rounded,
                            size: 17,
                            color: context.deniaMuted,
                          ),
                        ),
                      ),
                  ],
                ),
                if (details.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Text(
                      details,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 10.8,
                        height: 1.35,
                        color: context.deniaMuted,
                      ),
                    ),
                  ),
                AnimatedSize(
                  duration: const Duration(milliseconds: 160),
                  curve: Curves.easeOut,
                  alignment: Alignment.topCenter,
                  child: expanded
                      ? Padding(
                          padding: const EdgeInsets.only(top: 9),
                          child: Row(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Padding(
                                padding: const EdgeInsets.only(top: 6),
                                child: Text(
                                  '思考强度',
                                  style: TextStyle(
                                    fontSize: 10.5,
                                    color: context.deniaMuted,
                                  ),
                                ),
                              ),
                              const SizedBox(width: 9),
                              Expanded(
                                child: Wrap(
                                  spacing: 6,
                                  runSpacing: 6,
                                  children: [
                                    for (final level in model.efforts)
                                      _EffortChip(
                                        label: _effortLabel(level),
                                        selected: level == effort,
                                        onTap: () => onEffort(level),
                                      ),
                                  ],
                                ),
                              ),
                            ],
                          ),
                        )
                      : const SizedBox.shrink(),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _EffortChip extends StatelessWidget {
  const _EffortChip({
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: selected ? context.deniaText : context.deniaBg,
      shape: StadiumBorder(
        side: BorderSide(
          color: selected ? Colors.transparent : context.deniaBorder,
          width: 0.5,
        ),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
          child: Text(
            label,
            style: TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w500,
              color: selected ? context.deniaBg : context.deniaText,
            ),
          ),
        ),
      ),
    );
  }
}

class _EmptyModels extends StatelessWidget {
  const _EmptyModels({required this.query});

  final String query;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 42, 24, 24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.search_off_rounded, size: 26, color: context.deniaMuted),
          const SizedBox(height: 10),
          Text(
            query.trim().isEmpty ? '没有可用模型' : '没有匹配的模型',
            style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w500),
          ),
          const SizedBox(height: 4),
          Text(
            query.trim().isEmpty ? '请在电脑端检查模型目录' : '换一个关键词或提供商试试',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 11.5, color: context.deniaMuted),
          ),
        ],
      ),
    );
  }
}
