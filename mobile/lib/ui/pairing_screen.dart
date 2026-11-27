import 'package:flutter/services.dart';
import 'package:material_ui/material_ui.dart';

import '../core/constants.dart';
import '../core/errors.dart';
import '../models/server.dart';
import '../state/app_controller.dart';
import '../theme.dart';
import 'scanner_screen.dart';
import 'widgets/denia_logo.dart';

class PairingScreen extends StatefulWidget {
  const PairingScreen({super.key, required this.app, this.embedded = false});

  final AppController app;
  final bool embedded;

  @override
  State<PairingScreen> createState() => _PairingScreenState();
}

class _PairingScreenState extends State<PairingScreen> {
  final TextEditingController _deviceName = TextEditingController(text: '我的手机');
  bool _busy = false;
  String _busyText = '';
  String? _error;

  @override
  void dispose() {
    _deviceName.dispose();
    super.dispose();
  }

  Future<void> _scan() async {
    final link = await Navigator.of(context).push<String>(
      MaterialPageRoute<String>(builder: (_) => const ScannerScreen()),
    );
    if (link == null || !mounted) return;
    await _runPair(
      () => widget.app.pairWithLink(
        link: link,
        deviceName: _deviceName.text.trim(),
      ),
      '正在验证电脑…',
    );
  }

  Future<void> _pasteLink() async {
    final controller = TextEditingController();
    final link = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('粘贴配对链接'),
        content: TextField(
          controller: controller,
          autofocus: true,
          minLines: 2,
          maxLines: 4,
          style: const TextStyle(fontSize: 13, fontFamily: 'monospace'),
          decoration: const InputDecoration(
            hintText: 'denia://connect?v=2&p=…',
          ),
        ),
        actions: [
          TextButton(
            onPressed: () async {
              final data = await Clipboard.getData(Clipboard.kTextPlain);
              if (data?.text != null) controller.text = data!.text!.trim();
            },
            child: const Text('从剪贴板粘贴'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () {
              final text = controller.text.trim();
              if (text.isNotEmpty) Navigator.pop(context, text);
            },
            child: const Text('连接'),
          ),
        ],
      ),
    );
    if (link == null || !mounted) return;
    await _runPair(
      () => widget.app.pairWithLink(
        link: link,
        deviceName: _deviceName.text.trim(),
      ),
      '正在验证电脑…',
    );
  }

  Future<void> _manualCode() async {
    final address = TextEditingController();
    final code = TextEditingController();
    final result = await showDialog<({String address, String code})>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('输入配对码'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            TextField(
              controller: address,
              keyboardType: TextInputType.url,
              autocorrect: false,
              decoration: const InputDecoration(
                labelText: '桌面端地址',
                hintText: '192.168.1.8:43656',
              ),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: code,
              autocorrect: false,
              textCapitalization: TextCapitalization.characters,
              style: const TextStyle(
                fontFamily: 'monospace',
                letterSpacing: 1.5,
              ),
              decoration: const InputDecoration(
                labelText: '8 位配对码',
                hintText: 'ABCD-EFGH',
              ),
            ),
            const SizedBox(height: 10),
            Text(
              '桌面端「远程访问」页面会同时显示地址与配对码。跨公网请使用 https:// 地址。',
              style: TextStyle(
                fontSize: 11.5,
                height: 1.5,
                color: context.deniaMuted,
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () {
              if (address.text.trim().isEmpty || code.text.trim().isEmpty) {
                return;
              }
              Navigator.pop(context, (
                address: address.text.trim(),
                code: code.text.trim(),
              ));
            },
            child: const Text('连接'),
          ),
        ],
      ),
    );
    if (result == null || !mounted) return;
    await _runPair(
      () => widget.app.pairWithCode(
        address: result.address,
        code: result.code,
        deviceName: _deviceName.text.trim(),
      ),
      '正在兑换配对码…',
    );
  }

  Future<void> _runPair(Future<void> Function() action, String label) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _busyText = label;
      _error = null;
    });
    try {
      await action();
      if (!mounted) return;
      if (widget.app.phase == AppPhase.online) {
        setState(() => _busy = false);
        if (widget.embedded) {
          Navigator.of(context).pop();
        } else {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text('已连接到「${widget.app.activeServer?.label ?? '桌面端'}」'),
            ),
          );
        }
      } else {
        setState(() {
          _busy = false;
          _error = widget.app.lastError ?? '配对已完成，但暂时连接不上桌面端。';
        });
      }
    } on PairingException catch (error) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = error.message;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = describeFailure(error);
      });
    }
  }

  Future<void> _connectExisting(String serverId) async {
    if (_busy) return;
    if (widget.app.phase == AppPhase.authLost) {
      setState(() => _error = '这台电脑的授权已失效，请重新扫描二维码或输入新的配对码。');
      return;
    }
    setState(() {
      _busy = true;
      _busyText = '正在连接…';
    });
    await widget.app.switchServer(serverId);
    if (!mounted) return;
    setState(() {
      _busy = false;
      _error = widget.app.phase == AppPhase.online
          ? null
          : widget.app.lastError;
    });
    if (widget.embedded && widget.app.phase == AppPhase.online) {
      Navigator.of(context).pop();
    }
  }

  @override
  Widget build(BuildContext context) {
    final authLost = widget.app.phase == AppPhase.authLost;
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: context.deniaSystemUi,
      child: Scaffold(
        backgroundColor: Colors.transparent,
        appBar: widget.embedded
            ? AppBar(
                title: const Text('添加电脑'),
                centerTitle: false,
                systemOverlayStyle: context.deniaSystemUi,
              )
            : null,
        body: DeniaBackdrop(
          child: Stack(
            children: [
              SafeArea(
                child: Center(
                  child: SingleChildScrollView(
                    padding: EdgeInsets.fromLTRB(
                      24,
                      widget.embedded ? 12 : 44,
                      24,
                      32,
                    ),
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 460),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          if (!widget.embedded) ...[
                            const Center(child: DeniaLogo(size: 60)),
                            const SizedBox(height: 20),
                            const Text(
                              '连接你的 Denia',
                              textAlign: TextAlign.center,
                              style: TextStyle(
                                fontSize: 25,
                                fontWeight: FontWeight.w600,
                                letterSpacing: -0.6,
                              ),
                            ),
                            const SizedBox(height: 8),
                            Text(
                              '手机与电脑同一网络，或电脑已配置公网隧道。\n配对后即可在外面调用电脑上的 Denia。',
                              textAlign: TextAlign.center,
                              style: TextStyle(
                                fontSize: 13,
                                height: 1.6,
                                color: context.deniaMuted,
                              ),
                            ),
                            const SizedBox(height: 28),
                          ],
                          if (authLost || _error != null) ...[
                            _ErrorBanner(
                              text:
                                  _error ??
                                  widget.app.lastError ??
                                  '设备授权已失效，请重新配对。',
                            ),
                            const SizedBox(height: 14),
                          ],
                          TextField(
                            controller: _deviceName,
                            textInputAction: TextInputAction.done,
                            decoration: const InputDecoration(
                              labelText: '这台手机的名称',
                              helperText: '会显示在桌面端的设备列表里',
                            ),
                          ),
                          const SizedBox(height: 16),
                          FilledButton.icon(
                            onPressed: _busy ? null : _scan,
                            icon: const Icon(
                              Icons.qr_code_scanner_rounded,
                              size: 19,
                            ),
                            label: const Text('扫描配对二维码'),
                          ),
                          const SizedBox(height: 9),
                          Row(
                            children: [
                              Expanded(
                                child: OutlinedButton.icon(
                                  onPressed: _busy ? null : _pasteLink,
                                  icon: const Icon(
                                    Icons.link_rounded,
                                    size: 18,
                                  ),
                                  label: const Text('粘贴链接'),
                                ),
                              ),
                              const SizedBox(width: 9),
                              Expanded(
                                child: OutlinedButton.icon(
                                  onPressed: _busy ? null : _manualCode,
                                  icon: const Icon(
                                    Icons.keyboard_alt_outlined,
                                    size: 18,
                                  ),
                                  label: const Text('输入配对码'),
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: 18),
                          const _SecurityNote(),
                          if (widget.app.servers.isNotEmpty) ...[
                            const SizedBox(height: 24),
                            Text(
                              '已配对的电脑',
                              style: TextStyle(
                                fontSize: 12,
                                fontWeight: FontWeight.w600,
                                color: context.deniaMuted,
                                letterSpacing: 0.3,
                              ),
                            ),
                            const SizedBox(height: 8),
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
                                    index < widget.app.servers.length;
                                    index += 1
                                  ) ...[
                                    if (index > 0)
                                      Divider(
                                        height: 1,
                                        color: context.deniaBorder,
                                      ),
                                    _ServerTile(
                                      server: widget.app.servers[index],
                                      active:
                                          widget.app.activeServer?.serverId ==
                                          widget.app.servers[index].serverId,
                                      onTap: () => _connectExisting(
                                        widget.app.servers[index].serverId,
                                      ),
                                    ),
                                  ],
                                ],
                              ),
                            ),
                          ],
                          const SizedBox(height: 26),
                          Text(
                            'Denia Mobile v$kAppVersion',
                            textAlign: TextAlign.center,
                            style: TextStyle(
                              fontSize: 11,
                              color: context.deniaFaint,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
              if (_busy)
                Positioned.fill(
                  child: ColoredBox(
                    color: context.deniaBg.withValues(alpha: 0.72),
                    child: Center(
                      child: Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 22,
                          vertical: 18,
                        ),
                        decoration: BoxDecoration(
                          color: context.deniaSurface,
                          borderRadius: BorderRadius.circular(16),
                          border: Border.all(color: context.deniaBorder),
                        ),
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const SizedBox(
                              width: 22,
                              height: 22,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            ),
                            const SizedBox(height: 12),
                            Text(
                              _busyText,
                              style: TextStyle(
                                fontSize: 13,
                                color: context.deniaMuted,
                              ),
                            ),
                          ],
                        ),
                      ),
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

class _ServerTile extends StatelessWidget {
  const _ServerTile({
    required this.server,
    required this.active,
    required this.onTap,
  });

  final PairedServer server;
  final bool active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(14),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 11),
        child: Row(
          children: [
            Icon(Icons.computer_outlined, size: 19, color: context.deniaMuted),
            const SizedBox(width: 11),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    server.label,
                    style: const TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    server.fingerprint ?? server.activeUrl ?? server.shortId,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: monoStyle(context, size: 11),
                  ),
                ],
              ),
            ),
            if (active)
              Icon(Icons.check_circle, size: 17, color: context.deniaText)
            else
              Icon(Icons.chevron_right, size: 18, color: context.deniaFaint),
          ],
        ),
      ),
    );
  }
}

class _SecurityNote extends StatelessWidget {
  const _SecurityNote();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: context.deniaSurface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: context.deniaBorder),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.lock_outline_rounded, size: 15, color: context.deniaMuted),
          const SizedBox(width: 9),
          Expanded(
            child: Text(
              '设备令牌保存在系统安全存储中。局域网地址未加密，跨公网访问请让桌面端使用 HTTPS 隧道。',
              style: TextStyle(
                fontSize: 11.5,
                height: 1.55,
                color: context.deniaMuted,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _ErrorBanner extends StatelessWidget {
  const _ErrorBanner({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: context.deniaDanger.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: context.deniaDanger.withValues(alpha: 0.3)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.error_outline, size: 16, color: context.deniaDanger),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              text,
              style: TextStyle(
                fontSize: 12.5,
                height: 1.5,
                color: context.deniaDanger,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
