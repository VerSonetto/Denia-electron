import 'package:denia_mobile/models/session.dart';
import 'package:denia_mobile/theme.dart';
import 'package:denia_mobile/ui/widgets/model_picker.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';

const _current = ModelOption(
  id: 'gpt-6.2-sol',
  name: 'gpt-6.2-sol',
  contextWindow: 1050000,
  efforts: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
  defaultEffort: 'off',
);
const _plain = ModelOption(
  id: 'devin/swe-2-flash',
  name: 'devin/swe-2-flash (devin)',
  contextWindow: 200000,
);
const _catalog = ModelCatalog(
  groups: [
    ModelGroup(id: 'aicat', name: 'aicat', models: [_current]),
    ModelGroup(id: 'magpie', name: 'magpie', models: [_plain]),
  ],
);

Widget _host(void Function(ModelChoice? result) onResult) {
  return MaterialApp(
    theme: DeniaTheme.light(),
    home: Builder(
      builder: (context) => Scaffold(
        body: Center(
          child: FilledButton(
            onPressed: () async {
              onResult(
                await showModelPicker(
                  context: context,
                  catalog: _catalog,
                  current: const ModelChoice(
                    provider: 'aicat',
                    model: 'gpt-6.2-sol',
                    reasoningEffort: 'medium',
                  ),
                ),
              );
            },
            child: const Text('open'),
          ),
        ),
      ),
    ),
  );
}

void main() {
  testWidgets('picks a thinking effort without a default-model row', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(412, 915));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    ModelChoice? result;
    await tester.pumpWidget(_host((value) => result = value));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    expect(find.text('桌面端默认'), findsNothing);
    expect(find.text('gpt-6.2-sol'), findsOneWidget);
    expect(find.text('中'), findsOneWidget);

    await tester.tap(find.text('高'));
    await tester.pumpAndSettle();

    expect(result?.provider, 'aicat');
    expect(result?.model, 'gpt-6.2-sol');
    expect(result?.reasoningEffort, 'high');
  });

  testWidgets('a model without efforts commits immediately', (tester) async {
    await tester.binding.setSurfaceSize(const Size(412, 915));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    ModelChoice? result;
    await tester.pumpWidget(_host((value) => result = value));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    await tester.scrollUntilVisible(
      find.text('devin/swe-2-flash (devin)'),
      160,
      scrollable: find.byType(Scrollable).last,
    );
    await tester.tap(find.text('devin/swe-2-flash (devin)'));
    await tester.pumpAndSettle();

    expect(result?.provider, 'magpie');
    expect(result?.model, 'devin/swe-2-flash');
    expect(result?.reasoningEffort, isNull);
  });
}
