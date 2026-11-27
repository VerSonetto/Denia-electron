import 'package:flutter/services.dart';
import 'package:material_ui/material_ui.dart';

import '../core/format.dart';
import '../models/server.dart';
import '../models/session.dart';
import '../state/app_controller.dart';
import '../theme.dart';
import 'chat_screen.dart';
import 'pairing_screen.dart';
import 'widgets/denia_logo.dart';
import 'widgets/input_surface.dart';

class SessionsScreen extends StatefulWidget {
  const SessionsScreen({super.key, required this.app});

  final AppController app;

  @override
  State<SessionsScreen> createState() => _SessionsScreenState();
}

class _SessionsScreenState extends State<SessionsScreen> {
  bool _creating = false;
  String? _projectFilter;

  ProjectRecord? get _selectedProject {
    final id = _projectFilter;
    if (id == null) return null;
    for (final project in widget.app.projects) {
      if (project.id == id) return project;
    }
    return null;
  }

  static bool _inProject(SessionSummary session, ProjectRecord project) {
    return session.projectId == project.id ||
        project.sessionIds.contains(session.id);
  }

  ProjectRecord? _projectFor(
    SessionSummary session,
    List<ProjectRecord> projects,
  ) {
    for (final project in projects) {
      if (_inProject(session, project)) return project;
    }
    return null;
  }

  String? _modelLabel(SessionSummary session) {
    final selection = session.lastSelection;
    if (selection == null) return null;
    return widget.app.catalog?.labelOf(selection) ?? selection.model;
  }

  static String _dayBucket(DateTime time) {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final day = DateTime(time.year, time.month, time.day);
    final days = today.difference(day).inDays;
    if (days <= 0) return '今天';
    if (days == 1) return '昨天';
    if (days < 7) return '过去 7 天';
    return '更早';
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: widget.app,
      builder: (context, _) {
        final projects = widget.app.projects;
        final sessions = [...widget.app.sessions]
          ..sort((a, b) => b.sortTime.compareTo(a.sortTime));
        final selected = _selectedProject;
        final filtered = selected == null
            ? sessions
            : sessions
                  .where((session) => _inProject(session, selected))
                  .toList(growable: false);
        final projectCounts = <String, int>{};
        for (final session in sessions) {
          final project = _projectFor(session, projects);
          if (project == null) continue;
          projectCounts[project.id] = (projectCounts[project.id] ?? 0) + 1;
        }
        return AnnotatedRegion<SystemUiOverlayStyle>(
          value: context.deniaSystemUi,
          child: Scaffold(
            backgroundColor: Colors.transparent,
            floatingActionButton: FloatingActionButton.extended(
              onPressed: _creating
                  ? null
                  : () => _newSession(projectId: selected?.id),
              backgroundColor: context.deniaText,
              foregroundColor: context.deniaBg,
              elevation: 2,
              highlightElevation: 0,
              icon: _creating
                  ? SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: context.deniaBg,
                      ),
                    )
                  : const Icon(Icons.add_rounded, size: 20),
              label: const Text('新会话'),
            ),
            body: DeniaBackdrop(
              child: SafeArea(
                bottom: false,
                child: RefreshIndicator(
                  onRefresh: widget.app.refreshSessions,
                  color: context.deniaText,
                  backgroundColor: context.deniaSurface,
                  child: CustomScrollView(
                    physics: const AlwaysScrollableScrollPhysics(),
                    slivers: [
                      SliverToBoxAdapter(
                        child: _HomeHeader(
                          serverLabel: widget.app.activeServer?.label,
                          connected: widget.app.online,
                          usingRelay: widget.app.usingRelay,
                          busy: widget.app.sessionsLoading,
                          onRefresh: widget.app.refreshSessions,
                          onSettings: () => _showSettings(context),
                        ),
                      ),
                      SliverToBoxAdapter(
                        child: _HomeTitle(
                          count: filtered.length,
                          project: selected,
                        ),
                      ),
                      if (projects.length > 1)
                        SliverToBoxAdapter(
                          child: _ProjectFilterBar(
                            projects: projects,
                            counts: projectCounts,
                            allCount: sessions.length,
                            selectedId: selected?.id,
                            onSelect: (id) {
                              if (id == selected?.id) return;
                              HapticFeedback.selectionClick();
                              setState(() => _projectFilter = id);
                            },
                          ),
                        ),
                      if (widget.app.lastError != null)
                        SliverToBoxAdapter(
                          child: Padding(
                            padding: const EdgeInsets.fromLTRB(16, 10, 16, 0),
                            child: _ErrorStrip(
                              message: widget.app.lastError!,
                              onRetry: () {
                                widget.app.clearLastError();
                                widget.app.refreshSessions();
                              },
                              onClose: widget.app.clearLastError,
                            ),
                          ),
                        ),
                      ..._buildFeed(context, filtered, projects, selected),
                      const SliverToBoxAdapter(child: SizedBox(height: 112)),
                    ],
                  ),
                ),
              ),
            ),
          ),
        );
      },
    );
  }

  List<Widget> _buildFeed(
    BuildContext context,
    List<SessionSummary> sessions,
    List<ProjectRecord> projects,
    ProjectRecord? selected,
  ) {
    if (widget.app.sessionsLoading && widget.app.sessions.isEmpty) {
      return const [
        SliverFillRemaining(
          hasScrollBody: false,
          child: Padding(
            padding: EdgeInsets.only(bottom: 80),
            child: Center(
              child: SizedBox(
                width: 22,
                height: 22,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
            ),
          ),
        ),
      ];
    }
    if (sessions.isEmpty) {
      return [
        SliverFillRemaining(
          hasScrollBody: false,
          child: _HomeEmpty(
            project: selected,
            onCreate: () => _newSession(projectId: selected?.id),
          ),
        ),
      ];
    }

    final buckets = <String, List<SessionSummary>>{};
    for (final session in sessions) {
      buckets.putIfAbsent(_dayBucket(session.sortTime), () => []).add(session);
    }
    final rows = <_FeedRow>[];
    for (final entry in buckets.entries) {
      rows.add(_DayFeedRow(label: entry.key, count: entry.value.length));
      for (final session in entry.value) {
        final project = _projectFor(session, projects);
        rows.add(
          _SessionFeedRow(
            session: session,
            running: widget.app.isRunning(session.id),
            projectLabel:
                project?.title ??
                (session.cwdName.isEmpty ? '默认项目' : session.cwdName),
            modelLabel: _modelLabel(session),
          ),
        );
      }
    }
    return [
      SliverPadding(
        padding: const EdgeInsets.only(top: 6),
        sliver: SliverList(
          delegate: SliverChildBuilderDelegate(
            (context, index) {
              final row = rows[index];
              if (row is _DayFeedRow) {
                return _DayHeader(label: row.label, count: row.count);
              }
              final sessionRow = row as _SessionFeedRow;
              return _SessionCard(
                key: ValueKey('home-session-${sessionRow.session.id}'),
                session: sessionRow.session,
                running: sessionRow.running,
                projectLabel: sessionRow.projectLabel,
                modelLabel: sessionRow.modelLabel,
                onTap: () => _openChat(context, sessionRow.session),
                onActions: () =>
                    _showSessionActions(context, sessionRow.session),
              );
            },
            childCount: rows.length,
            addAutomaticKeepAlives: false,
          ),
        ),
      ),
    ];
  }

  Future<void> _openChat(BuildContext context, SessionSummary session) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => ChatScreen(app: widget.app, summary: session),
      ),
    );
    await widget.app.refreshSessions();
  }

  Future<void> _newSession({String? projectId}) async {
    if (_creating) return;
    final projects = widget.app.projects;
    if (projectId == null && projects.length > 1) {
      projectId = await showModalBottomSheet<String>(
        context: context,
        showDragHandle: true,
        builder: (context) => SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Padding(
                padding: EdgeInsets.fromLTRB(20, 4, 20, 10),
                child: Text(
                  '在哪个项目里新建会话？',
                  style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
                ),
              ),
              Flexible(
                child: ListView(
                  shrinkWrap: true,
                  children: [
                    for (final project in projects)
                      ListTile(
                        leading: Icon(
                          project.isDefault
                              ? Icons.home_outlined
                              : Icons.folder_outlined,
                        ),
                        title: Text(project.title),
                        subtitle: Text(
                          project.dirs.isEmpty ? '托管目录' : project.dirs.first,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontSize: 11.5),
                        ),
                        onTap: () => Navigator.pop(context, project.id),
                      ),
                  ],
                ),
              ),
            ],
          ),
        ),
      );
      if (projectId == null || !mounted) return;
    } else {
      projectId ??= widget.app.defaultProject?.id;
    }
    setState(() => _creating = true);
    final session = await widget.app.createSession(projectId: projectId);
    if (!mounted) return;
    setState(() => _creating = false);
    if (session == null) {
      final message = widget.app.lastError ?? '新建会话失败';
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(message)));
      return;
    }
    await _openChat(context, session);
  }

  Future<void> _showSessionActions(
    BuildContext context,
    SessionSummary session,
  ) async {
    final confirmed = await showModalBottomSheet<bool>(
      context: context,
      showDragHandle: true,
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              title: Text(
                session.displayTitle,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontWeight: FontWeight.w600),
              ),
              subtitle: Text(
                session.shortId,
                style: monoStyle(context, size: 11),
              ),
            ),
            const Divider(height: 1),
            ListTile(
              leading: Icon(Icons.delete_outline, color: context.deniaDanger),
              title: Text('删除会话', style: TextStyle(color: context.deniaDanger)),
              subtitle: const Text('会话日志会从电脑上删除，无法恢复'),
              onTap: () => Navigator.pop(context, true),
            ),
          ],
        ),
      ),
    );
    if (confirmed != true || !context.mounted) return;
    final ok = await widget.app.deleteSession(session.id);
    if (!context.mounted) return;
    if (!ok) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(widget.app.lastError ?? '删除失败')));
    }
  }

  Future<void> _showSettings(BuildContext context) async {
    final action = await showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      builder: (context) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(20, 2, 20, 8),
              child: Text(
                '电脑',
                style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
              ),
            ),
            for (final server in widget.app.servers)
              ListTile(
                leading: Icon(
                  widget.app.activeServer?.serverId == server.serverId
                      ? Icons.computer_rounded
                      : Icons.computer_outlined,
                ),
                title: Text(server.label),
                subtitle: Text(
                  server.fingerprint ?? server.shortId,
                  style: monoStyle(context, size: 11),
                ),
                trailing: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (widget.app.activeServer?.serverId == server.serverId)
                      Icon(Icons.check, size: 18, color: context.deniaMuted),
                    IconButton(
                      tooltip: '解除配对',
                      onPressed: () =>
                          Navigator.pop(context, 'unpair:${server.serverId}'),
                      icon: Icon(
                        Icons.link_off_rounded,
                        size: 18,
                        color: context.deniaMuted,
                      ),
                    ),
                  ],
                ),
                onTap: () =>
                    Navigator.pop(context, 'switch:${server.serverId}'),
              ),
            ListTile(
              leading: const Icon(Icons.add_link_rounded),
              title: const Text('添加电脑'),
              onTap: () => Navigator.pop(context, 'add'),
            ),
            const Divider(height: 1),
            ListTile(
              leading: const Icon(Icons.info_outline),
              title: const Text('关于 Denia'),
              subtitle: const Text('Android 远程客户端'),
              onTap: () => Navigator.pop(context, 'about'),
            ),
          ],
        ),
      ),
    );
    if (!context.mounted || action == null) return;
    if (action == 'add') {
      if (context.mounted) {
        await Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) => PairingScreen(app: widget.app, embedded: true),
          ),
        );
      }
    } else if (action == 'about') {
      if (context.mounted) await _showAbout(context);
    } else if (action.startsWith('switch:')) {
      await widget.app.switchServer(action.substring('switch:'.length));
    } else if (action.startsWith('unpair:')) {
      await _confirmUnpair(context, action.substring('unpair:'.length));
    }
  }

  Future<void> _confirmUnpair(BuildContext context, String serverId) async {
    PairedServer? server;
    for (final entry in widget.app.servers) {
      if (entry.serverId == serverId) {
        server = entry;
        break;
      }
    }
    if (server == null) return;
    final target = server;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('解除与「${target.label}」的配对？'),
        content: const Text('这台手机上的令牌会被删除，电脑端也会撤销该设备。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            style: FilledButton.styleFrom(backgroundColor: context.deniaDanger),
            child: const Text('解除'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    await widget.app.unpair(serverId);
  }

  Future<void> _showAbout(BuildContext context) async {
    await showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        title: Row(
          children: const [
            DeniaLogo(size: 28, radius: 9),
            SizedBox(width: 10),
            Text('Denia Mobile'),
          ],
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '在手机上远程调用电脑上的 Denia 代理。会话、模型、工具与审批都留在桌面端，手机负责查看与确认。',
              style: TextStyle(
                fontSize: 13,
                height: 1.6,
                color: context.deniaMuted,
              ),
            ),
            const SizedBox(height: 12),
            Text('版本 0.1.0', style: monoStyle(context, size: 11.5)),
            const SizedBox(height: 4),
            Text('协议：REMOTE-ACCESS v2', style: monoStyle(context, size: 11.5)),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('好'),
          ),
        ],
      ),
    );
  }
}

class _HomeHeader extends StatelessWidget {
  const _HomeHeader({
    required this.serverLabel,
    required this.connected,
    required this.usingRelay,
    required this.busy,
    required this.onRefresh,
    required this.onSettings,
  });

  final String? serverLabel;
  final bool connected;
  final bool usingRelay;
  final bool busy;
  final VoidCallback onRefresh;
  final VoidCallback onSettings;

  @override
  Widget build(BuildContext context) {
    final statusColor = connected ? context.deniaMuted : context.deniaDanger;
    final statusDot = connected ? context.deniaSuccess : context.deniaDanger;
    final mode = usingRelay ? '私有中继' : '远程';
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 10, 16, 0),
      child: Row(
        children: [
          const DeniaLogo(size: 28, radius: 9),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                const Text(
                  'Denia',
                  style: TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w600,
                    letterSpacing: -0.2,
                    height: 1.2,
                  ),
                ),
                const SizedBox(height: 3),
                Row(
                  children: [
                    Container(
                      width: 5,
                      height: 5,
                      decoration: BoxDecoration(
                        color: statusDot,
                        shape: BoxShape.circle,
                      ),
                    ),
                    const SizedBox(width: 6),
                    Expanded(
                      child: Text(
                        serverLabel == null ? '未连接' : '$serverLabel · $mode',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 10.5,
                          height: 1.2,
                          color: statusColor,
                        ),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
          _HomeAction(
            icon: Icons.refresh_rounded,
            tooltip: '刷新',
            busy: busy,
            onTap: busy ? null : onRefresh,
          ),
          const SizedBox(width: 8),
          _HomeAction(
            icon: Icons.tune_rounded,
            tooltip: '电脑与设置',
            onTap: onSettings,
          ),
        ],
      ),
    );
  }
}

class _HomeAction extends StatelessWidget {
  const _HomeAction({
    required this.icon,
    required this.tooltip,
    required this.onTap,
    this.busy = false,
  });

  final IconData icon;
  final String tooltip;
  final VoidCallback? onTap;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: tooltip,
      child: SizedBox(
        width: 40,
        height: 40,
        child: InputSurface(
          radius: 20,
          child: Material(
            color: Colors.transparent,
            borderRadius: BorderRadius.circular(20),
            clipBehavior: Clip.antiAlias,
            child: InkWell(
              onTap: onTap,
              child: Center(
                child: busy
                    ? SizedBox(
                        width: 15,
                        height: 15,
                        child: CircularProgressIndicator(
                          strokeWidth: 1.8,
                          color: context.deniaMuted,
                        ),
                      )
                    : Icon(icon, size: 19, color: context.deniaMuted),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _HomeTitle extends StatelessWidget {
  const _HomeTitle({required this.count, required this.project});

  final int count;
  final ProjectRecord? project;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 26, 16, 0),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  project?.title ?? '会话',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 30,
                    height: 1.08,
                    fontWeight: FontWeight.w600,
                    letterSpacing: -1.1,
                  ),
                ),
                const SizedBox(height: 5),
                Text(
                  project == null ? '继续电脑上的工作' : '这个项目里的会话',
                  style: TextStyle(
                    fontSize: 11.5,
                    height: 1.3,
                    color: context.deniaMuted,
                  ),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.only(bottom: 2),
            child: Text(
              '$count 个',
              style: TextStyle(
                fontSize: 10.5,
                color: context.deniaFaint,
                fontFeatures: const [FontFeature.tabularFigures()],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _ProjectFilterBar extends StatelessWidget {
  const _ProjectFilterBar({
    required this.projects,
    required this.counts,
    required this.allCount,
    required this.selectedId,
    required this.onSelect,
  });

  final List<ProjectRecord> projects;
  final Map<String, int> counts;
  final int allCount;
  final String? selectedId;
  final ValueChanged<String?> onSelect;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 14),
      child: SizedBox(
        height: 32,
        child: ListView.separated(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.symmetric(horizontal: 16),
          itemCount: projects.length + 1,
          separatorBuilder: (_, _) => const SizedBox(width: 6),
          itemBuilder: (context, index) {
            if (index == 0) {
              return _ProjectChip(
                label: '全部',
                count: allCount,
                selected: selectedId == null,
                onTap: () => onSelect(null),
              );
            }
            final project = projects[index - 1];
            return _ProjectChip(
              label: project.title,
              count: counts[project.id] ?? 0,
              selected: selectedId == project.id,
              onTap: () => onSelect(project.id),
            );
          },
        ),
      ),
    );
  }
}

class _ProjectChip extends StatelessWidget {
  const _ProjectChip({
    required this.label,
    required this.count,
    required this.selected,
    required this.onTap,
  });

  final String label;
  final int count;
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
          padding: const EdgeInsets.symmetric(horizontal: 11),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                label,
                style: TextStyle(
                  fontSize: 11.5,
                  fontWeight: FontWeight.w500,
                  color: selected ? context.deniaBg : context.deniaMuted,
                ),
              ),
              const SizedBox(width: 5),
              Text(
                '$count',
                style: TextStyle(
                  fontSize: 9.5,
                  color: selected
                      ? context.deniaBg.withValues(alpha: 0.62)
                      : context.deniaFaint,
                  fontFeatures: const [FontFeature.tabularFigures()],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

sealed class _FeedRow {}

class _DayFeedRow extends _FeedRow {
  _DayFeedRow({required this.label, required this.count});

  final String label;
  final int count;
}

class _SessionFeedRow extends _FeedRow {
  _SessionFeedRow({
    required this.session,
    required this.running,
    required this.projectLabel,
    required this.modelLabel,
  });

  final SessionSummary session;
  final bool running;
  final String projectLabel;
  final String? modelLabel;
}

class _DayHeader extends StatelessWidget {
  const _DayHeader({required this.label, required this.count});

  final String label;
  final int count;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
      child: Row(
        children: [
          Text(
            label,
            style: TextStyle(
              fontSize: 11.5,
              fontWeight: FontWeight.w600,
              letterSpacing: 0.2,
              color: context.deniaMuted,
            ),
          ),
          const SizedBox(width: 9),
          Expanded(
            child: Divider(
              height: 0.5,
              color: context.deniaBorder.withValues(alpha: 0.65),
            ),
          ),
          const SizedBox(width: 9),
          Text(
            '$count',
            style: TextStyle(
              fontSize: 9.5,
              color: context.deniaFaint,
              fontFeatures: const [FontFeature.tabularFigures()],
            ),
          ),
        ],
      ),
    );
  }
}

class _SessionCard extends StatelessWidget {
  const _SessionCard({
    super.key,
    required this.session,
    required this.running,
    required this.projectLabel,
    required this.modelLabel,
    required this.onTap,
    required this.onActions,
  });

  final SessionSummary session;
  final bool running;
  final String projectLabel;
  final String? modelLabel;
  final VoidCallback onTap;
  final VoidCallback onActions;

  @override
  Widget build(BuildContext context) {
    final excerpt = session.excerpt?.trim().replaceAll(RegExp(r'\s+'), ' ');
    final hasExcerpt = excerpt != null && excerpt.isNotEmpty;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
      child: Material(
        color: context.deniaSurface,
        borderRadius: BorderRadius.circular(18),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: Container(
            padding: const EdgeInsets.fromLTRB(14, 13, 10, 9),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(18),
              border: Border.all(
                color: context.deniaBorder.withValues(alpha: 0.85),
                width: 0.5,
              ),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    if (running) ...[
                      Container(
                        width: 6,
                        height: 6,
                        decoration: BoxDecoration(
                          color: context.deniaSuccess,
                          shape: BoxShape.circle,
                        ),
                      ),
                      const SizedBox(width: 7),
                    ],
                    Expanded(
                      child: Text(
                        session.displayTitle,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w600,
                          height: 1.3,
                          letterSpacing: -0.15,
                        ),
                      ),
                    ),
                    const SizedBox(width: 10),
                    if (running)
                      Text(
                        '运行中',
                        style: TextStyle(
                          fontSize: 10.5,
                          color: context.deniaSuccess,
                        ),
                      )
                    else
                      Text(
                        relativeTime(session.sortTime),
                        style: TextStyle(
                          fontSize: 10.5,
                          color: context.deniaFaint,
                        ),
                      ),
                  ],
                ),
                const SizedBox(height: 4),
                Text(
                  hasExcerpt ? excerpt : '还没有消息',
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 12.5,
                    height: 1.5,
                    color: hasExcerpt ? context.deniaMuted : context.deniaFaint,
                  ),
                ),
                const SizedBox(height: 8),
                Row(
                  children: [
                    Expanded(
                      child: Row(
                        children: [
                          Icon(
                            Icons.folder_outlined,
                            size: 12,
                            color: context.deniaFaint,
                          ),
                          const SizedBox(width: 4),
                          Flexible(
                            child: Text(
                              projectLabel,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                fontSize: 10.5,
                                color: context.deniaFaint,
                              ),
                            ),
                          ),
                          if (modelLabel != null) ...[
                            const SizedBox(width: 12),
                            Icon(
                              Icons.auto_awesome,
                              size: 11,
                              color: context.deniaFaint,
                            ),
                            const SizedBox(width: 4),
                            Flexible(
                              child: Text(
                                modelLabel!,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                  fontSize: 10.5,
                                  color: context.deniaFaint,
                                ),
                              ),
                            ),
                          ],
                        ],
                      ),
                    ),
                    SizedBox(
                      width: 28,
                      height: 28,
                      child: IconButton(
                        tooltip: '会话操作',
                        padding: EdgeInsets.zero,
                        constraints: const BoxConstraints.tightFor(
                          width: 28,
                          height: 28,
                        ),
                        visualDensity: VisualDensity.compact,
                        onPressed: onActions,
                        icon: Icon(
                          Icons.more_horiz_rounded,
                          size: 17,
                          color: context.deniaFaint,
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
    );
  }
}

class _HomeEmpty extends StatelessWidget {
  const _HomeEmpty({required this.project, required this.onCreate});

  final ProjectRecord? project;
  final VoidCallback onCreate;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(32, 48, 32, 120),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Container(
            width: 54,
            height: 54,
            decoration: BoxDecoration(
              color: context.deniaSurface,
              borderRadius: BorderRadius.circular(18),
              border: Border.all(
                color: context.deniaBorder.withValues(alpha: 0.85),
                width: 0.5,
              ),
            ),
            child: Icon(
              project == null
                  ? Icons.chat_bubble_outline_rounded
                  : Icons.folder_open_rounded,
              size: 23,
              color: context.deniaMuted,
            ),
          ),
          const SizedBox(height: 16),
          Text(
            project == null ? '还没有会话' : '${project!.title} 还没有会话',
            textAlign: TextAlign.center,
            style: const TextStyle(
              fontSize: 17,
              fontWeight: FontWeight.w600,
              letterSpacing: -0.2,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            project == null ? '在电脑上的项目里开始第一段工作。' : '在这个项目里开始第一段工作。',
            textAlign: TextAlign.center,
            style: TextStyle(
              fontSize: 12.5,
              height: 1.55,
              color: context.deniaMuted,
            ),
          ),
          const SizedBox(height: 18),
          FilledButton.icon(
            onPressed: onCreate,
            icon: const Icon(Icons.add_rounded, size: 18),
            label: const Text('新建会话'),
          ),
        ],
      ),
    );
  }
}

class _ErrorStrip extends StatelessWidget {
  const _ErrorStrip({
    required this.message,
    required this.onRetry,
    required this.onClose,
  });

  final String message;
  final VoidCallback onRetry;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 8, 4, 8),
      decoration: BoxDecoration(
        color: context.deniaDanger.withValues(alpha: 0.07),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: context.deniaDanger.withValues(alpha: 0.25)),
      ),
      child: Row(
        children: [
          Expanded(
            child: Text(
              message,
              style: TextStyle(
                fontSize: 12,
                color: context.deniaDanger,
                height: 1.4,
              ),
            ),
          ),
          IconButton(
            tooltip: '重试',
            visualDensity: VisualDensity.compact,
            onPressed: onRetry,
            icon: const Icon(Icons.refresh_rounded, size: 17),
          ),
          IconButton(
            tooltip: '关闭',
            visualDensity: VisualDensity.compact,
            onPressed: onClose,
            icon: const Icon(Icons.close_rounded, size: 16),
          ),
        ],
      ),
    );
  }
}
