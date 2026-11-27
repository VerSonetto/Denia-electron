String relativeTime(DateTime? time) {
  if (time == null) return '';
  final now = DateTime.now();
  final diff = now.difference(time.toLocal());
  if (diff.isNegative || diff.inMinutes < 1) return '刚刚';
  if (diff.inMinutes < 60) return '${diff.inMinutes} 分钟前';
  if (diff.inHours < 24) return '${diff.inHours} 小时前';
  if (diff.inDays < 7) return '${diff.inDays} 天前';
  final local = time.toLocal();
  if (local.year == now.year) return '${local.month} 月 ${local.day} 日';
  return '${local.year}/${local.month}/${local.day}';
}

String compactNumber(num? value) {
  if (value == null) return '';
  final number = value.toDouble();
  if (number >= 1000000) return '${(number / 1000000).toStringAsFixed(1)}m';
  if (number >= 1000) {
    return '${(number / 1000).toStringAsFixed(number >= 10000 ? 0 : 1)}k';
  }
  return number.toStringAsFixed(0);
}

String collapseWhitespace(String text, {int max = 90}) {
  final collapsed = text.replaceAll(RegExp(r'\s+'), ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return '${collapsed.substring(0, max)}…';
}

String shortCallId(String id) => id.length <= 8 ? id : id.substring(0, 8);
