import 'package:material_ui/material_ui.dart';

class DeniaLogo extends StatelessWidget {
  const DeniaLogo({super.key, this.size = 40, this.radius});

  final double size;
  final double? radius;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: scheme.onSurface,
        borderRadius: BorderRadius.circular(radius ?? size * 0.28),
      ),
      alignment: Alignment.center,
      child: Text(
        'D',
        style: TextStyle(
          color: scheme.surface,
          fontSize: size * 0.56,
          fontWeight: FontWeight.w700,
          height: 1,
          letterSpacing: -1,
        ),
      ),
    );
  }
}
