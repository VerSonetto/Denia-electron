// New sessions must take the permission mode from the settings document as it
// is *now*, and the list/page projections must carry the session's last model.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { startHost } from '../src/host/server.ts'
import type { Host } from '../src/host/server.ts'
import type { Envelope } from '../src/core/wire.ts'
import { startMockGateway, writeConfig } from './helpers/mock-gateway.ts'

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function writeSettings(home: string, mode: string): void {
  fs.writeFileSync(
    path.join(home, 'settings.yaml'),
    `console:
  defaultPermissionMode: ${mode}
`,
  )
}

async function createSession(host: Host, cwd: string): Promise<string> {
  const response = await fetch(`${host.baseUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd }),
  })
  assert.equal(response.status, 201)
  return ((await response.json()) as { session: { id: string } }).session.id
}

async function events(host: Host, id: string): Promise<Envelope[]> {
  const response = await fetch(`${host.baseUrl}/api/sessions/${id}`)
  return ((await response.json()) as { events: Envelope[] }).events
}

test('a new session takes the default permission mode as it is configured now', async () => {
  const home = tempDir('denia-default-permission-home-')
  const cwd = tempDir('denia-default-permission-cwd-')
  const webDir = tempDir('denia-default-permission-web-')
  writeSettings(home, 'read-only')
  const host = await startHost({ home, webDir, port: 0 })
  try {
    const first = await createSession(host, cwd)
    const firstEvents = await events(host, first)
    const firstSelection = firstEvents.find((event) => event.type === 'permission-selection') as
      | { sandbox: string; reviewer: string }
      | undefined
    assert.ok(firstSelection, 'a new session must record its permission selection')
    assert.equal(firstSelection.sandbox, 'read-only')

    // Change the setting after the host has started: the next session must
    // follow it instead of the value snapshotted at boot.
    writeSettings(home, 'full')
    const second = await createSession(host, cwd)
    const secondSelection = (await events(host, second)).find(
      (event) => event.type === 'permission-selection',
    ) as { sandbox: string; reviewer: string } | undefined
    assert.ok(secondSelection)
    assert.equal(secondSelection.sandbox, 'danger-full-access')

    // `approve-for-me` is a preset of its own: it must survive the round trip
    // instead of collapsing into plain workspace-write.
    writeSettings(home, 'approve-for-me')
    const third = await createSession(host, cwd)
    const thirdSelection = (await events(host, third)).find(
      (event) => event.type === 'permission-selection',
    ) as { sandbox: string; reviewer: string } | undefined
    assert.ok(thirdSelection)
    assert.equal(thirdSelection.sandbox, 'workspace-write')
    assert.equal(thirdSelection.reviewer, 'auto-review')
  } finally {
    await host.close()
  }
})

test('the list and page projections carry the session last model', async () => {
  const home = tempDir('denia-last-selection-home-')
  const cwd = tempDir('denia-last-selection-cwd-')
  const webDir = tempDir('denia-last-selection-web-')
  const mock = await startMockGateway(() => ({ text: 'ok' }))
  writeConfig(home, mock.baseURL)
  const host = await startHost({ home, webDir, port: 0 })
  try {
    const id = await createSession(host, cwd)
    // Before any request there is nothing to restore.
    const emptyPage = (await (await fetch(`${host.baseUrl}/api/sessions/${id}/events`)).json()) as {
      last_selection?: unknown
    }
    assert.equal(emptyPage.last_selection, undefined)

    const response = await fetch(`${host.baseUrl}/api/sessions/${id}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello', provider: 'mock', model: 'mock-1' }),
    })
    assert.equal(response.status, 202)
    // Wait for the turn to settle, otherwise the log is still being appended.
    const deadline = Date.now() + 20_000
    for (;;) {
      const page = (await (await fetch(`${host.baseUrl}/api/sessions/${id}/events`)).json()) as {
        events: Envelope[]
      }
      if (page.events.some((event) => event.type === 'turn-end')) break
      if (Date.now() > deadline) throw new Error('turn did not settle')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    const page = (await (await fetch(`${host.baseUrl}/api/sessions/${id}/events`)).json()) as {
      last_selection?: { provider: string; model: string }
    }
    assert.deepEqual(page.last_selection, { provider: 'mock', model: 'mock-1' })

    const list = (await (await fetch(`${host.baseUrl}/api/sessions`)).json()) as {
      sessions: { id: string; last_selection?: { provider: string; model: string } }[]
    }
    const row = list.sessions.find((session) => session.id === id)
    assert.ok(row)
    assert.deepEqual(row.last_selection, { provider: 'mock', model: 'mock-1' })
  } finally {
    await host.close()
    await mock.close()
  }
})
