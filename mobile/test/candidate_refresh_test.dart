import 'package:denia_mobile/models/pairing.dart';
import 'package:denia_mobile/models/server.dart';
import 'package:denia_mobile/models/session.dart';
import 'package:flutter_test/flutter_test.dart';

PairingCandidate _candidate(String type, String url, {int priority = 10}) {
  return PairingCandidate(
    type: type,
    url: Uri.parse(url),
    priority: priority,
    relayServerId: type == 'relay' ? 'abcdef0123456789' : null,
    hostEncPubKey: type == 'relay' ? 'a' * 43 : null,
  );
}

void main() {
  group('mergePairingCandidates', () {
    test('replaces relay and tunnel but keeps LAN paths', () {
      final next = mergePairingCandidates(
        current: [
          _candidate('relay', 'wss://old.example/ws', priority: 10),
          _candidate('lan', 'http://192.168.1.8:43656', priority: 20),
          _candidate('tunnel', 'https://old.example', priority: 30),
        ],
        relay: _candidate('relay', 'wss://new.example/ws', priority: 10),
        tunnelUrl: 'https://new.example',
      );

      expect(next.map((candidate) => candidate.url.toString()).toList(), [
        'wss://new.example/ws',
        'http://192.168.1.8:43656',
        'https://new.example',
      ]);
      expect(next.map((candidate) => candidate.type).toList(), [
        'relay',
        'lan',
        'tunnel',
      ]);
    });

    test('keeps the last known relay when status omits it', () {
      final next = mergePairingCandidates(
        current: [
          _candidate('relay', 'wss://old.example/ws', priority: 10),
          _candidate('lan', 'http://192.168.1.8:43656', priority: 20),
        ],
      );

      expect(next, hasLength(2));
      expect(next.first.url.toString(), 'wss://old.example/ws');
    });

    test('drops duplicate URLs and refuses non-http tunnel values', () {
      final next = mergePairingCandidates(
        current: [
          _candidate('lan', 'http://192.168.1.8:43656', priority: 20),
          _candidate('lan', 'http://192.168.1.8:43656', priority: 30),
          _candidate('tunnel', 'https://old.example', priority: 10),
        ],
        tunnelUrl: 'not a url',
      );

      expect(next, hasLength(2));
      expect(next.where((candidate) => candidate.type == 'lan'), hasLength(1));
      expect(
        next.singleWhere((candidate) => candidate.type == 'tunnel').url,
        Uri.parse('https://old.example'),
      );
    });
  });

  test('RemoteStatus parses a relay candidate for paired devices', () {
    final status = RemoteStatus.fromJson({
      'local': false,
      'authenticated': true,
      'enabled': true,
      'listening': true,
      'serverId': 'abcdef0123456789',
      'publicUrl': 'https://direct.example',
      'relayCandidate': {
        'type': 'relay',
        'relayUrl': 'wss://relay.example/ws',
        'serverId': 'abcdef0123456789',
        'priority': 10,
        'hostEncPubJwk': {'kty': 'OKP', 'crv': 'X25519', 'x': 'a' * 43},
      },
    });

    expect(status.authenticated, isTrue);
    expect(status.publicUrl, 'https://direct.example');
    expect(status.relayCandidate?.isRelay, isTrue);
    expect(status.relayCandidate?.url.toString(), 'wss://relay.example/ws');
    expect(status.relayCandidate?.relayServerId, 'abcdef0123456789');
  });

  test('RemoteStatus tolerates hosts that do not expose relay details', () {
    final status = RemoteStatus.fromJson({
      'local': false,
      'authenticated': true,
      'enabled': true,
      'listening': true,
    });
    expect(status.relayCandidate, isNull);
  });
}
