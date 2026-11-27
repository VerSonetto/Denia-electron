import 'package:denia_mobile/data/key_value_store.dart';
import 'package:denia_mobile/data/server_repository.dart';
import 'package:denia_mobile/main.dart';
import 'package:denia_mobile/state/app_controller.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('an unpaired device lands on the pairing screen', (tester) async {
    final controller = AppController(
      repository: ServerRepository(MemoryKeyValueStore()),
    );
    await controller.init();
    await tester.pumpWidget(DeniaApp(controller: controller));
    await tester.pump();

    expect(find.text('连接你的 Denia'), findsOneWidget);
    expect(find.text('扫描配对二维码'), findsOneWidget);
    expect(find.text('输入配对码'), findsOneWidget);
    expect(controller.phase, AppPhase.unpaired);

    controller.dispose();
  });
}
