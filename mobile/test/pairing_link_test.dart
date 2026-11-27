import 'dart:convert';

import 'package:denia_mobile/core/errors.dart';
import 'package:denia_mobile/models/pairing.dart';
import 'package:flutter_test/flutter_test.dart';

String _encode(Map<String, dynamic> payload) {
  final encoded = base64Url.encode(utf8.encode(jsonEncode(payload)));
  return encoded.replaceAll('=', '');
}

String _link(Map<String, dynamic> payload) =>
    'denia://connect?v=2&p=${_encode(payload)}';

Map<String, dynamic> _payload({
  String serverId = 'server-1',
  List<Map<String, dynamic>>? candidates,
  String? expiresAt,
}) {
  return {
    'v': 2,
    'pairingId': 'pair_123',
    'secret': 'secret-value',
    'serverId': serverId,
    'fingerprint': 'A1B2-C3D4',
    'label': '书房电脑',
    'expiresAt':
        expiresAt ??
        DateTime.now()
            .toUtc()
            .add(const Duration(minutes: 5))
            .toIso8601String(),
    'candidates':
        candidates ??
        [
          {'type': 'lan', 'url': 'http://192.168.1.8:43656', 'priority': 20},
          {
            'type': 'tunnel',
            'url': 'https://denia.example.com',
            'priority': 10,
          },
        ],
  };
}

void main() {
  group('PairingPayload.parseLink', () {
    test('parses v2 fields and sorts candidates by priority', () {
      final payload = PairingPayload.parseLink(_link(_payload()));
      expect(payload.version, 2);
      expect(payload.pairingId, 'pair_123');
      expect(payload.secret, 'secret-value');
      expect(payload.serverId, 'server-1');
      expect(payload.fingerprint, 'A1B2-C3D4');
      expect(payload.label, '书房电脑');
      expect(payload.candidates, hasLength(2));
      expect(
        payload.sortedCandidates.map((candidate) => candidate.type).toList(),
        ['tunnel', 'lan'],
      );
      expect(payload.isExpired, isFalse);
    });

    test('deduplicates candidate URLs', () {
      final payload = PairingPayload.parseLink(
        _link(
          _payload(
            candidates: [
              {
                'type': 'lan',
                'url': 'http://192.168.1.8:43656/',
                'priority': 20,
              },
              {
                'type': 'lan',
                'url': 'http://192.168.1.8:43656/',
                'priority': 30,
              },
              {
                'type': 'tunnel',
                'url': 'https://denia.example.com',
                'priority': 10,
              },
            ],
          ),
        ),
      );
      expect(payload.sortedCandidates, hasLength(2));
      expect(payload.sortedCandidates.first.type, 'tunnel');
    });

    test('marks expired payloads without rejecting them', () {
      final payload = PairingPayload.parseLink(
        _link(
          _payload(
            expiresAt: DateTime.now()
                .toUtc()
                .subtract(const Duration(minutes: 1))
                .toIso8601String(),
          ),
        ),
      );
      expect(payload.isExpired, isTrue);
    });

    test('rejects non-Denia links', () {
      expect(
        () => PairingPayload.parseLink('https://example.com/connect?v=2'),
        throwsA(isA<PairingException>()),
      );
      expect(
        () => PairingPayload.parseLink('denia://connect?v=1&p=abc'),
        throwsA(isA<PairingException>()),
      );
    });

    test('rejects malformed payloads and empty candidates', () {
      expect(
        () => PairingPayload.parseLink('denia://connect?v=2&p=not-base64!'),
        throwsA(isA<PairingException>()),
      );
      final noCandidates = _payload(candidates: []);
      expect(
        () => PairingPayload.parseLink(_link(noCandidates)),
        throwsA(isA<PairingException>()),
      );
      final noSecret = _payload()..remove('secret');
      expect(
        () => PairingPayload.parseLink(_link(noSecret)),
        throwsA(isA<PairingException>()),
      );
    });

    test('drops malformed candidates but keeps valid ones', () {
      final payload = PairingPayload.parseLink(
        _link(
          _payload(
            candidates: [
              {'type': 'lan', 'url': 'not a url', 'priority': 1},
              {'type': 'lan', 'url': 'ftp://192.168.1.8:43656', 'priority': 2},
              {'type': 'lan', 'url': 'http://192.168.1.8:43656', 'priority': 3},
            ],
          ),
        ),
      );
      expect(payload.candidates, hasLength(1));
      expect(payload.candidates.single.url.host, '192.168.1.8');
    });
  });

  group('normalizeServerAddress', () {
    test('defaults to HTTP and removes a trailing slash', () {
      final uri = normalizeServerAddress('192.168.1.8:43656/');
      expect(uri.toString(), 'http://192.168.1.8:43656');
    });

    test('keeps HTTPS', () {
      expect(
        normalizeServerAddress('https://denia.example.com').toString(),
        'https://denia.example.com',
      );
    });

    test('rejects missing host, non-HTTP schemes and query strings', () {
      expect(
        () => normalizeServerAddress(''),
        throwsA(isA<PairingException>()),
      );
      expect(
        () => normalizeServerAddress('ftp://host'),
        throwsA(isA<PairingException>()),
      );
      expect(
        () => normalizeServerAddress('http://host:43656/?x=1'),
        throwsA(isA<PairingException>()),
      );
    });
  });
}
