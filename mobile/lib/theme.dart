import 'package:flutter/services.dart';
import 'package:material_ui/material_ui.dart';

/// Denia's desktop console is intentionally monochrome: near-black surfaces,
/// white primary, hairline borders. The phone keeps that identity instead of
/// inventing a second palette.
class DeniaTheme {
  static const Color darkBg = Color(0xFF17181B);
  static const Color darkBgDeep = Color(0xFF0F1012);
  static const Color darkSurface = Color(0xFF1E2024);
  static const Color darkRaised = Color(0xFF292B30);
  static const Color darkBorder = Color(0xFF31343A);
  static const Color darkText = Color(0xFFF2F4F6);
  static const Color darkMuted = Color(0xFFA0A7AF);

  static const Color lightBg = Color(0xFFF7F8FA);
  static const Color lightBgDeep = Color(0xFFF0F2F5);
  static const Color lightSurface = Color(0xFFFFFFFF);
  static const Color lightRaised = Color(0xFFE8ECEF);
  static const Color lightBorder = Color(0xFFDEE3E8);
  static const Color lightText = Color(0xFF17191C);
  static const Color lightMuted = Color(0xFF69727B);

  // The input material follows the reference console: a white/elevated fill
  // with a 0.5px hairline and a very soft two-layer elevation. The selector
  // circle is one step off the fill.
  static const Color lightInput = Color(0xFFFFFFFF);
  static const Color lightInputSelector = Color(0xFFF5F6F7);
  static const Color darkInput = Color(0xFF2C2C2E);
  static const Color darkInputSelector = Color(0xFF353638);

  static ThemeData dark() {
    final scheme =
        ColorScheme.fromSeed(
          seedColor: Colors.white,
          brightness: Brightness.dark,
        ).copyWith(
          primary: Colors.white,
          onPrimary: darkBg,
          secondary: const Color(0xFFD4D8DD),
          onSecondary: darkBg,
          surface: darkSurface,
          onSurface: darkText,
          surfaceContainerHighest: darkRaised,
          outline: const Color(0xFF3C4148),
          outlineVariant: darkBorder,
          error: const Color(0xFFFF9C9C),
          onError: darkBg,
        );
    return _base(scheme, darkBg, darkSurface, darkBorder);
  }

  static ThemeData light() {
    final scheme =
        ColorScheme.fromSeed(
          seedColor: Colors.black,
          brightness: Brightness.light,
        ).copyWith(
          primary: lightText,
          onPrimary: Colors.white,
          secondary: const Color(0xFF4A5158),
          onSecondary: Colors.white,
          surface: lightSurface,
          onSurface: lightText,
          surfaceContainerHighest: lightRaised,
          outline: const Color(0xFFBEC6CD),
          outlineVariant: lightBorder,
          error: const Color(0xFFB3261E),
          onError: Colors.white,
        );
    return _base(scheme, lightBg, lightSurface, lightBorder);
  }

  static ThemeData _base(
    ColorScheme scheme,
    Color background,
    Color surface,
    Color border,
  ) {
    final base = ThemeData(
      useMaterial3: true,
      colorScheme: scheme,
      scaffoldBackgroundColor: background,
      canvasColor: background,
    );
    return base.copyWith(
      textTheme: base.textTheme.apply(
        bodyColor: scheme.onSurface,
        displayColor: scheme.onSurface,
      ),
      dividerColor: border,
      appBarTheme: AppBarTheme(
        backgroundColor: background,
        foregroundColor: scheme.onSurface,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        surfaceTintColor: Colors.transparent,
        titleTextStyle: TextStyle(
          color: scheme.onSurface,
          fontSize: 20,
          fontWeight: FontWeight.w600,
          letterSpacing: -0.2,
        ),
      ),
      cardTheme: CardThemeData(
        color: surface,
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: BorderSide(color: border),
        ),
      ),
      dialogTheme: DialogThemeData(
        backgroundColor: surface,
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
      ),
      bottomSheetTheme: BottomSheetThemeData(
        backgroundColor: surface,
        surfaceTintColor: Colors.transparent,
        modalBackgroundColor: surface,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
        ),
      ),
      snackBarTheme: SnackBarThemeData(
        backgroundColor: scheme.onSurface,
        contentTextStyle: TextStyle(color: surface),
        behavior: SnackBarBehavior.floating,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: scheme.surfaceContainerHighest,
        contentPadding: const EdgeInsets.symmetric(
          horizontal: 14,
          vertical: 12,
        ),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: BorderSide.none,
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: BorderSide(color: border),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: BorderSide(color: scheme.onSurface, width: 1.2),
        ),
        hintStyle: TextStyle(color: scheme.onSurface.withValues(alpha: 0.38)),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: scheme.primary,
          foregroundColor: scheme.onPrimary,
          minimumSize: const Size(0, 48),
          textStyle: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(14),
          ),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: scheme.onSurface,
          minimumSize: const Size(0, 46),
          side: BorderSide(color: border),
          textStyle: const TextStyle(fontSize: 15, fontWeight: FontWeight.w500),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(14),
          ),
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          foregroundColor: scheme.onSurface,
          textStyle: const TextStyle(fontWeight: FontWeight.w500),
        ),
      ),
      progressIndicatorTheme: ProgressIndicatorThemeData(
        color: scheme.onSurface,
      ),
      listTileTheme: ListTileThemeData(
        iconColor: scheme.onSurface.withValues(alpha: 0.72),
        textColor: scheme.onSurface,
      ),
    );
  }
}

extension DeniaContextColors on BuildContext {
  bool get isDark => Theme.of(this).brightness == Brightness.dark;
  ColorScheme get scheme => Theme.of(this).colorScheme;
  Color get deniaBg => Theme.of(this).scaffoldBackgroundColor;
  Color get deniaBgDeep =>
      isDark ? DeniaTheme.darkBgDeep : DeniaTheme.lightBgDeep;
  Color get deniaSurface => scheme.surface;
  Color get deniaRaised => scheme.surfaceContainerHighest;
  Color get deniaBorder => scheme.outlineVariant;
  Color get deniaText => scheme.onSurface;
  Color get deniaMuted => scheme.onSurface.withValues(alpha: 0.58);
  Color get deniaFaint => scheme.onSurface.withValues(alpha: 0.38);
  Color get deniaDanger =>
      isDark ? const Color(0xFFFF9C9C) : const Color(0xFFB3261E);
  Color get deniaWarning =>
      isDark ? const Color(0xFFE8C07A) : const Color(0xFF8A5A00);
  Color get deniaSuccess =>
      isDark ? const Color(0xFF7CC9A3) : const Color(0xFF2F7D5C);

  LinearGradient get deniaPageGradient => LinearGradient(
    begin: Alignment.topCenter,
    end: Alignment.bottomCenter,
    colors: isDark
        ? const [DeniaTheme.darkBg, DeniaTheme.darkBgDeep]
        : const [DeniaTheme.lightBg, DeniaTheme.lightBgDeep],
  );

  SystemUiOverlayStyle get deniaSystemUi =>
      (isDark ? SystemUiOverlayStyle.light : SystemUiOverlayStyle.dark)
          .copyWith(
            statusBarColor: Colors.transparent,
            systemNavigationBarColor: deniaBgDeep,
            systemNavigationBarDividerColor: Colors.transparent,
            systemNavigationBarIconBrightness: isDark
                ? Brightness.light
                : Brightness.dark,
          );
}

/// One shared page wash for home, conversation, pairing and connection states.
/// The composer's own fill stays untouched; this only gives every screen the
/// same top-to-bottom ground so raised surfaces sit on the same material.
class DeniaBackdrop extends StatelessWidget {
  const DeniaBackdrop({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(gradient: context.deniaPageGradient),
      child: child,
    );
  }
}

TextStyle monoStyle(BuildContext context, {double size = 12.5, Color? color}) {
  return TextStyle(
    fontFamily: 'monospace',
    fontFamilyFallback: const ['Menlo', 'Consolas', 'Roboto Mono'],
    fontSize: size,
    height: 1.55,
    color: color ?? context.deniaText.withValues(alpha: 0.86),
  );
}
