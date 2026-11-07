// Subagent subsystem tests: definition store, dispatch resolution, API and the
// background runtime (spawn, completion delivery, list/wait, messages, fork).

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { startHost } from '../src/host/server.ts'
import type { Host } from '../src/host/server.ts'
import type { Envelope } from '../src/core/wire.ts'
import { ProfileError, ProfileStore } from '../src/subagents/profiles.ts'
import { resolveDispatch, toolCatalogRows, parentGrant } from '../src/subagents/resolver.ts'
import type { SubagentProfile } from '../src/subagents/types.ts'
import { startMockGateway, lastToolContents, lastUserText, writeConfig } from './helpers/mock-gateway.ts'

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

async function waitFor<T>(
  fn: () => Promise<T | null> | T | null,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value !== null && value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('condition not met in time')
}

async function snapshot(host: Host, id: string): Promise<{
  header: { id: string; parent_session?: string; subagent?: Record<string, unknown> }
  events: Envelope[]
}> {
  const response = await fetch(`${host.baseUrl}/api/sessions/${id}`)
  return (await response.json()) as {
    header: { id: string; parent_session?: string; subagent?: Record<string, unknown> }
    events: Envelope[]
  }
}

async function summaries(host: Host): Promise<{ sessions: Record<string, unknown>[] }> {
  const response = await fetch(`${host.baseUrl}/api/sessions`)
  return (await response.json()) as { sessions: Record<string, unknown>[] }
}

async function prompt(host: Host, id: string, text: string): Promise<void> {
  const response = await fetch(`${host.baseUrl}/api/sessions/${id}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: text, provider: 'mock', model: 'mock-1' }),
  })
  assert.equal(response.status, 202)
}

async function createSession(host: Host, cwd: string): Promise<string> {
  const response = await fetch(`${host.baseUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd }),
  })
  const body = (await response.json()) as { session: { id: string } }
  return body.session.id
}

test('profile store: builtins, user/project overlays, revisions and builtin editing', () => {
  const home = tempDir('denia-subagent-home-')
  const project = tempDir('denia-subagent-project-')
  fs.mkdirSync(path.join(project, '.git'), { recursive: true })
  const store = new ProfileStore(home)

  const base = store.catalog(null)
  assert.deepEqual(
    base.effective.map((view) => view.qualifiedId),
    ['builtin:develop', 'builtin:explore', 'builtin:verify'],
  )
  const explore = store.resolve(null, 'builtin:explore')
  assert.equal(explore.profile.permissionCeiling, 'read-only')
  assert.ok(explore.profile.tools.mode === 'allowlist')
  assert.ok(explore.profile.tools.names.includes('read_file'))

  const profile: SubagentProfile = {
    schemaVersion: 1,
    id: 'reviewer',
    name: '审查',
    description: '审查实现',
    instructions: '只报告证据。',
    enabled: true,
    tools: { mode: 'allowlist', names: ['read_file', 'send_message'] },
    model: { mode: 'inherit' },
    permissionCeiling: 'read-only',
    color: 'orange',
  }
  const created = store.create('user', null, profile, profile.instructions)
  assert.equal(created.qualifiedId, 'user:reviewer')
  assert.equal(store.resolve(null, 'user:reviewer').profile.name, '审查')

  // Project layer shadows the same logical id.
  const projectProfile = { ...profile, name: '项目审查' }
  const projectView = store.create('project', project, projectProfile, profile.instructions)
  assert.equal(projectView.qualifiedId, 'project:reviewer')
  const layered = store.catalog(project)
  assert.equal(
    layered.effective.find((view) => view.profile.id === 'reviewer')?.source,
    'project',
  )
  assert.ok(layered.shadowed.some((view) => view.qualifiedId === 'user:reviewer'))
  assert.throws(
    () => store.resolve(project, 'user:reviewer'),
    (error: unknown) => error instanceof ProfileError && error.code === 'subagent/profile-shadowed',
  )

  // Revision conflicts are explicit.
  assert.throws(
    () => store.update(null, 'user:reviewer', profile, '改正文', created.revision + 1),
    (error: unknown) => error instanceof ProfileError && error.code === 'subagent/revision-conflict',
  )
  const updated = store.update(null, 'user:reviewer', profile, '改正文', created.revision)
  assert.notEqual(updated.revision, created.revision)

  // Editing a shipped definition writes a user override on first save.
  const override = store.update(null, 'builtin:explore', {
    ...explore.profile,
    name: '我的探索',
  }, explore.profile.instructions, explore.revision)
  assert.equal(override.qualifiedId, 'user:explore')
  assert.equal(override.overridesBuiltin, true)
  assert.throws(
    () => store.resolve(null, 'builtin:explore'),
    (error: unknown) => error instanceof ProfileError && error.code === 'subagent/profile-shadowed',
  )

  // Deleting the override restores the builtin.
  const restored = store.delete(null, 'user:explore', 'user')
  assert.equal(restored?.qualifiedId, 'builtin:explore')
  assert.equal(store.resolve(null, 'builtin:explore').qualifiedId, 'builtin:explore')

  // Broken files are diagnostics, not silent drops.
  fs.writeFileSync(path.join(home, 'subagents', 'broken.md'), '---\nid: broken\n---\nbody\n')
  const broken = store.catalog(null)
  assert.ok(broken.diagnostics.length > 0)
  assert.ok(broken.diagnostics.some((issue) => issue.message.includes('broken.md')))
})

test('dispatch resolution: tools, ceiling, hard denials and fork model rules', () => {
  const registered = [
    'read_file',
    'grep',
    'ls',
    'write_file',
    'edit',
    'bash',
    'todo_write',
    'send_message',
    'spawn_agent',
    'exit_plan',
  ]
  const selection = { provider: 'mock', model: 'mock-1' }
  const parent = { registered, mode: 'auto-edit' as const, selection }
  const store = new ProfileStore(tempDir('denia-subagent-resolver-'))
  const explore = store.resolve(null, 'builtin:explore')
  const dispatch = resolveDispatch({
    args: { prompt: '调查', profile_id: 'builtin:explore' },
    fork: false,
    parent,
    defaulted: false,
    profile: explore,
  })
  assert.ok(dispatch.tools.includes('read_file'))
  assert.ok(dispatch.tools.includes('send_message'))
  assert.ok(!dispatch.tools.includes('bash'))
  assert.ok(!dispatch.tools.includes('spawn_agent'))
  assert.equal(dispatch.permissionCeiling, 'read-only')

  const develop = store.resolve(null, 'builtin:develop')
  const developDispatch = resolveDispatch({
    args: { prompt: '实现', profile_id: 'builtin:develop' },
    fork: false,
    parent,
    defaulted: false,
    profile: develop,
  })
  assert.ok(developDispatch.tools.includes('write_file'))
  assert.ok(!developDispatch.tools.includes('exit_plan'), 'child hard denials always win')

  const inline = resolveDispatch({
    args: {
      prompt: '纯推理',
      inline: {
        name: 'reasoner',
        description: '只思考',
        instructions: '不要用工具',
        tools: { mode: 'allowlist', names: [] },
        model: { mode: 'inherit' },
        permissionCeiling: 'inherit',
      },
    },
    fork: false,
    parent,
    defaulted: false,
  })
  assert.equal(inline.inline, true)
  assert.deepEqual(inline.tools, [])

  assert.throws(
    () =>
      resolveDispatch({
        args: {
          prompt: '越权',
          inline: {
            name: 'bad',
            description: 'bad',
            instructions: '',
            tools: { mode: 'allowlist', names: ['spawn_agent'] },
            model: { mode: 'inherit' },
            permissionCeiling: 'inherit',
          },
        },
        fork: false,
        parent,
        defaulted: false,
      }),
    (error: unknown) => error instanceof ProfileError && error.code === 'subagent/tool-hard-denied',
  )
  assert.throws(
    () =>
      resolveDispatch({
        args: { prompt: 'fork', profile_id: 'builtin:develop', model: 'other-model' },
        fork: true,
        parent,
        defaulted: false,
        profile: develop,
      }),
    (error: unknown) => error instanceof ProfileError && error.code === 'subagent/profile-invalid',
  )

  const rows = toolCatalogRows(registered, parentGrant(registered, undefined, 'auto-edit'))
  const spawn = rows.find((row) => row.name === 'spawn_agent')
  assert.equal(spawn?.hardDenied, true)
  assert.equal(spawn?.grantable, false)
  const write = rows.find((row) => row.name === 'write_file')
  assert.equal(write?.granted, true)
})

test('profile API and preview expose the catalog and final tool set', async () => {
  const home = tempDir('denia-subagent-api-home-')
  const cwd = tempDir('denia-subagent-api-cwd-')
  const webDir = tempDir('denia-subagent-api-web-')
  const mock = await startMockGateway(() => ({ text: 'ok' }))
  writeConfig(home, mock.baseURL)
  const host = await startHost({ home, webDir, port: 0 })
  try {
    const sessionId = await createSession(host, cwd)
    const list = (await (
      await fetch(`${host.baseUrl}/api/subagent-profiles?sessionId=${sessionId}`)
    ).json()) as { effective: { qualifiedId: string }[]; colors: string[] }
    assert.equal(list.effective.length, 3)
    assert.ok(list.colors.includes('blue'))

    const created = await fetch(`${host.baseUrl}/api/subagent-profiles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scope: 'user',
        sessionId,
        profile: {
          schemaVersion: 1,
          id: 'api-reviewer',
          name: '接口审查',
          description: '检查接口契约',
          instructions: '给出证据。',
          enabled: true,
          tools: { mode: 'allowlist', names: ['read_file', 'send_message'] },
          model: { mode: 'inherit' },
          permissionCeiling: 'read-only',
        },
      }),
    })
    assert.equal(created.status, 201)
    const createdBody = (await created.json()) as {
      profile: { qualifiedId: string; revision: number }
    }
    assert.equal(createdBody.profile.qualifiedId, 'user:api-reviewer')

    const updated = await fetch(
      `${host.baseUrl}/api/subagent-profiles/${encodeURIComponent('user:api-reviewer')}?sessionId=${sessionId}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          expectedRevision: createdBody.profile.revision,
          profile: {
            schemaVersion: 1,
            id: 'api-reviewer',
            name: '接口审查 v2',
            description: '检查接口契约',
            instructions: '给出证据与行号。',
            enabled: true,
            tools: { mode: 'allowlist', names: ['read_file', 'send_message'] },
            model: { mode: 'inherit' },
            permissionCeiling: 'read-only',
          },
        }),
      },
    )
    assert.equal(updated.status, 200)

    const preview = await fetch(`${host.baseUrl}/api/subagent-profiles/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, profileId: 'builtin:explore' }),
    })
    assert.equal(preview.status, 200)
    const previewBody = (await preview.json()) as {
      final: boolean
      tools: string[]
      permissionCeiling: string
      effectivePermissionMode: string
      profile: { qualifiedId: string }
    }
    assert.equal(previewBody.final, true)
    assert.equal(previewBody.profile.qualifiedId, 'builtin:explore')
    assert.ok(previewBody.tools.includes('read_file'))
    assert.ok(!previewBody.tools.includes('bash'))
    assert.equal(previewBody.permissionCeiling, 'read-only')
    assert.equal(previewBody.effectivePermissionMode, 'read-only')

    const tools = (await (
      await fetch(`${host.baseUrl}/api/subagent-tools?sessionId=${sessionId}`)
    ).json()) as { registered: number; tools: { name: string; hardDenied: boolean }[] }
    assert.ok(tools.registered > 0)
    assert.equal(tools.tools.find((tool) => tool.name === 'spawn_agent')?.hardDenied, true)

    const removed = await fetch(
      `${host.baseUrl}/api/subagent-profiles/${encodeURIComponent('user:api-reviewer')}?sessionId=${sessionId}&scope=user`,
      { method: 'DELETE' },
    )
    assert.equal(removed.status, 200)
  } finally {
    await host.close()
    await mock.close()
  }
})

test('runtime: spawn explore, deliver completion, list/wait and parent-child messages', async () => {
  const home = tempDir('denia-subagent-run-home-')
  const cwd = tempDir('denia-subagent-run-cwd-')
  const webDir = tempDir('denia-subagent-run-web-')
  const mock = await startMockGateway((request) => {
    const user = lastUserText(request)
    const tools = lastToolContents(request)
    const toolText = tools.join('\n')
    if (user.includes('发来消息')) return { text: 'child second' }
    if (user.includes('委派任务')) return { text: 'child report: found it' }
    if (user.includes('[子代理执行结束]')) return { text: 'parent noted' }
    if (user.includes('define')) {
      if (toolText.includes('"action"')) return { text: 'defined' }
      return {
        calls: [
          {
            name: 'create_subagent',
            arguments: {
              id: 'helper',
              name: '助手',
              description: '测试用永久定义',
              instructions: '只报告事实。',
              tools: { mode: 'allowlist', names: ['read_file', 'send_message'] },
              scope: 'user',
            },
          },
        ],
      }
    }
    if (user.includes('trace')) {
      if (toolText.includes('tool_call') || toolText.includes('tool_result')) return { text: 'traced' }
      return { calls: [{ name: 'session_trace', arguments: { limit: 10 } }] }
    }
    if (user.includes('inspect')) {
      if (toolText.includes('"terminal"')) return { text: 'inspected' }
      if (toolText.includes('"name":"只读探索"')) {
        const match = /"childId":"([^"]+)"/.exec(toolText)
        assert.ok(match, 'list_agents result must carry the child id')
        return { calls: [{ name: 'wait_agent', arguments: { target: match[1] } }] }
      }
      return { calls: [{ name: 'list_agents', arguments: {} }] }
    }
    if (user.includes('delegate')) {
      if (toolText.includes('"childId"')) return { text: 'parent finished' }
      return {
        calls: [
          {
            name: 'spawn_agent',
            arguments: {
              prompt: '调查代码结构',
              description: '调查',
              profile_id: 'builtin:explore',
            },
          },
        ],
      }
    }
    return { text: 'idle' }
  })
  writeConfig(home, mock.baseURL)
  const host = await startHost({ home, webDir, port: 0 })
  try {
    const parentId = await createSession(host, cwd)
    await prompt(host, parentId, 'delegate')
    const parentEvents = await waitFor(async () => {
      const current = await snapshot(host, parentId)
      const delivered = current.events.some(
        (event) => event.type === 'agent-delivery' && event.text.includes('[子代理执行结束]'),
      )
      return delivered && !host.driver.isRunning(parentId) ? current.events : null
    })

    const sessions = await summaries(host)
    const child = sessions.sessions.find((entry) => entry.parent_session === parentId)
    assert.ok(child, 'the child session must be listed with parent_session')
    const childId = child.id as string

    const childSnapshot = await snapshot(host, childId)
    assert.ok(childSnapshot.header.subagent, 'the child header must carry the descriptor')
    assert.equal(childSnapshot.header.subagent?.name, '只读探索')
    assert.ok(
      childSnapshot.events.some(
        (event) => event.type === 'agent-delivery' && event.text.includes('[父代理'),
      ),
      'the delegated task must be delivered to the child',
    )
    const childTexts = childSnapshot.events
      .filter((event): event is Extract<Envelope, { type: 'assistant-message' }> => event.type === 'assistant-message')
      .map((event) =>
        event.blocks
          .filter((block) => block.type === 'text')
          .map((block) => (block.type === 'text' ? block.text : ''))
          .join(''),
      )
    assert.ok(childTexts.includes('child report: found it'))
    assert.ok(
      childSnapshot.events.some(
        (event) => event.type === 'permission-selection' && event.sandbox === 'read-only',
      ),
      'the explore ceiling must force a read-only child',
    )

    const notice = parentEvents.find(
      (event) => event.type === 'agent-delivery' && event.text.includes('[子代理执行结束]'),
    )
    assert.ok(notice && notice.type === 'agent-delivery')
    assert.match(notice.text, /终态：completed/)
    assert.ok(parentEvents.some((event) => event.type === 'agent-inbox'))

    const agentsResponse = (await (
      await fetch(`${host.baseUrl}/api/sessions/${parentId}/agents`)
    ).json()) as {
      agents: { id: string; status: string; name: string; toolCount: number; parentId: string }[]
    }
    assert.equal(agentsResponse.agents.length, 1)
    assert.equal(agentsResponse.agents[0]?.id, childId)
    assert.equal(agentsResponse.agents[0]?.status, 'settled')
    assert.equal(agentsResponse.agents[0]?.name, '只读探索')
    assert.equal(agentsResponse.agents[0]?.parentId, parentId)
    assert.ok((agentsResponse.agents[0]?.toolCount ?? 0) > 0)

    const before = childSnapshot.events.filter((event) => event.type === 'assistant-message').length
    const sent = await fetch(`${host.baseUrl}/api/sessions/${parentId}/agents/${childId}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '继续' }),
    })
    assert.equal(sent.status, 202)
    await waitFor(async () => {
      const current = await snapshot(host, childId)
      const messages = current.events.filter((event) => event.type === 'assistant-message').length
      return messages > before ? messages : null
    })
    const afterMessage = await snapshot(host, childId)
    const texts = afterMessage.events
      .filter((event): event is Extract<Envelope, { type: 'assistant-message' }> => event.type === 'assistant-message')
      .map((event) =>
        event.blocks
          .filter((block) => block.type === 'text')
          .map((block) => (block.type === 'text' ? block.text : ''))
          .join(''),
      )
    assert.ok(texts.includes('child second'))

    await waitFor(async () => (host.driver.isRunning(parentId) ? null : true))
    await prompt(host, parentId, 'inspect')
    const inspected = await waitFor(async () => {
      const current = await snapshot(host, parentId)
      return !host.driver.isRunning(parentId) && current.events.some((event) => event.type === 'turn-end')
        ? current.events
        : null
    })
    const results = inspected.filter(
      (event): event is Extract<Envelope, { type: 'tool-result' }> => event.type === 'tool-result',
    )
    const listed = results.find((event) => event.content.includes('"name":"只读探索"'))
    assert.ok(listed, 'list_agents must expose the child')
    const waited = results.find((event) => event.content.includes('"terminal"'))
    assert.ok(waited, 'wait_agent must return the handoff snapshot')
    const handoff = JSON.parse(waited.content) as {
      id: string
      running: boolean
      terminal: { outcome: string; basis: string }
      changedPaths: string[]
    }
    assert.equal(handoff.id, childId)
    assert.equal(handoff.running, false)
    assert.equal(handoff.terminal.outcome, 'completed')
    assert.equal(handoff.terminal.basis, 'self_reported')

    await prompt(host, parentId, 'define')
    await waitFor(async () => {
      const current = await snapshot(host, parentId)
      return !host.driver.isRunning(parentId) &&
        current.events.some(
          (event) => event.type === 'tool-result' && event.content.includes('"action"'),
        )
        ? true
        : null
    })
    const defined = (await (
      await fetch(`${host.baseUrl}/api/subagent-profiles?sessionId=${parentId}`)
    ).json()) as { effective: { qualifiedId: string }[] }
    assert.ok(
      defined.effective.some((view) => view.qualifiedId === 'user:helper'),
      'create_subagent must persist a user-level definition',
    )

    await prompt(host, parentId, 'trace')
    const traced = await waitFor(async () => {
      const current = await snapshot(host, parentId)
      return !host.driver.isRunning(parentId) &&
        current.events.some(
          (event) => event.type === 'tool-result' && event.content.includes('tool_call'),
        )
        ? current.events
        : null
    })
    const traceResult = traced.find(
      (event): event is Extract<Envelope, { type: 'tool-result' }> =>
        event.type === 'tool-result' && event.content.includes('tool_call'),
    )
    assert.ok(traceResult, 'session_trace must expose structured events')
  } finally {
    await host.close()
    await mock.close()
  }
})

test('fork_agent seeds only the closed parent history and keeps the parent model', async () => {
  const home = tempDir('denia-subagent-fork-home-')
  const cwd = tempDir('denia-subagent-fork-cwd-')
  const webDir = tempDir('denia-subagent-fork-web-')
  const mock = await startMockGateway((request) => {
    const user = lastUserText(request)
    const toolText = lastToolContents(request).join('\n')
    if (user.includes('fork task')) return { text: 'fork child done' }
    if (user.includes('[子代理执行结束]')) return { text: 'noted' }
    if (user.includes('fork')) {
      if (toolText.includes('"childId"')) return { text: 'fork parent done' }
      return {
        calls: [
          {
            name: 'fork_agent',
            arguments: {
              prompt: 'fork task',
              description: '分叉',
              profile_id: 'builtin:develop',
            },
          },
        ],
      }
    }
    if (user.includes('history')) return { text: 'history said' }
    return { text: 'idle' }
  })
  writeConfig(home, mock.baseURL)
  const host = await startHost({ home, webDir, port: 0 })
  try {
    const parentId = await createSession(host, cwd)
    await prompt(host, parentId, 'history')
    await waitFor(async () => {
      const current = await snapshot(host, parentId)
      return current.events.some((event) => event.type === 'turn-end') ? true : null
    })
    await prompt(host, parentId, 'fork')
    const child = await waitFor(async () => {
      const sessions = await summaries(host)
      return sessions.sessions.find((entry) => entry.parent_session === parentId) ?? null
    })
    const childId = child.id as string
    await waitFor(async () => {
      const current = await snapshot(host, childId)
      return current.events.some(
        (event) => event.type === 'assistant-message' &&
          event.blocks.some((block) => block.type === 'text' && block.text === 'fork child done'),
      )
        ? true
        : null
    })
    const childSnapshot = await snapshot(host, childId)
    assert.equal(childSnapshot.header.subagent?.mode, 'fork')
    const userTexts = childSnapshot.events
      .filter((event): event is Extract<Envelope, { type: 'user-message' }> => event.type === 'user-message')
      .map((event) => event.text)
    assert.ok(userTexts.includes('history'), `seed missing the closed parent turn: ${userTexts.join('|')}`)
    const assistantTexts = childSnapshot.events
      .filter((event): event is Extract<Envelope, { type: 'assistant-message' }> => event.type === 'assistant-message')
      .map((event) =>
        event.blocks
          .filter((block) => block.type === 'text')
          .map((block) => (block.type === 'text' ? block.text : ''))
          .join(''),
      )
    assert.ok(assistantTexts.includes('history said'))
    // Fork must not copy the parent inbox/delivery events.
    assert.ok(
      !childSnapshot.events.some(
        (event) => event.type === 'agent-inbox' && event.source.startsWith('agent:') && event.text.includes('history'),
      ),
    )
  } finally {
    await host.close()
    await mock.close()
  }
})