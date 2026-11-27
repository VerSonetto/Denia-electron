import 'dart:convert';
import 'dart:math';

import '../core/json.dart';
import '../models/server.dart';
import 'key_value_store.dart';

class StorageSnapshot {
  const StorageSnapshot({
    required this.installId,
    required this.servers,
    required this.activeServerId,
  });

  final String installId;
  final List<PairedServer> servers;
  final String? activeServerId;
}

/// Secure persistence for the device identity and every paired host.
///
/// A corrupt record is skipped instead of wiping the whole list; losing one
/// pairing is recoverable, losing all of them because of one bad field is not.
class ServerRepository {
  ServerRepository(this._store);

  static const String serversKey = 'denia.mobile.servers.v1';
  static const String installIdKey = 'denia.mobile.install-id.v1';

  final KeyValueStore _store;

  Future<StorageSnapshot> load() async {
    final installId = await _ensureInstallId();
    final raw = await _store.read(serversKey);
    final servers = <PairedServer>[];
    String? activeServerId;
    if (raw != null && raw.trim().isNotEmpty) {
      try {
        final map = asMap(jsonDecode(raw));
        for (final entry in asMapList(map['servers'])) {
          final server = PairedServer.fromJson(entry);
          if (server != null) servers.add(server);
        }
        activeServerId = asStringOrNull(map['activeServerId']);
      } catch (_) {
        // Keep the install id; the host list will need to be paired again.
      }
    }
    if (servers.isNotEmpty) {
      final hasActive = servers.any(
        (server) => server.serverId == activeServerId,
      );
      activeServerId ??= servers.first.serverId;
      if (!hasActive) activeServerId = servers.first.serverId;
    } else {
      activeServerId = null;
    }
    return StorageSnapshot(
      installId: installId,
      servers: servers,
      activeServerId: activeServerId,
    );
  }

  Future<void> save(List<PairedServer> servers, String? activeServerId) async {
    final payload = {
      'version': 1,
      'servers': servers.map((server) => server.toJson()).toList(),
      'activeServerId': activeServerId,
    };
    await _store.write(serversKey, jsonEncode(payload));
  }

  Future<String> _ensureInstallId() async {
    final existing = await _store.read(installIdKey);
    if (existing != null && existing.trim().isNotEmpty) return existing;
    final generated = _newInstallId();
    await _store.write(installIdKey, generated);
    return generated;
  }

  static String _newInstallId() {
    final random = Random.secure();
    final bytes = List<int>.generate(16, (_) => random.nextInt(256));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    final hex = bytes
        .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
        .join();
    return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-'
        '${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
  }
}
