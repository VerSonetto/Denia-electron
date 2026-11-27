// Shared crypto and framing for Denia's private relay (protocol v1).
//
// The relay is an untrusted courier. Client and host agree on X25519 keys,
// derive two AES-256-GCM keys with HKDF-SHA256, and send length-unbounded
// HTTP/SSE streams as small encrypted frames. No plaintext application bytes
// leave the two endpoints.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const RELAY_PROTOCOL_VERSION = 1
export const RELAY_HKDF_INFO = 'denia-relay-v1'
export const MAX_PLAINTEXT_FRAME_BYTES = 64 * 1024
export const ENCRYPTED_FRAME_VERSION = 1
export const ENCRYPTED_FRAME_IV_BYTES = 12
export const ENCRYPTED_FRAME_HEADER_BYTES = 1 + ENCRYPTED_FRAME_IV_BYTES
const GCM_TAG_BYTES = 16
const IV_PREFIX_BYTES = 4
const IV_COUNTER_BYTES = 8

export interface RelayPublicJwk {
  kty: 'OKP'
  crv: 'X25519'
  x: string
}

interface StoredIdentity {
  publicJwk: RelayPublicJwk
  privateJwk: crypto.JsonWebKey
  createdAt: string
}

export interface RelayIdentity {
  publicJwk: RelayPublicJwk
  privateKey: crypto.KeyObject
}

export class RelayCryptoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RelayCryptoError'
  }
}

const isPublicJwk = (value: unknown): value is RelayPublicJwk => {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return record.kty === 'OKP' && record.crv === 'X25519' && typeof record.x === 'string' && record.x.length > 0
}

/** Load the long-lived host encryption identity, creating it once. */
export const loadRelayIdentity = (home: string): RelayIdentity => {
  const file = path.join(home, 'relay-identity.json')
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<StoredIdentity>
      if (isPublicJwk(parsed.publicJwk) && parsed.privateJwk && typeof parsed.privateJwk === 'object') {
        return {
          publicJwk: parsed.publicJwk,
          privateKey: crypto.createPrivateKey({ key: parsed.privateJwk, format: 'jwk' }),
        }
      }
    }
  } catch {
    // A corrupt identity is unusable; minting a new one asks devices to re-pair.
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519')
  const publicJwkRaw = publicKey.export({ format: 'jwk' }) as crypto.JsonWebKey
  const privateJwk = privateKey.export({ format: 'jwk' }) as crypto.JsonWebKey
  const publicJwk: RelayPublicJwk = {
    kty: 'OKP',
    crv: 'X25519',
    x: String(publicJwkRaw.x ?? ''),
  }
  fs.mkdirSync(home, { recursive: true })
  const stored: StoredIdentity = {
    publicJwk,
    privateJwk,
    createdAt: new Date().toISOString(),
  }
  fs.writeFileSync(file, JSON.stringify(stored, null, 2), { encoding: 'utf8', mode: 0o600 })
  return { publicJwk, privateKey }
}

const decodeBase64Url = (value: string): Buffer => {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) {
    throw new RelayCryptoError('invalid base64url')
  }
  return Buffer.from(value, 'base64url')
}

export const encodeBase64Url = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString('base64url')

export const importClientPublicKey = (jwk: unknown): crypto.KeyObject => {
  if (!isPublicJwk(jwk)) throw new RelayCryptoError('invalid X25519 public key')
  decodeBase64Url(jwk.x)
  try {
    return crypto.createPublicKey({ key: jwk as unknown as crypto.JsonWebKey, format: 'jwk' })
  } catch {
    throw new RelayCryptoError('invalid X25519 public key')
  }
}

export interface RelaySessionKeys {
  clientToHost: Buffer
  hostToClient: Buffer
}

export const deriveRelaySessionKeys = (
  hostPrivateKey: crypto.KeyObject,
  clientPublicJwk: unknown,
  nonce: Uint8Array,
): RelaySessionKeys => {
  if (nonce.length !== 16) throw new RelayCryptoError('invalid handshake nonce')
  const clientPublicKey = importClientPublicKey(clientPublicJwk)
  let shared: Buffer
  try {
    shared = crypto.diffieHellman({ privateKey: hostPrivateKey, publicKey: clientPublicKey })
  } catch {
    throw new RelayCryptoError('key agreement failed')
  }
  return deriveKeys(shared, nonce)
}

/** Client side of the same handshake; used by tests and tooling. */
export const deriveRelaySessionKeysForClient = (
  clientPrivateKey: crypto.KeyObject,
  hostPublicJwk: RelayPublicJwk,
  nonce: Uint8Array,
): RelaySessionKeys => {
  if (nonce.length !== 16) throw new RelayCryptoError('invalid handshake nonce')
  decodeBase64Url(hostPublicJwk.x)
  let shared: Buffer
  try {
    const hostPublicKey = crypto.createPublicKey({
      key: hostPublicJwk as unknown as crypto.JsonWebKey,
      format: 'jwk',
    })
    shared = crypto.diffieHellman({ privateKey: clientPrivateKey, publicKey: hostPublicKey })
  } catch {
    throw new RelayCryptoError('key agreement failed')
  }
  return deriveKeys(shared, nonce)
}

const deriveKeys = (shared: Buffer, nonce: Uint8Array): RelaySessionKeys => {
  const derived = Buffer.from(
    crypto.hkdfSync(
      'sha256',
      shared,
      nonce,
      Buffer.from(RELAY_HKDF_INFO, 'utf8'),
      64,
    ),
  )
  return {
    clientToHost: derived.subarray(0, 32),
    hostToClient: derived.subarray(32, 64),
  }
}

export interface RelayEncryptor {
  encrypt(plaintext: Buffer): Buffer
}

export interface RelayDecryptor {
  decrypt(frame: Buffer): Buffer
}

const writeCounter = (target: Buffer, offset: number, counter: bigint): void => {
  for (let index = IV_COUNTER_BYTES - 1; index >= 0; index -= 1) {
    target[offset + index] = Number(counter & 0xffn)
    counter >>= 8n
  }
}

const readCounter = (source: Buffer, offset: number): bigint => {
  let value = 0n
  for (let index = 0; index < IV_COUNTER_BYTES; index += 1) {
    value = (value << 8n) | BigInt(source[offset + index] ?? 0)
  }
  return value
}

export const createRelayEncryptor = (key: Buffer): RelayEncryptor => {
  const ivPrefix = crypto.randomBytes(IV_PREFIX_BYTES)
  let counter = 0n
  return {
    encrypt(plaintext: Buffer): Buffer {
      if (plaintext.length > MAX_PLAINTEXT_FRAME_BYTES) {
        throw new RelayCryptoError('plaintext frame too large')
      }
      counter += 1n
      const iv = Buffer.alloc(ENCRYPTED_FRAME_IV_BYTES)
      ivPrefix.copy(iv, 0)
      writeCounter(iv, IV_PREFIX_BYTES, counter)
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
      const tag = cipher.getAuthTag()
      const frame = Buffer.alloc(ENCRYPTED_FRAME_HEADER_BYTES + ciphertext.length + GCM_TAG_BYTES)
      frame[0] = ENCRYPTED_FRAME_VERSION
      iv.copy(frame, 1)
      ciphertext.copy(frame, ENCRYPTED_FRAME_HEADER_BYTES)
      tag.copy(frame, ENCRYPTED_FRAME_HEADER_BYTES + ciphertext.length)
      return frame
    },
  }
}

export const createRelayDecryptor = (key: Buffer): RelayDecryptor => {
  let lastCounter = 0n
  return {
    decrypt(frame: Buffer): Buffer {
      if (frame.length < ENCRYPTED_FRAME_HEADER_BYTES + GCM_TAG_BYTES) {
        throw new RelayCryptoError('encrypted frame too short')
      }
      if (frame[0] !== ENCRYPTED_FRAME_VERSION) {
        throw new RelayCryptoError('unsupported encrypted frame version')
      }
      const iv = frame.subarray(1, ENCRYPTED_FRAME_HEADER_BYTES)
      const counter = readCounter(iv, IV_PREFIX_BYTES)
      if (counter !== lastCounter + 1n) {
        throw new RelayCryptoError(counter <= lastCounter ? 'frame counter regression' : 'frame counter gap')
      }
      const tagStart = frame.length - GCM_TAG_BYTES
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
      decipher.setAuthTag(frame.subarray(tagStart))
      let plaintext: Buffer
      try {
        plaintext = Buffer.concat([
          decipher.update(frame.subarray(ENCRYPTED_FRAME_HEADER_BYTES, tagStart)),
          decipher.final(),
        ])
      } catch {
        throw new RelayCryptoError('frame authentication failed')
      }
      lastCounter = counter
      return plaintext
    },
  }
}

// —— tunnel frames (inside the encrypted channel) ——

export const TunnelFrameType = {
  HttpRequest: 1,
  HttpBody: 2,
  HttpResponse: 3,
  StreamEnd: 4,
  StreamAbort: 5,
  Ping: 6,
  Pong: 7,
} as const

export type TunnelFrameTypeValue = (typeof TunnelFrameType)[keyof typeof TunnelFrameType]

const FRAME_TYPES = new Set<number>(Object.values(TunnelFrameType))
export const TUNNEL_FRAME_HEADER_BYTES = 5
export const MAX_TUNNEL_PAYLOAD_BYTES = MAX_PLAINTEXT_FRAME_BYTES - TUNNEL_FRAME_HEADER_BYTES

export interface TunnelFrame {
  type: TunnelFrameTypeValue
  streamId: number
  payload: Buffer
}

export const encodeTunnelFrame = (
  type: TunnelFrameTypeValue,
  streamId: number,
  payload: Uint8Array = new Uint8Array(0),
): Buffer => {
  if (!Number.isInteger(streamId) || streamId < 0 || streamId > 0xffffffff) {
    throw new RelayCryptoError('invalid stream id')
  }
  if (payload.length > MAX_TUNNEL_PAYLOAD_BYTES) {
    throw new RelayCryptoError('tunnel payload too large')
  }
  const frame = Buffer.alloc(TUNNEL_FRAME_HEADER_BYTES + payload.length)
  frame[0] = type
  frame.writeUInt32BE(streamId, 1)
  Buffer.from(payload).copy(frame, TUNNEL_FRAME_HEADER_BYTES)
  return frame
}

export const decodeTunnelFrame = (plaintext: Buffer): TunnelFrame => {
  if (plaintext.length < TUNNEL_FRAME_HEADER_BYTES) {
    throw new RelayCryptoError('tunnel frame too short')
  }
  const type = plaintext[0] as number
  if (!FRAME_TYPES.has(type)) throw new RelayCryptoError(`unknown tunnel frame type ${type}`)
  return {
    type: type as TunnelFrameTypeValue,
    streamId: plaintext.readUInt32BE(1),
    payload: plaintext.subarray(TUNNEL_FRAME_HEADER_BYTES),
  }
}

export const encodeJsonPayload = (value: unknown): Buffer =>
  Buffer.from(JSON.stringify(value), 'utf8')

export const decodeJsonPayload = <T>(payload: Buffer): T => {
  try {
    return JSON.parse(payload.toString('utf8')) as T
  } catch {
    throw new RelayCryptoError('malformed JSON tunnel payload')
  }
}

export const chunkBytes = (bytes: Buffer, size = 32 * 1024): Buffer[] => {
  if (bytes.length === 0) return [Buffer.alloc(0)]
  const chunks: Buffer[] = []
  for (let offset = 0; offset < bytes.length; offset += size) {
    chunks.push(bytes.subarray(offset, offset + size))
  }
  return chunks
}
