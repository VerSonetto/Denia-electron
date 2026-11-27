import 'package:denia_mobile/theme.dart';
import 'package:denia_mobile/ui/widgets/turn_process.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';

void main() {
  testWidgets('completed turn process expands from its summary', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: DeniaTheme.dark(),
        home: const Scaffold(
          body: TurnProcessView(
            label: '已完成 · 2 个工具调用',
            children: [Text('process detail')],
          ),
        ),
      ),
    );

    expect(find.text('已完成 · 2 个工具调用'), findsOneWidget);
    expect(find.text('process detail'), findsNothing);

    await tester.tap(find.text('已完成 · 2 个工具调用'));
    await tester.pumpAndSettle();
    expect(find.text('process detail'), findsOneWidget);
  });
}
