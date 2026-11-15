// Projects: multi-directory membership, API cascade and cross-root rewind.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { startHost } from '../src/host/server.ts'
import { FileHistoryStore } from '../src/session/file-history.ts'
import { SessionStore } from '../src/session/store.ts'
import { resolvePath } from '../src/tools/types.ts'
import { GlobTool, GrepTool, LsTool } from '../src/tools/search.ts'
import type { ToolContext } from '../src/tools/types.ts'
import type { Envelope } from '../src/core/wire.ts'
import { startMockGateway, writeConfig } from './helpers/mock-gateway.ts'

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function toolContext(cwd: string, roots: string[]): ToolContext {
  return {
    sessionId: 'project-test',
    callId: 'call-1',
    cwd,
    roots,
    confined: true,
    cancel: new AbortController().signal,
    emit: () => {},
  }
}

test('project API keeps every directory and binds sessions to it', async () => {
  const home = tempDir('denia-project-home-')
  const webDir = tempDir('denia-project-web-')
  const first = tempDir('denia-project-a-')
  const second = tempDir('denia-project-b-')
  const host = await startHost({ home, webDir, port: 0 })
  try {
    const created = await fetch(`${host.baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Multi', dirs: [first, second] }),
    })
    assert.equal(created.status, 201)
    const { project } = (await created.json()) as {
      project: { id: string; title: string; dirs: string[] }
    }
    assert.equal(project.title, 'Multi')
    assert.deepEqual(project.dirs, [path.resolve(first), path.resolve(second)])

    const sessionResponse = await fetch(`${host.baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.id }),
    })
    assert.equal(sessionResponse.status, 201)
    const { session } = (await sessionResponse.json()) as {
      session: { id: string; cwd: string; project_id: string }
    }
    assert.equal(session.project_id, project.id)
    assert.equal(session.cwd, path.resolve(first))
    const header = host.store.header(session.id)
    assert.equal(header?.project_id, project.id)
    assert.equal(header?.cwd, path.resolve(first))

    const list = (await (await fetch(`${host.baseUrl}/api/sessions`)).json()) as {
      sessions: { id: string; project_id: string }[]
    }
    const row = list.sessions.find((entry) => entry.id === session.id)
    assert.equal(row?.project_id, project.id)

    const projects = (await (await fetch(`${host.baseUrl}/api/projects`)).json()) as {
      projects: { id: string; sessionIds: string[] }[]
      managedRoot: string
    }
    assert.ok(projects.projects.find((entry) => entry.id === project.id)?.sessionIds.includes(session.id))
    assert.ok(projects.managedRoot.endsWith(path.join('projects')))

    const removed = await fetch(`${host.baseUrl}/api/projects/${project.id}`, { method: 'DELETE' })
    assert.equal(removed.status, 200)
    assert.equal(host.store.header(session.id), null)
    assert.ok(fs.existsSync(first), 'deleting a project keeps its directories')

    const fallback = await fetch(`${host.baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    const fallbackBody = (await fallback.json()) as {
      session: { cwd: string; project_id: string }
    }
    assert.equal(fallbackBody.session.project_id, 'default')
    assert.ok(fs.statSync(fallbackBody.session.cwd).isDirectory())

    const defaultDelete = await fetch(`${host.baseUrl}/api/projects/default`, { method: 'DELETE' })
    assert.equal(defaultDelete.status, 400, 'the built-in default project cannot be deleted')
  } finally {
    await host.close()
  }
})

test('rewind restores files across every project directory', () => {
  const home = tempDir('denia-project-history-')
  const first = tempDir('denia-project-root-a-')
  const second = tempDir('denia-project-root-b-')
  const history = new FileHistoryStore(home)
  const sessionId = 'multi-root-session'
  const a = path.join(first, 'a.txt')
  const b = path.join(second, 'b.txt')
  const created = path.join(second, 'new.txt')
  fs.writeFileSync(a, 'a-original')
  fs.writeFileSync(b, 'b-original')

  history.snapshot(sessionId, [first, second], 1)
  const backend = history.backend(sessionId, [first, second])
  backend.trackBeforeWrite(a)
  fs.writeFileSync(a, 'a-changed')
  backend.trackBeforeWrite(b)
  fs.writeFileSync(b, 'b-changed')
  backend.trackBeforeWrite(created)
  fs.writeFileSync(created, 'created')
  history.snapshot(sessionId, [first, second], 2)

  const changes = history.diff(sessionId, [first, second], 1)
  assert.deepEqual(
    changes.map((entry) => ({ path: entry.path, root: entry.root, action: entry.action })).sort((left, right) =>
      left.path.localeCompare(right.path)),
    [
      { path: 'a.txt', root: path.resolve(first), action: 'restore' },
      { path: 'b.txt', root: path.resolve(second), action: 'restore' },
      { path: 'new.txt', root: path.resolve(second), action: 'delete' },
    ].sort((left, right) => left.path.localeCompare(right.path)),
  )

  const changed = history.rewind(sessionId, [first, second], 1)
  assert.deepEqual(changed.sort(), ['a.txt', 'b.txt', 'new.txt'])
  assert.equal(fs.readFileSync(a, 'utf8'), 'a-original')
  assert.equal(fs.readFileSync(b, 'utf8'), 'b-original')
  assert.equal(fs.existsSync(created), false)
})

test('sandbox and default searches cover the whole project', async () => {
  const first = tempDir('denia-project-scope-a-')
  const second = tempDir('denia-project-scope-b-')
  fs.writeFileSync(path.join(first, 'alpha.ts'), 'export const alpha = "needle"')
  fs.writeFileSync(path.join(second, 'beta.ts'), 'export const beta = "needle"')
  const roots = [path.resolve(first), path.resolve(second)]

  assert.equal(
    resolvePath(first, path.join(second, 'beta.ts'), true, roots),
    path.join(second, 'beta.ts'),
  )
  assert.throws(
    () => resolvePath(first, path.join(os.tmpdir(), 'outside.txt'), true, roots),
    /项目目录内/,
  )

  const ctx = toolContext(first, roots)
  const ls = await LsTool.execute({}, ctx)
  assert.match(ls.content, /alpha\.ts/)
  assert.match(ls.content, /beta\.ts/)
  const glob = await GlobTool.execute({ pattern: '*.ts' }, ctx)
  assert.match(glob.content, /alpha\.ts/)
  assert.match(glob.content, /beta\.ts/)
  const grep = await GrepTool.execute({ pattern: 'needle' }, ctx)
  assert.match(grep.content, /alpha\.ts:1:/)
  assert.match(grep.content, /beta\.ts:1:/)
})

test('the model runtime context lists every project directory', async () => {
  const home = tempDir('denia-project-prompt-home-')
  const webDir = tempDir('denia-project-prompt-web-')
  const first = tempDir('denia-project-prompt-a-')
  const second = tempDir('denia-project-prompt-b-')
  const mock = await startMockGateway(() => ({ text: 'noted' }))
  writeConfig(home, mock.baseURL)
  const host = await startHost({ home, webDir, port: 0 })
  try {
    const created = await fetch(`${host.baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Prompt', dirs: [first, second] }),
    })
    const { project } = (await created.json()) as { project: { id: string } }
    const sessionResponse = await fetch(`${host.baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.id }),
    })
    const { session } = (await sessionResponse.json()) as { session: { id: string } }
    const prompted = await fetch(`${host.baseUrl}/api/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'which directories?' }),
    })
    assert.equal(prompted.status, 202)
    const deadline = Date.now() + 20_000
    let events: Envelope[] = []
    while (Date.now() < deadline) {
      events = host.store.read(session.id)?.events ?? []
      if (events.some((event) => event.type === 'turn-end')) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const runtime = events.find(
      (event): event is Extract<Envelope, { type: 'user-message' }> =>
        event.type === 'user-message' && event.channel === 'runtime-context',
    )
    assert.ok(runtime, 'runtime context is injected')
    assert.match(runtime.text, new RegExp(path.resolve(first).replace(/\\/g, '\\\\')))
    assert.match(runtime.text, new RegExp(path.resolve(second).replace(/\\/g, '\\\\')))
    assert.match(runtime.text, /项目目录（2 个/)
  } finally {
    await host.close()
    await mock.close()
  }
})

test('legacy workspaces and ungrouped sessions migrate into projects', async () => {
  const home = tempDir('denia-project-migrate-home-')
  const webDir = tempDir('denia-project-migrate-web-')
  const legacyDir = tempDir('denia-project-migrate-legacy-')
  const looseDir = tempDir('denia-project-migrate-loose-')
  const store = new SessionStore(home)
  const legacySession = store.create(legacyDir, { sandbox: true })
  const looseSession = store.create(looseDir, { sandbox: true })
  const legacyId = '11111111-2222-3333-4444-555555555555'
  fs.writeFileSync(
    path.join(home, 'workspaces.json'),
    JSON.stringify({
      initialized: true,
      order: [legacyId],
      workspaces: {
        [legacyId]: {
          id: legacyId,
          path: legacyDir,
          title: 'Legacy',
          createdAt: 1,
          sessionIds: [legacySession.id],
        },
      },
    }),
  )
  const host = await startHost({ home, webDir, port: 0 })
  try {
    const projects = (await (await fetch(`${host.baseUrl}/api/projects`)).json()) as {
      projects: { id: string; title: string; dirs: string[]; sessionIds: string[] }[]
    }
    const legacy = projects.projects.find((entry) => entry.id === legacyId)
    assert.ok(legacy, 'the legacy workspace becomes a project')
    assert.deepEqual(legacy.dirs, [path.resolve(legacyDir)])
    assert.ok(legacy.sessionIds.includes(legacySession.id))
    assert.ok(projects.projects.some((entry) => entry.id === 'default'))

    assert.equal(host.store.header(legacySession.id)?.project_id, legacyId)
    assert.equal(host.store.header(looseSession.id)?.project_id, 'default')
    const defaultProject = projects.projects.find((entry) => entry.id === 'default')
    assert.ok(defaultProject?.sessionIds.includes(looseSession.id), 'ungrouped sessions join the default project')
    assert.ok(fs.existsSync(path.join(home, 'projects.json')))
  } finally {
    await host.close()
  }
})

test('projects without directories live under the installation root', async () => {
  const home = tempDir('denia-install-home-')
  const webDir = tempDir('denia-install-web-')
  const install = tempDir('denia-install-root-')
  const host = await startHost({ home, webDir, port: 0, projectsRoot: install })
  try {
    const projects = (await (await fetch(`${host.baseUrl}/api/projects`)).json()) as {
      projects: { id: string; dirs: string[] }[]
      managedRoot: string
    }
    assert.equal(path.resolve(projects.managedRoot), path.resolve(install))
    assert.ok(
      projects.projects
        .find((project) => project.id === 'default')
        ?.dirs.every((dir) => dir.startsWith(path.resolve(install))),
      'the default project directory lives under the installation root',
    )

    const created = await fetch(`${host.baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Managed under install' }),
    })
    const { project } = (await created.json()) as { project: { dirs: string[] } }
    assert.equal(project.dirs.length, 1)
    assert.ok(project.dirs[0]!.startsWith(path.resolve(install)))
    assert.ok(fs.statSync(project.dirs[0]!).isDirectory())
  } finally {
    await host.close()
  }
})
