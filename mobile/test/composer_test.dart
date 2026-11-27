import 'package:denia_mobile/theme.dart';
import 'package:denia_mobile/ui/widgets/composer.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';

Widget _composer({
  required TextEditingController controller,
  required FocusNode focus,
  required bool running,
  required VoidCallback onSend,
  required VoidCallback onStop,
  VoidCallback? onAddTap,
  VoidCallback? onModelTap,
}) {
  return MaterialApp(
    theme: DeniaTheme.dark(),
    home: Scaffold(
      body: Composer(
        controller: controller,
        focusNode: focus,
        running: running,
        sending: false,
        cancelling: false,
        connected: true,
        modelLabel: 'mock-1',
        onSend: () async => onSend(),
        onStop: () async => onStop(),
        onAddTap: onAddTap ?? () {},
        onModelTap: onModelTap ?? () {},
      ),
    ),
  );
}

void main() {
  testWidgets('the primary key switches between send, stop and steer', (
    tester,
  ) async {
    final controller = TextEditingController();
    final focus = FocusNode();
    addTearDown(controller.dispose);
    addTearDown(focus.dispose);
    var sends = 0;
    var stops = 0;

    var adds = 0;
    await tester.pumpWidget(
      _composer(
        controller: controller,
        focus: focus,
        running: false,
        onSend: () => sends += 1,
        onStop: () => stops += 1,
        onAddTap: () => adds += 1,
      ),
    );

    // The add key is present before the composer expands.
    expect(find.byIcon(Icons.add_rounded), findsOneWidget);
    await tester.tap(find.byIcon(Icons.add_rounded));
    expect(adds, 1);

    // Empty idle: nothing to send.
    expect(
      tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
      isNull,
    );

    await tester.enterText(find.byType(TextField), 'hello');
    await tester.pumpAndSettle();
    expect(find.byIcon(Icons.arrow_upward_rounded), findsOneWidget);
    await tester.tap(find.byType(FilledButton));
    await tester.pumpAndSettle();
    expect(sends, 1);

    controller.clear();
    await tester.pumpWidget(
      _composer(
        controller: controller,
        focus: focus,
        running: true,
        onSend: () => sends += 1,
        onStop: () => stops += 1,
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byIcon(Icons.stop_rounded), findsOneWidget);
    await tester.tap(find.byType(FilledButton));
    await tester.pumpAndSettle();
    expect(stops, 1);

    await tester.enterText(find.byType(TextField), 'steer this');
    await tester.pumpAndSettle();
    expect(find.byIcon(Icons.bolt_rounded), findsOneWidget);
    expect(find.byIcon(Icons.stop_rounded), findsNothing);
    await tester.tap(find.byType(FilledButton));
    await tester.pumpAndSettle();
    expect(sends, 2);
  });

  testWidgets('the model key becomes tappable with the composer', (
    tester,
  ) async {
    final controller = TextEditingController();
    final focus = FocusNode();
    addTearDown(controller.dispose);
    addTearDown(focus.dispose);
    var picks = 0;

    await tester.pumpWidget(
      _composer(
        controller: controller,
        focus: focus,
        running: false,
        onSend: () {},
        onStop: () {},
        onModelTap: () => picks += 1,
      ),
    );

    await tester.tap(find.byType(TextField));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    await tester.tap(find.text('mock-1'));

    expect(picks, 1);
  });
}
