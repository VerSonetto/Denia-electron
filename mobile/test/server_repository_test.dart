import 'dart:convert';

import 'package:denia_mobile/data/key_value_store.dart';
import 'package:denia_mobile/data/server_repository.dart';
import 'package:denia_mobile/models/pairing.dart';
import 'package:denia_mobile/models/server.dart';
import 'package:flutter_test/flutter_test.dart';

PairedServer _server(String id, {String? activeUrl}) {
  return PairedServer(
    serverId: id,
    label: 'PC $id',
    fingerprint: 'ABCD-$id',
    candidates: [
      PairingCandidate(
        type: 'lan',
        url: Uri.parse('http://192.168.1.8:43656'),
        priority: 10,
      ),
    ],
    token: 'token-$id',
    clientId: 'client-$id',
    pairedAt: 1234,
    activeUrl: activeUrl,
  );
}

void main() {
  test('creates a stable install id', () async {
    final store = MemoryKeyValueStore();
    final repository = ServerRepository(store);
    final first = await repository.load();
    final second = await repository.load();
    expect(first.installId, isNotEmpty);
    expect(second.installId, first.installId);
    expect(store.values[ServerRepository.installIdKey], first.installId);
  });

  test('round-trips servers and the active id', () async {
    final store = MemoryKeyValueStore();
    final repository = ServerRepository(store);
    await repository.save([
      _server('s1'),
      _server('s2', activeUrl: 'http://192.168.1.8:43656'),
    ], 's2');
    final loaded = await repository.load();
    expect(loaded.servers, hasLength(2));
    expect(loaded.servers.last.token, 'token-s2');
    expect(loaded.servers.last.activeUrl, 'http://192.168.1.8:43656');
    expect(loaded.activeServerId, 's2');
  });

  test('falls back to the first server when the active id is stale', () async {
    final store = MemoryKeyValueStore();
    final repository = ServerRepository(store);
    await store.write(
      ServerRepository.serversKey,
      jsonEncode({
        'version': 1,
        'servers': [_server('s1').toJson(), _server('s2').toJson()],
        'activeServerId': 'missing',
      }),
    );
    final loaded = await repository.load();
    expect(loaded.activeServerId, 's1');
  });

  test('skips corrupt entries instead of dropping the whole list', () async {
    final store = MemoryKeyValueStore();
    final repository = ServerRepository(store);
    await store.write(
      ServerRepository.serversKey,
      jsonEncode({
        'version': 1,
        'servers': [
          {'serverId': 'broken'},
          _server('good').toJson(),
        ],
        'activeServerId': 'good',
      }),
    );
    final loaded = await repository.load();
    expect(loaded.servers.map((server) => server.serverId), ['good']);
  });

  test('survives corrupt JSON while keeping the install id', () async {
    final store = MemoryKeyValueStore();
    final repository = ServerRepository(store);
    final first = await repository.load();
    await store.write(ServerRepository.serversKey, '{not json');
    final loaded = await repository.load();
    expect(loaded.servers, isEmpty);
    expect(loaded.installId, first.installId);
    expect(loaded.activeServerId, isNull);
  });
}
