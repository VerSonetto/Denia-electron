import 'package:flutter/services.dart';
import 'package:material_ui/material_ui.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

class ScannerScreen extends StatefulWidget {
  const ScannerScreen({super.key});

  @override
  State<ScannerScreen> createState() => _ScannerScreenState();
}

class _ScannerScreenState extends State<ScannerScreen> {
  late final MobileScannerController _controller = MobileScannerController(
    detectionSpeed: DetectionSpeed.noDuplicates,
    formats: const [BarcodeFormat.qrCode],
    facing: CameraFacing.back,
  );

  bool _handled = false;
  bool _torch = false;
  String? _hint;
  DateTime _lastInvalid = DateTime.fromMillisecondsSinceEpoch(0);

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _onDetect(BarcodeCapture capture) {
    if (_handled) return;
    for (final barcode in capture.barcodes) {
      final value = barcode.rawValue?.trim();
      if (value == null || value.isEmpty) continue;
      if (!value.startsWith('denia://connect')) {
        if (DateTime.now().difference(_lastInvalid) >
            const Duration(seconds: 2)) {
          _lastInvalid = DateTime.now();
          if (mounted) setState(() => _hint = '这不是 Denia 配对码');
        }
        continue;
      }
      _handled = true;
      _controller.stop();
      HapticFeedback.mediumImpact();
      Navigator.of(context).pop(value);
      return;
    }
  }

  Future<void> _toggleTorch() async {
    try {
      await _controller.toggleTorch();
      if (!mounted) return;
      setState(() => _torch = !_torch);
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('这台设备没有可用的闪光灯')));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      body: Stack(
        fit: StackFit.expand,
        children: [
          MobileScanner(
            controller: _controller,
            onDetect: _onDetect,
            errorBuilder: (context, error) => _CameraError(error: error),
          ),
          _ScannerOverlay(
            hint: _hint,
            onClose: () => Navigator.of(context).maybePop(),
            torch: _torch,
            onTorch: _toggleTorch,
          ),
        ],
      ),
    );
  }
}

class _ScannerOverlay extends StatelessWidget {
  const _ScannerOverlay({
    required this.hint,
    required this.onClose,
    required this.torch,
    required this.onTorch,
  });

  final String? hint;
  final VoidCallback onClose;
  final bool torch;
  final Future<void> Function() onTorch;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final size = (constraints.maxWidth * 0.72).clamp(200.0, 300.0);
        final top = (constraints.maxHeight - size) / 2;
        final left = (constraints.maxWidth - size) / 2;
        const shade = Color(0x99000000);
        return Stack(
          children: [
            Positioned(
              top: 0,
              left: 0,
              right: 0,
              height: top,
              child: const ColoredBox(color: shade),
            ),
            Positioned(
              top: top + size,
              left: 0,
              right: 0,
              bottom: 0,
              child: const ColoredBox(color: shade),
            ),
            Positioned(
              top: top,
              left: 0,
              width: left,
              height: size,
              child: const ColoredBox(color: shade),
            ),
            Positioned(
              top: top,
              right: 0,
              width: left,
              height: size,
              child: const ColoredBox(color: shade),
            ),
            Positioned(
              top: top,
              left: left,
              width: size,
              height: size,
              child: Container(
                decoration: BoxDecoration(
                  border: Border.all(
                    color: Colors.white.withValues(alpha: 0.9),
                    width: 2,
                  ),
                  borderRadius: BorderRadius.circular(22),
                ),
              ),
            ),
            Positioned(
              top: 0,
              left: 0,
              right: 0,
              child: SafeArea(
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 4,
                  ),
                  child: Row(
                    children: [
                      IconButton(
                        onPressed: onClose,
                        style: IconButton.styleFrom(
                          backgroundColor: Colors.black.withValues(alpha: 0.4),
                          foregroundColor: Colors.white,
                        ),
                        icon: const Icon(Icons.close_rounded),
                      ),
                      const Spacer(),
                      IconButton(
                        onPressed: onTorch,
                        style: IconButton.styleFrom(
                          backgroundColor: Colors.black.withValues(alpha: 0.4),
                          foregroundColor: torch ? Colors.amber : Colors.white,
                        ),
                        icon: Icon(
                          torch
                              ? Icons.flashlight_on_rounded
                              : Icons.flashlight_off_rounded,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
            Positioned(
              top: top - 64,
              left: 24,
              right: 24,
              child: const Text(
                '扫描桌面端的配对二维码',
                textAlign: TextAlign.center,
                style: TextStyle(
                  color: Colors.white,
                  fontSize: 15,
                  fontWeight: FontWeight.w500,
                ),
              ),
            ),
            Positioned(
              top: top + size + 22,
              left: 28,
              right: 28,
              child: Text(
                hint ?? '在桌面端「设置 → 远程访问」里生成二维码',
                textAlign: TextAlign.center,
                style: TextStyle(
                  color: hint == null ? Colors.white70 : Colors.amberAccent,
                  fontSize: 13,
                  height: 1.5,
                ),
              ),
            ),
          ],
        );
      },
    );
  }
}

class _CameraError extends StatelessWidget {
  const _CameraError({required this.error});

  final MobileScannerException error;

  @override
  Widget build(BuildContext context) {
    return ColoredBox(
      color: Colors.black,
      child: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(32),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(
                  Icons.no_photography_outlined,
                  color: Colors.white70,
                  size: 40,
                ),
                const SizedBox(height: 14),
                const Text(
                  '无法打开相机',
                  style: TextStyle(
                    color: Colors.white,
                    fontSize: 16,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 8),
                Text(
                  error.errorCode == MobileScannerErrorCode.permissionDenied
                      ? '请在系统设置里允许 Denia 使用相机，或改用「输入配对码」。'
                      : '相机不可用：${error.errorDetails?.message ?? error.errorCode.name}',
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: Colors.white70, height: 1.5),
                ),
                const SizedBox(height: 20),
                OutlinedButton(
                  onPressed: () => Navigator.of(context).maybePop(),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: Colors.white,
                    side: const BorderSide(color: Colors.white30),
                  ),
                  child: const Text('返回'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
