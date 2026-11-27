import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';

/// Denia relay protocol v1.
///
/// X25519 handshake -> HKDF-SHA256 -> two AES-256-GCM streams. Frames are
/// [version][12-byte IV][ciphertext][16-byte tag], with a random IV prefix and
/// a strict per-direction counter. The relay only sees these ciphertexts.
const int relayProtocolVersion = 1;
const String relayHkdfInfo = 'denia-relay-v1';
const int maxPlaintextFrameBytes = 64 * 1024;
const int encryptedFrameVersion = 1;
const int encryptedFrameIvBytes = 12;
const int encryptedFrameHeaderBytes = 1 + encryptedFrameIvBytes;
const int gcmTagBytes = 16;

class RelayCryptoException implements Exception {
  RelayCryptoException(this.message);

  final String message;

  @override
  String toString() => message;
}

String encodeBase64Url(Uint8List bytes) =>
    base64Url.encode(bytes).replaceAll('=', '');

Uint8List decodeBase64Url(String value) {
  var normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  final remainder = normalized.length % 4;
  if (remainder == 1) throw RelayCryptoException('无效的 base64url');
  if (remainder > 0) {
    normalized = normalized.padRight(normalized.length + 4 - remainder, '=');
  }
  return Uint8List.fromList(base64.decode(normalized));
}

class RelayClientHandshake {
  RelayClientHandshake(this._keyPair, this.nonce);

  final SimpleKeyPair _keyPair;
  final Uint8List nonce;

  static Future<RelayClientHandshake> create() async {
    final keyPair = await X25519().newKeyPair();
    final random = Random.secure();
    final nonce = Uint8List.fromList(
      List<int>.generate(16, (_) => random.nextInt(256)),
    );
    return RelayClientHandshake(keyPair, nonce);
  }

  Future<Uint8List> publicKeyBytes() async {
    final publicKey = await _keyPair.extractPublicKey();
    return Uint8List.fromList(publicKey.bytes);
  }

  Future<RelaySessionKeys> finish(Uint8List hostPublicKey) async {
    final shared = await X25519().sharedSecretKey(
      keyPair: _keyPair,
      remotePublicKey: SimplePublicKey(hostPublicKey, type: KeyPairType.x25519),
    );
    final hkdf = Hkdf(hmac: Hmac.sha256(), outputLength: 64);
    final derived = await hkdf.deriveKey(
      secretKey: shared,
      nonce: nonce,
      info: utf8.encode(relayHkdfInfo),
    );
    final bytes = Uint8List.fromList(await derived.extractBytes());
    if (bytes.length != 64) throw RelayCryptoException('HKDF 输出长度错误');
    return RelaySessionKeys(
      clientToHost: Uint8List.sublistView(bytes, 0, 32),
      hostToClient: Uint8List.sublistView(bytes, 32, 64),
    );
  }
}

class RelaySessionKeys {
  const RelaySessionKeys({
    required this.clientToHost,
    required this.hostToClient,
  });

  final Uint8List clientToHost;
  final Uint8List hostToClient;
}

class RelayEncryptor {
  RelayEncryptor(this._key)
    : _prefix = Uint8List.fromList(
        List<int>.generate(4, (_) => Random.secure().nextInt(256)),
      );

  final Uint8List _key;
  final Uint8List _prefix;
  final AesGcm _cipher = AesGcm.with256bits();
  int _counter = 0;

  Future<Uint8List> encrypt(Uint8List plaintext) async {
    if (plaintext.length > maxPlaintextFrameBytes) {
      throw RelayCryptoException('明文帧过大');
    }
    _counter += 1;
    final iv = Uint8List(encryptedFrameIvBytes);
    iv.setRange(0, 4, _prefix);
    _writeCounter(iv, 4, _counter);
    final box = await _cipher.encrypt(
      plaintext,
      secretKey: SecretKey(_key),
      nonce: iv,
    );
    final cipherText = Uint8List.fromList(box.cipherText);
    final mac = Uint8List.fromList(box.mac.bytes);
    final frame = Uint8List(
      encryptedFrameHeaderBytes + cipherText.length + mac.length,
    );
    frame[0] = encryptedFrameVersion;
    frame.setRange(1, encryptedFrameHeaderBytes, iv);
    frame.setRange(
      encryptedFrameHeaderBytes,
      encryptedFrameHeaderBytes + cipherText.length,
      cipherText,
    );
    frame.setRange(
      encryptedFrameHeaderBytes + cipherText.length,
      frame.length,
      mac,
    );
    return frame;
  }

  static void _writeCounter(Uint8List target, int offset, int counter) {
    var value = counter;
    for (var index = 0; index < 8; index += 1) {
      target[offset + index] = (value >> ((7 - index) * 8)) & 0xff;
    }
  }
}

class RelayDecryptor {
  RelayDecryptor(this._key);

  final Uint8List _key;
  final AesGcm _cipher = AesGcm.with256bits();
  int _lastCounter = 0;

  Future<Uint8List> decrypt(Uint8List frame) async {
    if (frame.length < encryptedFrameHeaderBytes + gcmTagBytes) {
      throw RelayCryptoException('加密帧过短');
    }
    if (frame[0] != encryptedFrameVersion) {
      throw RelayCryptoException('加密帧版本不支持');
    }
    final iv = Uint8List.sublistView(frame, 1, encryptedFrameHeaderBytes);
    final counter = _readCounter(iv, 4);
    if (counter <= _lastCounter) {
      throw RelayCryptoException('帧计数器回退');
    }
    if (counter != _lastCounter + 1) {
      throw RelayCryptoException('帧计数器跳号');
    }
    final tagStart = frame.length - gcmTagBytes;
    final cipherText = Uint8List.sublistView(
      frame,
      encryptedFrameHeaderBytes,
      tagStart,
    );
    final mac = Mac(Uint8List.sublistView(frame, tagStart));
    try {
      final plaintext = await _cipher.decrypt(
        SecretBox(cipherText, nonce: iv, mac: mac),
        secretKey: SecretKey(_key),
      );
      _lastCounter = counter;
      return Uint8List.fromList(plaintext);
    } catch (_) {
      throw RelayCryptoException('帧认证失败');
    }
  }

  static int _readCounter(Uint8List source, int offset) {
    var value = 0;
    for (var index = 0; index < 8; index += 1) {
      value = (value << 8) | source[offset + index];
    }
    return value;
  }
}

// —— tunnel frames ——

class RelayFrameType {
  static const httpRequest = 1;
  static const httpBody = 2;
  static const httpResponse = 3;
  static const streamEnd = 4;
  static const streamAbort = 5;
  static const ping = 6;
  static const pong = 7;
}

const int tunnelFrameHeaderBytes = 5;
const int maxTunnelPayloadBytes =
    maxPlaintextFrameBytes - tunnelFrameHeaderBytes;

class RelayTunnelFrame {
  const RelayTunnelFrame({
    required this.type,
    required this.streamId,
    required this.payload,
  });

  final int type;
  final int streamId;
  final Uint8List payload;
}

Uint8List encodeTunnelFrame(int type, int streamId, [Uint8List? payload]) {
  final bytes = payload ?? Uint8List(0);
  if (bytes.length > maxTunnelPayloadBytes) {
    throw RelayCryptoException('隧道帧过大');
  }
  final frame = Uint8List(tunnelFrameHeaderBytes + bytes.length);
  frame[0] = type;
  ByteData.sublistView(frame).setUint32(1, streamId, Endian.big);
  frame.setRange(tunnelFrameHeaderBytes, frame.length, bytes);
  return frame;
}

RelayTunnelFrame decodeTunnelFrame(Uint8List plaintext) {
  if (plaintext.length < tunnelFrameHeaderBytes) {
    throw RelayCryptoException('隧道帧过短');
  }
  final type = plaintext[0];
  if (type < 1 || type > 7) throw RelayCryptoException('未知隧道帧类型');
  final streamId = ByteData.sublistView(plaintext).getUint32(1, Endian.big);
  return RelayTunnelFrame(
    type: type,
    streamId: streamId,
    payload: Uint8List.sublistView(plaintext, tunnelFrameHeaderBytes),
  );
}

Uint8List encodeJsonPayload(Object value) =>
    Uint8List.fromList(utf8.encode(jsonEncode(value)));

Map<String, dynamic> decodeJsonPayload(Uint8List payload) {
  try {
    final value = jsonDecode(utf8.decode(payload));
    if (value is! Map) throw const FormatException();
    return value.map((key, entry) => MapEntry(key.toString(), entry));
  } catch (_) {
    throw RelayCryptoException('隧道 JSON 载荷损坏');
  }
}
