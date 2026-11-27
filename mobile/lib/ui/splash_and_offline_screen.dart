import 'package:flutter/services.dart';
import 'package:material_ui/material_ui.dart';

import '../state/app_controller.dart';
import '../theme.dart';
import 'pairing_screen.dart';
import 'widgets/denia_logo.dart';

class SplashScreen extends StatelessWidget {
  const SplashScreen({super.key, this.message});

  final String? message;

  @override
  Widget build(BuildContext context) {
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: context.deniaSystemUi,
      child: Scaffold(
        backgroundColor: Colors.transparent,
        body: DeniaBackdrop(
          child: Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const DeniaLogo(size: 64),
                const SizedBox(height: 18),
                const Text(
                  'Denia',
                  style: TextStyle(
                    fontSize: 24,
                    fontWeight: FontWeight.w600,
                    letterSpacing: -0.6,
                  ),
                ),
                const SizedBox(height: 22),
                SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(
                    strokeWidth: 1.6,
                    color: context.deniaMuted,
                  ),
                ),
                if (message != null) ...[
                  const SizedBox(height: 14),
                  Text(
                    message!,
                    style: TextStyle(fontSize: 12.5, color: context.deniaMuted),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class OfflineScreen extends StatefulWidget {
  const OfflineScreen({super.key, required this.app});

  final AppController app;

  @override
  State<OfflineScreen> createState() => _OfflineScreenState();
}

class _OfflineScreenState extends State<OfflineScreen> {
  bool _retrying = false;

  Future<void> _retry() async {
    if (_retrying) return;
    setState(() => _retrying = true);
    await widget.app.retryConnection();
    if (mounted) setState(() => _retrying = false);
  }

  @override
  Widget build(BuildContext context) {
    final server = widget.app.activeServer;
    final candidates = server?.tryOrder ?? const [];
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: context.deniaSystemUi,
      child: Scaffold(
        backgroundColor: Colors.transparent,
        body: DeniaBackdrop(
          child: SafeArea(
            child: Center(
              child: SingleChildScrollView(
                padding: const EdgeInsets.symmetric(
                  horizontal: 28,
                  vertical: 36,
                ),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 420),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      const Center(child: DeniaLogo(size: 56)),
                      const SizedBox(height: 22),
                      Text(
                        '连接不到${server == null ? '桌面端' : '「${server.label}」'}',
                        textAlign: TextAlign.center,
                        style: const TextStyle(
                          fontSize: 20,
                          fontWeight: FontWeight.w600,
                          letterSpacing: -0.3,
                        ),
                      ),
                      const SizedBox(height: 8),
                      Text(
                        widget.app.lastError ?? '请确认电脑开机、Denia 正在运行，并且远程访问已开启。',
                        textAlign: TextAlign.center,
                        style: TextStyle(
                          fontSize: 13,
                          height: 1.6,
                          color: context.deniaMuted,
                        ),
                      ),
                      const SizedBox(height: 22),
                      if (candidates.isNotEmpty)
                        Container(
                          decoration: BoxDecoration(
                            color: context.deniaSurface,
                            borderRadius: BorderRadius.circular(14),
                            border: Border.all(color: context.deniaBorder),
                          ),
                          child: Column(
                            children: [
                              for (
                                var index = 0;
                                index < candidates.length;
                                index += 1
                              ) ...[
                                if (index > 0)
                                  Divider(
                                    height: 1,
                                    color: context.deniaBorder,
                                  ),
                                Padding(
                                  padding: const EdgeInsets.symmetric(
                                    horizontal: 12,
                                    vertical: 10,
                                  ),
                                  child: Row(
                                    children: [
                                      Icon(
                                        candidates[index].isRelay
                                            ? Icons.vpn_lock_outlined
                                            : candidates[index].isTunnel
                                            ? Icons.cloud_outlined
                                            : Icons.lan_outlined,
                                        size: 16,
                                        color: context.deniaMuted,
                                      ),
                                      const SizedBox(width: 9),
                                      Expanded(
                                        child: Text(
                                          candidates[index].url.toString(),
                                          style: monoStyle(context, size: 11.5),
                                          maxLines: 1,
                                          overflow: TextOverflow.ellipsis,
                                        ),
                                      ),
                                      Text(
                                        candidates[index].displayKind,
                                        style: TextStyle(
                                          fontSize: 10.5,
                                          color: context.deniaFaint,
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                              ],
                            ],
                          ),
                        ),
                      const SizedBox(height: 20),
                      FilledButton(
                        onPressed: _retrying ? null : _retry,
                        child: _retrying
                            ? const SizedBox(
                                width: 18,
                                height: 18,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                ),
                              )
                            : const Text('重试连接'),
                      ),
                      const SizedBox(height: 8),
                      OutlinedButton(
                        onPressed: () => _showServerSheet(context),
                        child: const Text('切换或重新配对'),
                      ),
                      const SizedBox(height: 4),
                      TextButton(
                        onPressed: server == null
                            ? null
                            : () => _confirmUnpair(context, server.serverId),
                        child: Text(
                          '解除当前配对',
                          style: TextStyle(color: context.deniaMuted),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _showServerSheet(BuildContext context) async {
    final action = await showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const ListTile(
              title: Text(
                '已配对的电脑',
                style: TextStyle(fontWeight: FontWeight.w600),
              ),
            ),
            for (final server in widget.app.servers)
              ListTile(
                leading: const Icon(Icons.computer_outlined),
                title: Text(server.label),
                subtitle: Text(
                  server.fingerprint ?? server.shortId,
                  style: monoStyle(context, size: 11),
                ),
                trailing: widget.app.activeServer?.serverId == server.serverId
                    ? const Icon(Icons.check)
                    : null,
                onTap: () =>
                    Navigator.pop(context, 'switch:${server.serverId}'),
              ),
            ListTile(
              leading: const Icon(Icons.qr_code_scanner_rounded),
              title: const Text('重新配对 / 添加电脑'),
              onTap: () => Navigator.pop(context, 'pair'),
            ),
          ],
        ),
      ),
    );
    if (!context.mounted || action == null) return;
    if (action == 'pair') {
      if (context.mounted) {
        Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) => PairingScreen(app: widget.app, embedded: true),
          ),
        );
      }
    } else if (action.startsWith('switch:')) {
      await widget.app.switchServer(action.substring('switch:'.length));
    }
  }

  Future<void> _confirmUnpair(BuildContext context, String serverId) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('解除配对'),
        content: const Text('这台手机上的设备令牌会被删除，桌面端也会撤销对应设备。'),
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
    if (confirmed == true) await widget.app.unpair(serverId);
  }
}
