import 'package:material_ui/material_ui.dart';

import '../../theme.dart';

/// The reference console's input material: one elevated fill with a 0.5px
/// hairline and a two-layer soft elevation. Shared by the composer, the new
/// session key and the welcome model key so all three read as one material.
class InputSurface extends StatelessWidget {
  const InputSurface({
    super.key,
    required this.child,
    this.radius = 28,
    this.padding = EdgeInsets.zero,
  });

  final Widget child;
  final double radius;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    final dark = context.isDark;
    final fill = dark ? DeniaTheme.darkInput : DeniaTheme.lightInput;
    final hairline = dark
        ? Colors.white.withValues(alpha: 0.12)
        : Colors.black.withValues(alpha: 0.10);
    return Container(
      padding: padding,
      decoration: BoxDecoration(
        color: fill,
        borderRadius: BorderRadius.circular(radius),
        border: Border.all(color: hairline, width: 0.5),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.03),
            blurRadius: 16,
            offset: const Offset(0, 4),
          ),
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.03),
            blurRadius: 24,
          ),
        ],
      ),
      child: child,
    );
  }
}
