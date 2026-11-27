import 'package:denia_mobile/models/transcript.dart';
import 'package:denia_mobile/theme.dart';
import 'package:denia_mobile/ui/widgets/tool_card.dart';
import 'package:denia_mobile/ui/widgets/tool_group.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';

ToolItem _tool(String id, String name, String args) {
  final item = ToolItem(seq: 1, callId: id, name: name, args: args);
  item.result = const ToolResultView(content: 'ok', isError: false);
  return item;
}

void main() {
  testWidgets('three tools fold into one row and expand on tap', (
    tester,
  ) async {
    final tools = [
      _tool('a', 'todo_write', '{"todos":[{"content":"check"}]}'),
      _tool('b', 'bash', '{"command":"echo hi"}'),
      _tool('c', 'read_file', '{"path":"README.md"}'),
    ];
    await tester.pumpWidget(
      MaterialApp(
        theme: DeniaTheme.dark(),
        home: Scaffold(body: ToolGroupView(tools: tools)),
      ),
    );

    expect(find.text('3 个工具调用'), findsOneWidget);
    expect(find.byType(ToolCard), findsNothing);

    await tester.tap(find.text('3 个工具调用'));
    await tester.pumpAndSettle();
    expect(find.byType(ToolCard), findsNWidgets(3));

    await tester.tap(find.text('bash'));
    await tester.pumpAndSettle();
    expect(find.text('输出'), findsOneWidget);
  });
}
