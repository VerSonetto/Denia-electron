import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  chunkBytes,
  createRelayDecryptor,
  createRelayEncryptor,
  decodeJsonPayload,
  decodeTunnelFrame,
  deriveRelaySessionKeys,
  deriveRelaySessionKeysForClient,
  encodeJsonPayload,
  encodeTunnelFrame,
  ENCRYPTED_FRAME_HEADER_BYTES,
  loadRelayIdentity,
  MAX_PLAINTEXT_FRAME_BYTES,
  MAX_TUNNEL_PAYLOAD_BYTES,
  RelayCryptoError,
  TunnelFrameType,
} from '../src/host/relay-crypto.ts'

test('host identity is stable and recreated only when unreadable', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-relay-crypto-'))
  const first = loadRelayIdentity(home)
  const second = loadRelayIdentity(home)
  assert.equal(first.publicJwk.x, second.publicJwk.x)
  assert.equal(fs.statSync(path.join(home, 'relay-identity.json')).isFile(), true)

  fs.writeFileSync(path.join(home, 'relay-identity.json'), '{broken', 'utf8')
  const third = loadRelayIdentity(home)
  assert.notEqual(third.publicJwk.x, first.publicJwk.x)
  assert.match(third.publicJwk.x, /^[A-Za-z0-9_-]+$/)
})

test('host and client derive identical directional keys', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519')
  const clientPublicJwk = publicKey.export({ format: 'jwk' })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-relay-keys-'))
  const identity = loadRelayIdentity(home)
  const nonce = crypto.randomBytes(16)

  const hostKeys = deriveRelaySessionKeys(
    identity.privateKey,
    clientPublicJwk,
    nonce,
  )
  const clientKeys = deriveRelaySessionKeysForClient(
    privateKey,
    identity.publicJwk,
    nonce,
  )

  assert.deepEqual(hostKeys.clientToHost, clientKeys.clientToHost)
  assert.deepEqual(hostKeys.hostToClient, clientKeys.hostToClient)
  assert.equal(hostKeys.clientToHost.length, 32)
  assert.equal(hostKeys.hostToClient.length, 32)
  assert.notDeepEqual(hostKeys.clientToHost, hostKeys.hostToClient)
})

test('AES-GCM frames reject tampering, replay and gaps', () => {
  const key = crypto.randomBytes(32)
  const encryptor = createRelayEncryptor(key)
  const decryptor = createRelayDecryptor(key)

  const first = encryptor.encrypt(Buffer.from('one'))
  const second = encryptor.encrypt(Buffer.alloc(0))
  assert.equal(decryptor.decrypt(first).toString(), 'one')
  assert.equal(decryptor.decrypt(second).length, 0)

  assert.throws(() => decryptor.decrypt(first), RelayCryptoError)
  const third = encryptor.encrypt(Buffer.from('three'))
  assert.equal(decryptor.decrypt(third).toString(), 'three')

  const fourth = encryptor.encrypt(Buffer.from('four'))
  const tampered = Buffer.from(fourth)
  tampered[ENCRYPTED_FRAME_HEADER_BYTES]! ^= 1
  assert.throws(() => decryptor.decrypt(tampered), RelayCryptoError)

  const fifth = encryptor.encrypt(Buffer.from('five'))
  assert.throws(() => decryptor.decrypt(fifth), RelayCryptoError)
})

test('frame helpers enforce bounds and round-trip JSON', () => {
  const payload = encodeJsonPayload({ path: '/api/sessions' })
  const frame = decodeTunnelFrame(
    encodeTunnelFrame(TunnelFrameType.HttpRequest, 7, payload),
  )
  assert.equal(frame.type, TunnelFrameType.HttpRequest)
  assert.equal(frame.streamId, 7)
  assert.deepEqual(decodeJsonPayload(frame.payload), {
    path: '/api/sessions',
  })

  assert.throws(
    () =>
      encodeTunnelFrame(
        TunnelFrameType.HttpBody,
        1,
        Buffer.alloc(MAX_TUNNEL_PAYLOAD_BYTES + 1),
      ),
    RelayCryptoError,
  )
  assert.throws(
    () =>
      createRelayEncryptor(crypto.randomBytes(32)).encrypt(
        Buffer.alloc(MAX_PLAINTEXT_FRAME_BYTES + 1),
      ),
    RelayCryptoError,
  )
  assert.throws(() => encodeTunnelFrame(TunnelFrameType.HttpBody, -1), RelayCryptoError)
  assert.deepEqual(chunkBytes(Buffer.alloc(0)), [Buffer.alloc(0)])
  assert.equal(chunkBytes(Buffer.alloc(70_000), 32_000).length, 3)
})

test('invalid handshake inputs are rejected', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-relay-invalid-'))
  const identity = loadRelayIdentity(home)
  assert.throws(
    () =>
      deriveRelaySessionKeys(
        identity.privateKey,
        publicKey.export({ format: 'jwk' }),
        Buffer.alloc(15),
      ),
    RelayCryptoError,
  )
  assert.throws(
    () =>
      deriveRelaySessionKeysForClient(
        privateKey,
        { kty: 'OKP', crv: 'X25519', x: '***' },
        Buffer.alloc(16),
      ),
    RelayCryptoError,
  )
})
