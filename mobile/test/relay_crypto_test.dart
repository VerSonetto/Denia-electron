import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:denia_mobile/data/relay_crypto.dart';
import 'package:flutter_test/flutter_test.dart';

Uint8List _bytes(int length, [int seed = 1]) {
  final random = Random(seed);
  return Uint8List.fromList(
    List<int>.generate(length, (_) => random.nextInt(256)),
  );
}

void main() {
  group('relay handshake', () {
    test('derives the same two AES keys on both sides', () async {
      final clientKeyPair = await X25519().newKeyPair();
      final hostKeyPair = await X25519().newKeyPair();
      final clientPublic = await clientKeyPair.extractPublicKey();
      final hostPublic = await hostKeyPair.extractPublicKey();
      final nonce = _bytes(16, 7);

      final client = RelayClientHandshake(clientKeyPair, nonce);
      final clientKeys = await client.finish(
        Uint8List.fromList(hostPublic.bytes),
      );

      final shared = await X25519().sharedSecretKey(
        keyPair: hostKeyPair,
        remotePublicKey: SimplePublicKey(
          clientPublic.bytes,
          type: KeyPairType.x25519,
        ),
      );
      final hkdf = Hkdf(hmac: Hmac.sha256(), outputLength: 64);
      final derived = await hkdf.deriveKey(
        secretKey: shared,
        nonce: nonce,
        info: utf8.encode(relayHkdfInfo),
      );
      final hostKeys = Uint8List.fromList(await derived.extractBytes());

      expect(clientKeys.clientToHost, hostKeys.sublist(0, 32));
      expect(clientKeys.hostToClient, hostKeys.sublist(32, 64));
      expect(clientKeys.clientToHost, isNot(clientKeys.hostToClient));
    });
  });

  group('relay encryption', () {
    test('round-trips frames and rejects tampering', () async {
      final key = _bytes(32, 3);
      final encryptor = RelayEncryptor(key);
      final decryptor = RelayDecryptor(key);

      final first = await encryptor.encrypt(Uint8List.fromList([1, 2, 3]));
      final second = await encryptor.encrypt(Uint8List(0));
      expect(await decryptor.decrypt(first), [1, 2, 3]);
      expect(await decryptor.decrypt(second), isEmpty);

      final later = await encryptor.encrypt(Uint8List.fromList([4]));
      final tampered = Uint8List.fromList(later);
      tampered[encryptedFrameHeaderBytes] ^= 1;
      await expectLater(
        decryptor.decrypt(tampered),
        throwsA(isA<RelayCryptoException>()),
      );
    });

    test('rejects replayed and skipped counters', () async {
      final key = _bytes(32, 4);
      final encryptor = RelayEncryptor(key);
      final decryptor = RelayDecryptor(key);
      final first = await encryptor.encrypt(Uint8List.fromList([1]));
      final second = await encryptor.encrypt(Uint8List.fromList([2]));
      await decryptor.decrypt(first);

      expect(decryptor.decrypt(first), throwsA(isA<RelayCryptoException>()));
      await decryptor.decrypt(second);
      expect(decryptor.decrypt(second), throwsA(isA<RelayCryptoException>()));
    });

    test('enforces the plaintext frame limit', () async {
      final encryptor = RelayEncryptor(_bytes(32, 5));
      await expectLater(
        encryptor.encrypt(Uint8List(maxPlaintextFrameBytes + 1)),
        throwsA(isA<RelayCryptoException>()),
      );
    });
  });

  group('tunnel frames', () {
    test('round-trips type, stream and payload', () {
      final payload = encodeJsonPayload({'path': '/api/sessions'});
      final decoded = decodeTunnelFrame(
        encodeTunnelFrame(RelayFrameType.httpRequest, 42, payload),
      );
      expect(decoded.type, RelayFrameType.httpRequest);
      expect(decoded.streamId, 42);
      expect(decodeJsonPayload(decoded.payload), {'path': '/api/sessions'});
    });

    test('rejects unknown types and oversized payloads', () {
      final raw = Uint8List(tunnelFrameHeaderBytes);
      raw[0] = 99;
      expect(
        () => decodeTunnelFrame(raw),
        throwsA(isA<RelayCryptoException>()),
      );
      expect(
        () => encodeTunnelFrame(
          RelayFrameType.httpBody,
          1,
          Uint8List(maxTunnelPayloadBytes + 1),
        ),
        throwsA(isA<RelayCryptoException>()),
      );
    });
  });
}
