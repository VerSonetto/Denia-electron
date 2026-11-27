import 'dart:ui' show lerpDouble;

import 'package:flutter/rendering.dart';
import 'package:material_ui/material_ui.dart';

/// Collapsed: [+ add] [text ................] [key]
/// Open:      [text ..........................]
///            [+ add] [model]          [key]
///
/// The add key is present in both states. When the key drops to the action
/// row, the draft slides to the card's line head; the slide is held until the
/// add circle has cleared the first line so the two never paint through each
/// other.
class ComposerMorph extends MultiChildRenderObjectWidget {
  const ComposerMorph({super.key, required this.open, required super.children});

  final Animation<double> open;

  @override
  RenderObject createRenderObject(BuildContext context) {
    return ComposerMorphRenderBox(open);
  }

  @override
  void updateRenderObject(
    BuildContext context,
    ComposerMorphRenderBox renderObject,
  ) {
    renderObject.open = open;
  }
}

class _ComposerMorphParentData extends ContainerBoxParentData<RenderBox> {}

class ComposerMorphRenderBox extends RenderBox
    with
        ContainerRenderObjectMixin<RenderBox, _ComposerMorphParentData>,
        RenderBoxContainerDefaultsMixin<RenderBox, _ComposerMorphParentData> {
  ComposerMorphRenderBox(this._open);

  static const double _gap = 4;
  static const double _rowGap = 2;

  Animation<double> _open;

  set open(Animation<double> value) {
    if (identical(value, _open)) return;
    if (attached) _open.removeListener(markNeedsLayout);
    _open = value;
    if (attached) _open.addListener(markNeedsLayout);
    markNeedsLayout();
  }

  @override
  void attach(PipelineOwner owner) {
    super.attach(owner);
    _open.addListener(markNeedsLayout);
  }

  @override
  void detach() {
    _open.removeListener(markNeedsLayout);
    super.detach();
  }

  @override
  void setupParentData(RenderBox child) {
    if (child.parentData is! _ComposerMorphParentData) {
      child.parentData = _ComposerMorphParentData();
    }
  }

  @override
  Size computeDryLayout(covariant BoxConstraints constraints) {
    return _measure(constraints, ChildLayoutHelper.dryLayoutChild).size;
  }

  @override
  void performLayout() {
    final result = _measure(constraints, ChildLayoutHelper.layoutChild);
    size = result.size;
    final [text, add, footer, trailing] = getChildrenAsList();
    final t = _open.value.clamp(0.0, 1.0);
    final bottomHeight = result.bottomHeight;
    final bottomTop = size.height - bottomHeight;

    (text.parentData! as _ComposerMorphParentData).offset = Offset(
      result.textX,
      0,
    );
    (add.parentData! as _ComposerMorphParentData).offset = Offset(
      0,
      bottomTop + (bottomHeight - add.size.height) / 2,
    );
    (trailing.parentData! as _ComposerMorphParentData).offset = Offset(
      size.width - trailing.size.width,
      size.height - trailing.size.height,
    );
    (footer.parentData! as _ComposerMorphParentData).offset = Offset(
      add.size.width + _gap,
      bottomTop + (bottomHeight - footer.size.height) / 2,
    );

    // Keep the model row from painting through the closing text while the
    // morph is still running.
    if (t <= 0.001) {
      (footer.parentData! as _ComposerMorphParentData).offset = Offset(
        add.size.width + _gap,
        size.height,
      );
    }
  }

  ({Size size, double bottomHeight, double textX}) _measure(
    BoxConstraints constraints,
    ChildLayouter layoutChild,
  ) {
    final [text, add, footer, trailing] = getChildrenAsList();
    final width = constraints.maxWidth;
    final loose = BoxConstraints(maxWidth: width);
    final key = layoutChild(trailing, loose);
    final plus = layoutChild(add, loose);
    final foot = layoutChild(footer, loose);

    final t = _open.value.clamp(0.0, 1.0);
    final closedX = plus.width + _gap;
    final shift = ((t - 0.76) / 0.24).clamp(0.0, 1.0);
    final easedShift = Curves.easeInOutCubic.transform(shift);
    final textX = (lerpDouble(closedX, 0, easedShift) ?? closedX).clamp(
      0.0,
      width,
    );

    final closedWidth = (width - plus.width - key.width - _gap * 2).clamp(
      0.0,
      width,
    );
    final openWidth = (width - textX).clamp(0.0, width);
    final targetWidth = lerpDouble(closedWidth, openWidth, t) ?? closedWidth;
    final textWidth = targetWidth > width - textX
        ? (width - textX).clamp(0.0, width)
        : targetWidth;
    final field = layoutChild(text, BoxConstraints.tightFor(width: textWidth));

    final bottomHeight = foot.height > key.height ? foot.height : key.height;
    final closedHeight = field.height > key.height ? field.height : key.height;
    final openHeight = field.height + _rowGap + bottomHeight;
    final height = lerpDouble(closedHeight, openHeight, t) ?? closedHeight;
    return (
      size: constraints.constrain(Size(width, height)),
      bottomHeight: bottomHeight,
      textX: textX,
    );
  }

  @override
  void paint(PaintingContext context, Offset offset) {
    final [text, add, footer, trailing] = getChildrenAsList();
    final t = _open.value.clamp(0.0, 1.0);
    context.paintChild(
      text,
      offset + (text.parentData! as _ComposerMorphParentData).offset,
    );
    context.paintChild(
      add,
      offset + (add.parentData! as _ComposerMorphParentData).offset,
    );
    if (t > 0.001) {
      context.paintChild(
        footer,
        offset + (footer.parentData! as _ComposerMorphParentData).offset,
      );
    }
    context.paintChild(
      trailing,
      offset + (trailing.parentData! as _ComposerMorphParentData).offset,
    );
  }

  @override
  bool hitTestChildren(BoxHitTestResult result, {required Offset position}) {
    final [text, add, footer, trailing] = getChildrenAsList();
    final t = _open.value.clamp(0.0, 1.0);
    for (final child in [trailing, add, if (t > 0.001) footer, text]) {
      final parentData = child.parentData! as _ComposerMorphParentData;
      final hit = result.addWithPaintOffset(
        offset: parentData.offset,
        position: position,
        hitTest: (result, transformed) =>
            child.hitTest(result, position: transformed),
      );
      if (hit) return true;
    }
    return false;
  }

  @override
  void visitChildrenForSemantics(RenderObjectVisitor visitor) {
    final [text, add, footer, trailing] = getChildrenAsList();
    visitor(text);
    visitor(add);
    if (_open.value > 0.001) visitor(footer);
    visitor(trailing);
  }
}
