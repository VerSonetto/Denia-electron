// Small, defensive JSON readers. The host is the authority on shapes, but a
// mobile client must survive a field being absent or null without crashing a
// whole transcript render.

import 'dart:convert';

typedef JsonMap = Map<String, dynamic>;

JsonMap asMap(Object? value) {
  if (value is Map) {
    return value.map((key, entry) => MapEntry(key.toString(), entry));
  }
  return const {};
}

String asString(Object? value, [String fallback = '']) {
  return value is String ? value : fallback;
}

String? asStringOrNull(Object? value) {
  if (value is! String) return null;
  final trimmed = value.trim();
  return trimmed.isEmpty ? null : trimmed;
}

int asInt(Object? value, [int fallback = 0]) {
  if (value is int) return value;
  if (value is num) return value.toInt();
  if (value is String) return int.tryParse(value) ?? fallback;
  return fallback;
}

int? asIntOrNull(Object? value) {
  if (value is int) return value;
  if (value is num) return value.toInt();
  if (value is String) return int.tryParse(value);
  return null;
}

bool asBool(Object? value, [bool fallback = false]) {
  return value is bool ? value : fallback;
}

List<JsonMap> asMapList(Object? value) {
  if (value is! List) return const [];
  return value.whereType<Map>().map(asMap).toList(growable: false);
}

List<String> asStringList(Object? value) {
  if (value is! List) return const [];
  return value.whereType<String>().toList(growable: false);
}

/// Epoch milliseconds. Some historical fields are stored as ISO strings.
DateTime? asDate(Object? value) {
  if (value is num) {
    final raw = value.toInt();
    if (raw <= 0) return null;
    return DateTime.fromMillisecondsSinceEpoch(raw);
  }
  if (value is String) {
    final text = value.trim();
    if (text.isEmpty) return null;
    final numeric = int.tryParse(text);
    if (numeric != null) return asDate(numeric);
    return DateTime.tryParse(text);
  }
  return null;
}

JsonMap? tryDecodeJsonMap(String text) {
  try {
    final decoded = jsonDecode(text);
    return decoded is Map ? asMap(decoded) : null;
  } catch (_) {
    return null;
  }
}
