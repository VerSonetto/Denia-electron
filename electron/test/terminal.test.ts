// Terminal tests: byte-buffer invariants plus a real PTY over REST + WS.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import WebSocket from 'ws'

import { startHost } from '../src/host/server.ts'
import { shellFromExecutable } from '../src/tools/bash.ts'
import {
  appendScrollback,
  decodeBase64,
  encodeBase64,
  findCursorQueries,
  SCROLLBACK_LIMIT,
  TerminalManager,
} from '../src/terminal/manager.ts'

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** Keep terminal tests independent of the developer's terminal profile. */
function testShell() {
  return shellFromExecutable(process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/bash')
}

test('terminal scrollback stays bounded and never cuts a UTF-8 character', () => {
  let buffer: Buffer = Buffer.alloc(0)
  const chunk = Buffer.from('汉'.repeat(4_096), 'utf8')
  for (let index = 0; index < Math.ceil(SCROLLBACK_LIMIT / chunk.length) + 2; index += 1) {
    buffer = appendScrollback(buffer, chunk)
    assert.ok(buffer.length <= SCROLLBACK_LIMIT)
    assert.doesNotThrow(() => new TextDecoder('utf-8', { fatal: true }).decode(buffer))
  }
})

test('terminal cursor queries are answered across split chunks', () => {
  const first = findCursorQueries('', 'prompt\x1b[6')
  assert.equal(first.replies, 0)
  const second = findCursorQueries(first.carry, 'n rest')
  assert.equal(second.replies, 1)
  const twice = findCursorQueries('', '\x1b[6n\x1b[6n')
  assert.equal(twice.replies, 2)
})

test('terminal base64 rejects malformed input', () => {
  const raw = Buffer.from('\x1b[31m中文\x1b[0m\r\n', 'utf8')
  assert.deepEqual(decodeBase64(encodeBase64(raw)), raw)
  assert.throws(() => decodeBase64('not base64!!'), /合法 base64/)
})

test('terminal manager creates a real PTY and exposes its bytes', { timeout: 30_000 }, async () => {
  const home = tempDir('denia-terminal-manager-')
  const manager = new TerminalManager({ home, shell: testShell })
  try {
    let output = Buffer.alloc(0)
    let id = ''
    const firstData = Promise.withResolvers<void>()
    const unsubscribe = manager.subscribe((event) => {
      if (event.type === 'data' && event.terminalId === id) {
        output = Buffer.concat([output, Buffer.from(event.data, 'base64')])
        firstData.resolve()
      }
    })
    const info = manager.create(home, 90, 24)
    id = info.id
    assert.equal(info.cwd, path.resolve(home))
    assert.equal(info.cols, 90)
    assert.equal(info.rows, 24)
    assert.match(info.shell, /PowerShell|cmd|bash|WSL/i)

    await firstData.promise
    unsubscribe()
    assert.equal(manager.scrollback(info.id)?.length, output.length)

    manager.resize(info.id, 100, 30)
    assert.equal(manager.get(info.id)?.cols, 100)
    assert.equal(manager.get(info.id)?.rows, 30)

    manager.close(info.id)
    assert.equal(manager.get(info.id), undefined)
  } finally {
    manager.closeAll()
    try {
      fs.rmSync(home, { recursive: true, force: true })
    } catch {
      // ConPTY may hold the shell's cwd handle for a moment after kill; the
      // temp directory is outside the repo and the OS reclaims it.
    }
  }
})

test('terminal REST and WebSocket share one PTY session', { timeout: 30_000 }, async () => {
  const home = tempDir('denia-terminal-host-')
  const host = await startHost({
    home,
    port: 0,
    webDir: path.join(home, 'web'),
    browser: null,
    terminals: new TerminalManager({ home, shell: testShell }),
  })
  let socket: WebSocket | null = null
  let replaySocket: WebSocket | null = null
  try {
    const created = await fetch(`${host.baseUrl}/api/terminals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: home, cols: 88, rows: 26 }),
    })
    assert.equal(created.status, 200)
    const body = (await created.json()) as { terminal: { id: string; shell: string; cols: number; rows: number } }
    assert.equal(body.terminal.cols, 88)
    assert.equal(body.terminal.rows, 26)

    const firstFrame = Promise.withResolvers<void>()
    const sawOutput = Promise.withResolvers<void>()
    let output = ''
    const wsUrl = `${host.baseUrl.replace('http://', 'ws://')}/api/terminals/${encodeURIComponent(body.terminal.id)}/ws?replay=1`
    socket = new WebSocket(wsUrl)
    socket.on('message', (raw) => {
      let frame: Record<string, unknown>
      try {
        frame = JSON.parse(raw.toString()) as Record<string, unknown>
      } catch {
        return
      }
      if (frame.type === 'data' || frame.type === 'replay') firstFrame.resolve()
      if (frame.type === 'data') {
        output += Buffer.from(String(frame.data), 'base64').toString('utf8')
        if (output.includes('denia-terminal-test')) sawOutput.resolve()
      }
    })
    const opened = Promise.withResolvers<void>()
    socket.once('open', () => opened.resolve())
    socket.once('error', (error) => opened.reject(error))
    await opened.promise

    await firstFrame.promise
    const command = process.platform === 'win32' ? 'echo denia-terminal-test\r' : 'echo denia-terminal-test\n'
    socket.send(JSON.stringify({ type: 'input', data: encodeBase64(Buffer.from(command, 'utf8')) }))

    await sawOutput.promise
    assert.match(output, /denia-terminal-test/)

    const replay = Promise.withResolvers<string>()
    replaySocket = new WebSocket(wsUrl)
    replaySocket.on('message', (raw) => {
      let frame: Record<string, unknown>
      try {
        frame = JSON.parse(raw.toString()) as Record<string, unknown>
      } catch {
        return
      }
      if (frame.type === 'replay') {
        replay.resolve(Buffer.from(String(frame.data), 'base64').toString('utf8'))
      }
    })
    const replayOpened = Promise.withResolvers<void>()
    replaySocket.once('open', () => replayOpened.resolve())
    replaySocket.once('error', (error) => replayOpened.reject(error))
    await replayOpened.promise
    assert.match(await replay.promise, /denia-terminal-test/)

    const resized = await fetch(`${host.baseUrl}/api/terminals/${encodeURIComponent(body.terminal.id)}/resize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cols: 100, rows: 30 }),
    })
    assert.equal(resized.status, 200)

    const list = await (await fetch(`${host.baseUrl}/api/terminals`)).json() as {
      terminals: Array<{ id: string; cols: number; rows: number }>
    }
    const listed = list.terminals.find((terminal) => terminal.id === body.terminal.id)
    assert.equal(listed?.cols, 100)
    assert.equal(listed?.rows, 30)
  } finally {
    socket?.close()
    replaySocket?.close()
    await host.close()
    try {
      fs.rmSync(home, { recursive: true, force: true })
    } catch {
      // ConPTY may hold the shell's cwd handle for a moment after kill; the
      // temp directory is outside the repo and the OS reclaims it.
    }
  }
})
