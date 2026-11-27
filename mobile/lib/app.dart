import 'package:material_ui/material_ui.dart';

import 'state/app_controller.dart';
import 'ui/pairing_screen.dart';
import 'ui/sessions_screen.dart';
import 'ui/splash_and_offline_screen.dart';

class AppShell extends StatelessWidget {
  const AppShell({super.key, required this.app});

  final AppController app;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: app,
      builder: (context, _) {
        final Widget child = switch (app.phase) {
          AppPhase.booting => const SplashScreen(message: '正在读取安全存储…'),
          AppPhase.unpaired => PairingScreen(app: app),
          AppPhase.authLost => PairingScreen(app: app),
          AppPhase.offline => OfflineScreen(app: app),
          AppPhase.connecting => SplashScreen(
            message:
                '正在连接${app.activeServer == null ? '桌面端' : '「${app.activeServer!.label}」'}…',
          ),
          AppPhase.online => SessionsScreen(app: app),
        };
        return AnimatedSwitcher(
          duration: const Duration(milliseconds: 220),
          switchInCurve: Curves.easeOut,
          switchOutCurve: Curves.easeIn,
          child: KeyedSubtree(key: ValueKey(app.phase), child: child),
        );
      },
    );
  }
}
