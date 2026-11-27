import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { WebSocket } from 'ws'

import {
  createRelayDecryptor,
  createRelayEncryptor,
  decodeTunnelFrame,
  deriveRelaySessionKeysForClient,
  encodeJsonPayload,
  encodeTunnelFrame,
  loadRelayIdentity,
  TunnelFrameType,
  type RelayPublicJwk,
} from '../src/host/relay-crypto.ts'
import { RelayHostClient, RelayServer } from '../src/host/relay.ts'

interface ClientChannel {
  ws: WebSocket
  encrypt: ReturnType<typeof createRelayEncryptor>
  decrypt: ReturnType<typeof createRelayDecryptor>
  responses: Map<number, { status: number; headers: Record<string, string>; body: Buffer[]; ended: boolean }>
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await wait(20)
  }
}

const openClient = async (relayUrl: string, serverId: string, hostPublicJwk: RelayPublicJwk): Promise<ClientChannel> => {
  const url = new URL(relayUrl)
  url.searchParams.set('v', '1')
  url.searchParams.set('role', 'client')
  url.searchParams.set('serverId', serverId)
  const ws = new WebSocket(url)
  const responses = new Map<number, { status: number; headers: Record<string, string>; body: Buffer[]; ended: boolean }>()
  let encrypt: ReturnType<typeof createRelayEncryptor> | null = null
  let decrypt: ReturnType<typeof createRelayDecryptor> | null = null
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519')
  const publicJwk = publicKey.export({ format: 'jwk' }) as crypto.JsonWebKey
  const nonce = crypto.randomBytes(16)
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ready timeout')), 5000)
    ws.on('open', () => {
      ws.send(JSON.stringify({
        t: 'hello',
        v: 1,
        pub: { kty: 'OKP', crv: 'X25519', x: String(publicJwk.x) },
        nonce: nonce.toString('base64url'),
      }))
    })
    ws.on('message', (data, isBinary) => {
      if (!encrypt) {
        if (isBinary) {
          reject(new Error('ready was binary'))
          return
        }
        const message = JSON.parse(data.toString()) as { t?: string }
        if (message.t !== 'ready') return
        const keys = deriveRelaySessionKeysForClient(privateKey, hostPublicJwk, nonce)
        encrypt = createRelayEncryptor(keys.clientToHost)
        decrypt = createRelayDecryptor(keys.hostToClient)
        clearTimeout(timer)
        resolve()
        return
      }
      const frame = decodeTunnelFrame(decrypt!.decrypt(Buffer.from(data as Buffer)))
      const entry = responses.get(frame.streamId)
      if (!entry) return
      if (frame.type === TunnelFrameType.HttpResponse) {
        const payload = JSON.parse(frame.payload.toString()) as { status: number; headers: Record<string, string> }
        entry.status = payload.status
        entry.headers = payload.headers
      } else if (frame.type === TunnelFrameType.HttpBody) {
        entry.body.push(Buffer.from(frame.payload))
      } else if (frame.type === TunnelFrameType.StreamEnd) {
        entry.ended = true
      }
    })
    ws.on('error', reject)
  })
  await ready
  return { ws, encrypt: encrypt!, decrypt: decrypt!, responses }
}

const sendRequest = async (channel: ClientChannel, streamId: number, pathname: string) => {
  channel.responses.set(streamId, { status: 0, headers: {}, body: [], ended: false })
  channel.ws.send(channel.encrypt.encrypt(encodeTunnelFrame(
    TunnelFrameType.HttpRequest,
    streamId,
    encodeJsonPayload({
      method: 'GET',
      path: pathname,
      query: '',
      headers: { authorization: 'Bearer test', accept: 'application/json' },
      hasBody: false,
    }),
  )), { binary: true })
}

test('relay forwards HTTP and streams SSE through E2EE', async () => {
  const seenPaths: string[] = []
  const remote = http.createServer((req, res) => {
    seenPaths.push(req.url ?? '')
    const seenProof = req.headers['x-denia-relay-proof']
    assert.equal(typeof seenProof, 'string')
    assert.equal(req.headers.origin, `http://127.0.0.1:${(remote.address() as { port: number }).port}`)
    if (req.url === '/api/remote/status') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, via: 'relay' }))
      return
    }
    if (req.url === '/api/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write('data: one\n\n')
      setTimeout(() => res.end('data: two\n\n'), 300)
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => remote.listen(0, '127.0.0.1', resolve))
  const remotePort = (remote.address() as { port: number }).port

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-relay-'))
  const identity = loadRelayIdentity(home)
  const server = new RelayServer()
  const relayPort = 0
  const hostToken = crypto.randomBytes(32).toString('base64url')
  const serverStatus = await server.start(hostToken, relayPort)
  const relayUrl = `ws://127.0.0.1:${serverStatus.port}/ws`
  const serverId = 'abcdef0123456789'
  let hostState = 'idle'
  const host = new RelayHostClient({
    relayUrl,
    hostToken,
    serverId,
    identity,
    remotePort: () => remotePort,
    onStatus: (status) => {
      hostState = status.state
    },
  })
  host.start()
  await until(() => hostState === 'connected')
  await wait(50)

  const channel = await openClient(relayUrl, serverId, identity.publicJwk)
  await sendRequest(channel, 1, '/api/remote/status')
  await until(() => channel.responses.get(1)?.ended === true)
  const response = channel.responses.get(1)!
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(Buffer.concat(response.body).toString()), { ok: true, via: 'relay' })

  const startedAt = Date.now()
  await sendRequest(channel, 2, '/api/sse')
  await until(() => channel.responses.get(2)?.body.length === 1)
  const firstBodyAt = Date.now()
  assert.ok(firstBodyAt - startedAt < 2500, 'first SSE chunk should arrive before the stream ends')
  await until(() => channel.responses.get(2)?.ended === true)
  assert.match(Buffer.concat(channel.responses.get(2)!.body).toString(), /one[\s\S]*two/)

  // The host dispatcher only exposes /api/*. A client cannot use the relay as
  // a generic loopback proxy to the desktop's other ports or files.
  await sendRequest(channel, 3, '/etc/passwd')
  await until(() => channel.responses.get(3)?.ended === true)
  assert.equal(channel.responses.get(3)!.status, 403)
  assert.equal(JSON.parse(Buffer.concat(channel.responses.get(3)!.body).toString()).error, 'relay/path-blocked')
  assert.ok(!seenPaths.includes('/etc/passwd'), 'blocked path must never reach the loopback server')

  channel.ws.close()
  host.stop()
  await server.stop()
  await new Promise<void>((resolve) => remote.close(() => resolve()))
})


test('relay rejects host sockets without the process token', async () => {
  const server = new RelayServer()
  const status = await server.start('correct-token', 0)
  try {
    const url = new URL(`ws://127.0.0.1:${status.port}/ws`)
    url.searchParams.set('role', 'host-control')
    url.searchParams.set('serverId', 'abcdef0123456789')
    url.searchParams.set('token', 'wrong-token')
    const ws = new WebSocket(url)
    const statusCode = await new Promise<number>((resolve, reject) => {
      ws.on('unexpected-response', (_request, response) => {
        response.resume()
        resolve(response.statusCode ?? 0)
      })
      ws.on('error', reject)
    })
    assert.equal(statusCode, 401)
  } finally {
    await server.stop()
  }
})
