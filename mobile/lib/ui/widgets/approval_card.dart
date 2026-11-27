import 'package:material_ui/material_ui.dart';

import '../../models/transcript.dart';
import '../../theme.dart';

class ApprovalCard extends StatelessWidget {
  const ApprovalCard({
    super.key,
    required this.approval,
    required this.busy,
    required this.onDecide,
  });

  final PendingApproval approval;
  final bool busy;
  final Future<void> Function(String decision) onDecide;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.fromLTRB(10, 0, 10, 8),
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 10),
      decoration: BoxDecoration(
        color: context.deniaSurface,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: context.deniaWarning.withValues(alpha: 0.45)),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(
              alpha: Theme.of(context).brightness == Brightness.dark
                  ? 0.55
                  : 0.12,
            ),
            blurRadius: 24,
            offset: const Offset(0, 8),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                Icons.shield_outlined,
                size: 18,
                color: context.deniaWarning,
              ),
              const SizedBox(width: 8),
              const Text(
                '需要你的许可',
                style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
              ),
              const Spacer(),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: context.deniaRaised,
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Text(
                  approval.tool,
                  style: monoStyle(
                    context,
                    size: 11,
                    color: context.deniaMuted,
                  ),
                ),
              ),
            ],
          ),
          if (approval.reason != null &&
              approval.reason!.trim().isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(
              approval.reason!,
              style: TextStyle(
                fontSize: 12.5,
                height: 1.5,
                color: context.deniaMuted,
              ),
            ),
          ],
          if (approval.argsPreview.trim().isNotEmpty) ...[
            const SizedBox(height: 8),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(9),
              decoration: BoxDecoration(
                color: context.isDark
                    ? const Color(0xFF0D0D0D)
                    : const Color(0xFFF2F2F2),
                borderRadius: BorderRadius.circular(9),
              ),
              child: Text(
                approval.argsPreview.trim(),
                maxLines: 6,
                overflow: TextOverflow.ellipsis,
                style: monoStyle(context, size: 11.5),
              ),
            ),
          ],
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(
                child: OutlinedButton(
                  onPressed: busy ? null : () => onDecide('reject'),
                  style: OutlinedButton.styleFrom(
                    minimumSize: const Size(0, 40),
                    foregroundColor: context.deniaDanger,
                    side: BorderSide(
                      color: context.deniaDanger.withValues(alpha: 0.4),
                    ),
                    padding: const EdgeInsets.symmetric(horizontal: 8),
                  ),
                  child: const Text('拒绝'),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                flex: 2,
                child: FilledButton(
                  onPressed: busy ? null : () => onDecide('allow-once'),
                  style: FilledButton.styleFrom(
                    minimumSize: const Size(0, 40),
                    padding: const EdgeInsets.symmetric(horizontal: 8),
                  ),
                  child: busy
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Text('允许一次'),
                ),
              ),
            ],
          ),
          Align(
            alignment: Alignment.centerRight,
            child: TextButton(
              onPressed: busy ? null : () => onDecide('allow-session'),
              style: TextButton.styleFrom(
                minimumSize: const Size(0, 32),
                visualDensity: VisualDensity.compact,
              ),
              child: Text(
                '本会话内都允许',
                style: TextStyle(fontSize: 12, color: context.deniaMuted),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
