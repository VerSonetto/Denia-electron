import 'dart:async';

import 'package:material_ui/material_ui.dart';

import 'app.dart';
import 'data/key_value_store.dart';
import 'data/server_repository.dart';
import 'state/app_controller.dart';
import 'theme.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  final controller = AppController(
    repository: ServerRepository(SecureKeyValueStore()),
  );
  runApp(DeniaApp(controller: controller));
  unawaited(controller.init());
}

class DeniaApp extends StatelessWidget {
  const DeniaApp({super.key, required this.controller});

  final AppController controller;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Denia',
      debugShowCheckedModeBanner: false,
      theme: DeniaTheme.light(),
      darkTheme: DeniaTheme.dark(),
      themeMode: ThemeMode.system,
      locale: const Locale('zh', 'CN'),
      supportedLocales: const [Locale('zh', 'CN'), Locale('en')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      home: AppShell(app: controller),
    );
  }
}
