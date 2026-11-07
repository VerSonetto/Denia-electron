// Shared-home compatibility: the Electron host must read and write the same
// `~/.denia` documents the Rust build uses — settings.yaml, .credentials.yaml,
// workspaces.json and session logs (header version 0, UUID ids).

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { loadConfig, settingsDescribe } from '../src/config.ts'
import { startHost } from '../src/host/server.ts'

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'denia-shared-'))
}

const SETTINGS = `\
console:
  defaultPermissionMode: full
llm-openai:
  providers:
    alpha:
      apiKeyEnv: TEST_ALPHA_KEY
      baseURL: https://alpha.example/v1
      defaultContextWindow: 200000
      protocol: openai-completions
      models:
      - id: alpha-1
        name: Alpha 1
        inputModalities: [text, image]
        reasoningEfforts: [low, high]
    beta:
      apiKeyEnv: TEST_BETA_KEY
      baseURL: https://beta.example
      protocol: anthropic-messages
      models:
      - id: beta-1
        name: Beta 1
`

test('settings.yaml providers and .credentials.yaml keys are picked up', () => {
  const home = tempHome()
  fs.writeFileSync(path.join(home, 'settings.yaml'), SETTINGS)
  fs.writeFileSync(
    path.join(home, '.credentials.yaml'),
    'version: 1\nrefs:\n  TEST_ALPHA_KEY: sk-alpha\n  TEST_BETA_KEY: sk-beta\n',
  )
  const config = loadConfig(home)
  assert.deepEqual(
    config.providers.map((provider) => provider.id),
    ['alpha', 'beta'],
  )
  const alpha = config.providers[0]!
  assert.equal(alpha.baseURL, 'https://alpha.example/v1')
  assert.equal(alpha.apiKey, 'sk-alpha')
  assert.equal(alpha.models[0]?.contextWindow, undefined)
  assert.deepEqual(alpha.models[0]?.reasoningEfforts, ['low', 'high'])
  assert.equal(config.providers[1]?.protocol, 'anthropic-messages')
  assert.equal(config.providers[1]?.apiKey, 'sk-beta')
  assert.deepEqual(config.default, { provider: 'alpha', model: 'alpha-1' })

  const describe = settingsDescribe(home, config)
  assert.equal(describe.documentPath, path.join(home, 'settings.yaml'))
  assert.ok(describe.namespaces.some((entry) => entry.ns === 'llm-openai'))
  assert.ok(describe.namespaces.some((entry) => entry.ns === 'console'))
})

test('workspaces.json keeps the Rust map+order shape and presets match shipped ones', async () => {
  const home = tempHome()
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-cwd-'))
  const webDir = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-web-'))
  fs.writeFileSync(path.join(home, 'settings.yaml'), SETTINGS)
  const existingId = '11111111-2222-3333-4444-555555555555'
  fs.writeFileSync(
    path.join(home, 'workspaces.json'),
    JSON.stringify({
      initialized: true,
      order: [existingId],
      workspaces: {
        [existingId]: {
          id: existingId,
          path: cwd,
          title: 'Existing',
          createdAt: 1,
          sessionIds: [],
        },
      },
    }),
  )
  const host = await startHost({ home, webDir, port: 0 })
  try {
    const list = (await (await fetch(`${host.baseUrl}/api/workspaces`)).json()) as {
      workspaces: { id: string; title: string }[]
    }
    assert.equal(list.workspaces.length, 1)
    assert.equal(list.workspaces[0]?.id, existingId)

    const created = await fetch(`${host.baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: cwd, title: 'New' }),
    })
    assert.equal(created.status, 201)
    const { workspace } = (await created.json()) as { workspace: { id: string } }
    const file = JSON.parse(fs.readFileSync(path.join(home, 'workspaces.json'), 'utf8')) as {
      initialized: boolean
      order: string[]
      workspaces: Record<string, { id: string; title: string }>
    }
    assert.equal(file.initialized, true)
    assert.equal(file.order[0], workspace.id)
    assert.ok(file.workspaces[workspace.id])

    const presets = (await (await fetch(`${host.baseUrl}/api/agent-presets`)).json()) as {
      default: string
      presets: { id: string; name: string; tools?: string[] }[]
    }
    assert.equal(presets.default, 'standard')
    assert.deepEqual(
      presets.presets.map((preset) => preset.id),
      ['standard', 'creator', 'minimal'],
    )
    assert.deepEqual(presets.presets[2]?.tools, ['bash'])

    const credentials = (await (
      await fetch(`${host.baseUrl}/api/credentials?refs=TEST_ALPHA_KEY`)
    ).json()) as { credentials: Record<string, { configured: boolean; source?: string }> }
    assert.equal(credentials.credentials.TEST_ALPHA_KEY?.configured, false)
  } finally {
    await host.close()
  }
})

test('existing Rust session logs are readable and new sessions keep version 0 + UUID', async () => {
  const home = tempHome()
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-cwd-'))
  const webDir = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-web-'))
  fs.writeFileSync(path.join(home, 'settings.yaml'), SETTINGS)

  const oldId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const dir = path.join(home, 'sessions', oldId)
  fs.mkdirSync(dir, { recursive: true })
  const header = {
    type: 'session',
    version: 0,
    id: oldId,
    created_at: 1000,
    cwd,
    sandbox: true,
  }
  const events = [
    { seq: 1, time: 1001, type: 'turn-start', turn: 1 },
    { seq: 2, time: 1002, type: 'user-message', text: '旧会话的消息', injected: false },
    { seq: 3, time: 1003, type: 'agent-preset', preset: 'minimal' },
    { seq: 4, time: 1004, type: 'session-title', title: '旧标题' },
    {
      seq: 5,
      time: 1005,
      type: 'assistant-message',
      turn: 1,
      step: 1,
      blocks: [{ type: 'text', text: '旧回复' }],
    },
    { seq: 6, time: 1006, type: 'turn-end', turn: 1, reason: { kind: 'completed' } },
  ]
  fs.writeFileSync(
    path.join(dir, 'session.jsonl'),
    [header, ...events].map((entry) => JSON.stringify(entry)).join('\n') + '\n',
  )

  const host = await startHost({ home, webDir, port: 0 })
  try {
    const list = (await (await fetch(`${host.baseUrl}/api/sessions`)).json()) as {
      sessions: { id: string; title: string | null; excerpt: string | null; agent_preset?: string }[]
    }
    const old = list.sessions.find((session) => session.id === oldId)
    assert.ok(old, 'existing session must be listed')
    assert.equal(old.title, '旧标题')
    assert.equal(old.excerpt, '旧会话的消息')
    assert.equal(old.agent_preset, 'minimal')

    const snapshot = (await (
      await fetch(`${host.baseUrl}/api/sessions/${oldId}`)
    ).json()) as { header: { version: number }; events: unknown[] }
    assert.equal(snapshot.header.version, 0)
    assert.equal(snapshot.events.length, 6)

    const created = await fetch(`${host.baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd }),
    })
    const { session } = (await created.json()) as { session: { id: string } }
    assert.match(session.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    const newHeader = JSON.parse(
      fs.readFileSync(path.join(home, 'sessions', session.id, 'session.jsonl'), 'utf8').split('\n')[0]!,
    ) as { type: string; version: number }
    assert.equal(newHeader.type, 'session')
    assert.equal(newHeader.version, 0)
  } finally {
    await host.close()
  }
})