// Skills, project memory and workspace instructions: discovery, tools,
// injections, management endpoints and the memory-write permission class.

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { startHost } from '../src/host/server.ts'
import type { Host } from '../src/host/server.ts'
import type { Envelope } from '../src/core/wire.ts'
import {
  deleteSkill,
  discoverSkills,
  importSkills,
  listManagedSkills,
  loadSkill,
  readSkillResource,
  renderSkillCatalog,
  saveSkill,
  setSkillEnabled,
} from '../src/skills/skills.ts'
import {
  memoryHealth,
  memoryRoot,
  readIndexForInjection,
  rebuildIndex,
  searchMemories,
} from '../src/context/memory.ts'
import { discoverWorkspaceInstructions, renderWorkspaceInstructions } from '../src/context/workspace-instructions.ts'
import { startMockGateway, lastToolContents, lastUserText, writeConfig } from './helpers/mock-gateway.ts'

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

async function waitFor<T>(fn: () => Promise<T | null> | T | null, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value !== null && value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('condition not met in time')
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

async function snapshot(host: Host, id: string): Promise<{ events: Envelope[] }> {
  return (await (await fetch(`${host.baseUrl}/api/sessions/${id}`)).json()) as { events: Envelope[] }
}

async function prompt(host: Host, id: string, text: string): Promise<void> {
  const response = await fetch(`${host.baseUrl}/api/sessions/${id}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: text, provider: 'mock', model: 'mock-1' }),
  })
  assert.equal(response.status, 202)
}

function skillText(name: string, description: string, body: string, extra = ''): string {
  return `---\nname: ${name}\ndescription: ${description}\n${extra}---\n${body}\n`
}

test('skills: layering, enable/disable, resources and management', () => {
  const home = tempDir('denia-skill-home-')
  const project = tempDir('denia-skill-project-')
  fs.mkdirSync(path.join(project, '.git'), { recursive: true })
  fs.mkdirSync(path.join(home, 'skills', 'review'), { recursive: true })
  fs.writeFileSync(
    path.join(home, 'skills', 'review', 'SKILL.md'),
    skillText('review', '用户版审查', '# 审查\n用户正文'),
  )
  fs.writeFileSync(path.join(home, 'skills', 'review', 'reference.md'), '参考内容')
  fs.mkdirSync(path.join(home, 'skills', 'resource-test'), { recursive: true })
  fs.writeFileSync(
    path.join(home, 'skills', 'resource-test', 'SKILL.md'),
    skillText('resource-test', '资源测试', '# 资源'),
  )
  fs.writeFileSync(path.join(home, 'skills', 'resource-test', 'reference.md'), '技能参考')
  fs.writeFileSync(path.join(home, 'skills', 'outside.md'), '外部文件')
  fs.mkdirSync(path.join(project, '.denia', 'skills', 'review'), { recursive: true })
  fs.writeFileSync(
    path.join(project, '.denia', 'skills', 'review', 'SKILL.md'),
    skillText('review', '项目版审查', '# 审查\n项目正文', 'disable-model-invocation: true\n'),
  )

  const discovered = discoverSkills(home, project)
  const review = discovered.skills.find((skill) => skill.name === 'review')
  assert.equal(review?.source, 'project-denia')
  assert.equal(review?.modelInvocable, false)
  assert.ok(discovered.skills.some((skill) => skill.source === 'bundled' && skill.name === 'denia-guide'))
  assert.ok(discovered.skills.some((skill) => skill.name === 'skill-creator'))
  assert.throws(() => loadSkill(discovered.skills, 'review', false), /不允许此调用方式/)
  assert.match(loadSkill(discovered.skills, 'review', true).body, /项目正文/)
  assert.equal(readSkillResource(discovered.skills, 'skill-creator', 'SKILL.md').text.length > 0, true)
  assert.equal(readSkillResource(discovered.skills, 'resource-test', 'reference.md').text, '技能参考')
  assert.throws(
    () => readSkillResource(discovered.skills, 'resource-test', '../outside.md'),
    /超出技能目录/,
  )

  const catalog = renderSkillCatalog(discovered.skills, 50)
  assert.ok(catalog?.includes('<available_skills>'))
  assert.ok(catalog?.includes('denia-guide'))
  assert.ok(!catalog?.includes('review'), 'disable-model-invocation 的技能不得进目录')

  const managed = listManagedSkills(home, project)
  assert.equal(managed.find((skill) => skill.name === 'review')?.enabled, true)
  setSkillEnabled(home, project, 'review', false)
  assert.ok(!discoverSkills(home, project).skills.some((skill) => skill.name === 'review'))
  assert.equal(listManagedSkills(home, project).find((skill) => skill.name === 'review')?.enabled, false)
  setSkillEnabled(home, project, 'review', true)

  const created = saveSkill(home, project, 'created-skill', skillText('created-skill', '新建', '正文'), {
    create: true,
    scope: 'project',
  })
  assert.equal(created.source, 'project-denia')
  assert.ok(fs.existsSync(path.join(project, '.denia', 'skills', 'created-skill', 'SKILL.md')))

  const importRoot = tempDir('denia-skill-import-')
  fs.mkdirSync(path.join(importRoot, 'imported'), { recursive: true })
  fs.writeFileSync(
    path.join(importRoot, 'imported', 'SKILL.md'),
    skillText('imported', '导入技能', '导入正文'),
  )
  const imported = importSkills(home, project, importRoot, 'user')
  assert.ok(imported.some((skill) => skill.name === 'imported'))
  assert.ok(fs.existsSync(path.join(home, 'skills', 'imported', 'SKILL.md')))

  deleteSkill(home, project, 'created-skill')
  assert.ok(!fs.existsSync(path.join(project, '.denia', 'skills', 'created-skill', 'SKILL.md')))
})

test('project memory: deterministic root, index projection, search and rebuild', () => {
  const home = tempDir('denia-memory-home-')
  const project = tempDir('denia-memory-project-')
  const other = tempDir('denia-memory-other-')
  const root = memoryRoot(home, project)
  assert.equal(memoryRoot(home, project), root)
  assert.notEqual(memoryRoot(home, other), root)
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(
    path.join(root, 'MEMORY.md'),
    [
      '# 项目记忆',
      '## 经验（how）',
      '- [经验条目](experience.md) — 怎么做',
      '## 事实（what）',
      '- [事实条目](fact.md) — 现在怎样',
      '## 历史（superseded，不注入）',
      '- [旧事实](old.md) — 过期',
    ].join('\n'),
  )
  fs.writeFileSync(
    path.join(root, 'experience.md'),
    '---\nname: 经验条目\ndescription: 怎么做\nmetadata:\n  kind: experience\n  status: active\n---\nWhy: x\nHow to apply: y\n',
  )
  fs.writeFileSync(
    path.join(root, 'fact.md'),
    '---\nname: 事实条目\ndescription: 现在怎样\nmetadata:\n  kind: fact\n  status: active\n---\n当前状态\n',
  )
  fs.writeFileSync(
    path.join(root, 'old.md'),
    '---\nname: 旧事实\ndescription: 过期\nmetadata:\n  kind: fact\n  status: superseded\n---\n旧状态\n',
  )
  const injected = readIndexForInjection(root, 1024)
  assert.ok(injected?.includes('experience.md'))
  assert.ok(injected?.includes('fact.md'))
  assert.ok(!injected?.includes('历史（superseded'), 'history section must not be injected')
  assert.ok(!injected?.includes('old.md'))

  const search = searchMemories(root, '当前', 10)
  assert.ok(search.hits.some((hit) => hit.name === 'fact.md'))
  const superseded = searchMemories(root, '旧', 10, 'fact', true)
  assert.ok(superseded.hits.some((hit) => hit.name === 'old.md'))
  assert.ok(!searchMemories(root, '旧', 10).hits.some((hit) => hit.name === 'old.md'))

  const rebuilt = rebuildIndex(root)
  assert.equal(rebuilt.experience, 1)
  assert.equal(rebuilt.fact, 1)
  assert.equal(rebuilt.history, 1)
  const health = memoryHealth(root)
  assert.equal(health.fileCount, 3)
  assert.ok(health.indexLines > 0)
})

test('workspace instructions: scope, rendering and idempotence', () => {
  const home = tempDir('denia-rules-home-')
  const project = tempDir('denia-rules-project-')
  const sub = path.join(project, 'packages', 'app')
  fs.mkdirSync(path.join(project, '.git'), { recursive: true })
  fs.mkdirSync(sub, { recursive: true })
  fs.writeFileSync(path.join(home, 'AGENTS.md'), 'global rule')
  fs.writeFileSync(path.join(project, 'AGENTS.md'), 'project rule')
  fs.writeFileSync(path.join(sub, 'AGENTS.md'), 'sub rule')

  const all = discoverWorkspaceInstructions(home, sub, [], 1_048_576, 'global-and-project')
  assert.deepEqual(all.map((file) => file.displayPath), ['~/AGENTS.md', 'AGENTS.md', 'packages/app/AGENTS.md'])
  const child = discoverWorkspaceInstructions(home, sub, [], 1_048_576, 'project-only')
  assert.deepEqual(child.map((file) => file.displayPath), ['AGENTS.md', 'packages/app/AGENTS.md'])

  const rendered = renderWorkspaceInstructions(all, 1_048_576, null)
  assert.ok(rendered?.includes('global rule'))
  assert.ok(rendered?.includes('project rule'))
  assert.equal(renderWorkspaceInstructions(all, 1_048_576, rendered), null, 'unchanged body is idempotent')
  fs.writeFileSync(path.join(project, 'AGENTS.md'), 'project rule v2')
  const changed = renderWorkspaceInstructions(
    discoverWorkspaceInstructions(home, sub, [], 1_048_576, 'global-and-project'),
    1_048_576,
    rendered,
  )
  assert.ok(changed?.includes('取代之前所有工作区指令基线'))
  assert.ok(changed?.includes('project rule v2'))
})

test('host integrations: skill tool, catalog injection, memory write and APIs', async () => {
  const home = tempDir('denia-context-home-')
  const project = tempDir('denia-context-project-')
  fs.mkdirSync(path.join(project, '.git'), { recursive: true })
  fs.writeFileSync(path.join(home, 'AGENTS.md'), 'global rules for tests')
  fs.writeFileSync(path.join(project, 'AGENTS.md'), 'project rules for tests')
  const mock = await startMockGateway((request) => {
    const user = lastUserText(request)
    const tools = lastToolContents(request)
    if (user.includes('use skill')) {
      if (tools.some((content) => content.includes('denia 配置指南'))) return { text: 'skill loaded' }
      return { calls: [{ name: 'skill', arguments: { action: 'load', name: 'denia-guide' } }] }
    }
    if (user.includes('remember')) {
      if (tools.some((content) => content.includes('已写入'))) return { text: 'remembered' }
      return {
        calls: [
          {
            name: 'write_file',
            arguments: {
              path: path.join(memoryRoot(home, project), 'auto.md'),
              content: '---\nname: auto\ndescription: 自动写入\nmetadata:\n  kind: fact\n  status: active\n---\n内容\n',
            },
          },
        ],
      }
    }
    return { text: 'ok' }
  })
  writeConfig(home, mock.baseURL)
  const webDir = tempDir('denia-context-web-')
  const host = await startHost({ home, webDir, port: 0 })
  try {
    const sessionId = await createSession(host, project)

    const globalRules = (await (
      await fetch(`${host.baseUrl}/api/global-rules`)
    ).json()) as { text: string; source: string }
    assert.equal(globalRules.text, 'global rules for tests')
    assert.equal(globalRules.source, 'file')
    const saved = await fetch(`${host.baseUrl}/api/global-rules`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'updated global' }),
    })
    assert.equal(saved.status, 200)
    assert.equal(fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8'), 'updated global')

    const skills = (await (
      await fetch(`${host.baseUrl}/api/sessions/${sessionId}/skills`)
    ).json()) as { skills: { name: string; source: string }[] }
    assert.ok(skills.skills.some((skill) => skill.name === 'denia-guide'))
    assert.ok(skills.skills.some((skill) => skill.name === 'skill-creator'))

    const managed = (await (
      await fetch(`${host.baseUrl}/api/skills?cwd=${encodeURIComponent(project)}`)
    ).json()) as { skills: { name: string }[]; directory: string }
    assert.ok(managed.directory.endsWith('skills'))
    const created = await fetch(`${host.baseUrl}/api/skills/test-skill`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cwd: project,
        create: true,
        scope: 'project',
        content: skillText('test-skill', '测试技能', '正文'),
      }),
    })
    assert.equal(created.status, 200)
    const toggled = await fetch(`${host.baseUrl}/api/skills/test-skill/enabled`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: project, enabled: false }),
    })
    assert.equal(toggled.status, 200)
    assert.equal(
      ((await toggled.json()) as { skill: { enabled: boolean } }).skill.enabled,
      false,
    )
    assert.equal(
      (await fetch(`${host.baseUrl}/api/skills/test-skill?cwd=${encodeURIComponent(project)}`, {
        method: 'DELETE',
      })).status,
      200,
    )

    await prompt(host, sessionId, 'use skill')
    const afterSkill = await waitFor(async () => {
      const current = await snapshot(host, sessionId)
      return current.events.some((event) => event.type === 'turn-end') ? current.events : null
    })
    const skillResult = afterSkill.find(
      (event): event is Extract<Envelope, { type: 'tool-result' }> =>
        event.type === 'tool-result' && event.content.includes('denia 配置指南'),
    )
    assert.ok(skillResult, 'skill load must return the SKILL.md body')
    assert.ok(
      afterSkill.some(
        (event) => event.type === 'user-message' &&
          event.channel === 'skill-catalog' &&
          event.text.includes('<available_skills>'),
      ),
    )
    assert.ok(
      afterSkill.some(
        (event) => event.type === 'user-message' &&
          event.channel === 'workspace-instructions' &&
          event.text.includes('project rules for tests'),
      ),
    )
    assert.ok(
      afterSkill.some(
        (event) => event.type === 'user-message' &&
          event.channel === 'capability' &&
          event.text.includes('当前代理：') &&
          event.text.includes('父代理：无'),
      ),
      'the transcript needs a capability-context injection',
    )
    assert.ok(
      afterSkill.some(
        (event) => event.type === 'user-message' &&
          event.channel === 'subagent-catalog' &&
          event.text.startsWith('[denia 子代理目录]'),
      ),
      'the delegation catalog must be a visible injection, not a prompt section',
    )
    assert.ok(
      afterSkill.some(
        (event) => event.type === 'user-message' &&
          event.channel === 'runtime-context' &&
          event.text.startsWith('Current runtime context.') &&
          event.text.includes(project),
      ),
      'the runtime snapshot must be visible in the transcript',
    )

    const systemPrompts = afterSkill.filter(
      (event): event is Extract<Envelope, { type: 'system-prompt' }> =>
        event.type === 'system-prompt',
    )
    assert.equal(systemPrompts.length, 1, 'the unchanged prompt is logged once')
    assert.ok(
      systemPrompts[0]?.text.includes('## 核心原则') &&
        systemPrompts[0]?.text.includes('## 项目记忆'),
      'the transcript must carry the full prompt, not a persona-only projection',
    )

    await prompt(host, sessionId, 'remember')
    await waitFor(async () => {
      const current = await snapshot(host, sessionId)
      return !host.driver.isRunning(sessionId) &&
        current.events.some(
          (event) => event.type === 'tool-result' && event.content.includes('已写入'),
        )
        ? true
        : null
    })
    assert.ok(fs.existsSync(path.join(memoryRoot(home, project), 'auto.md')))

    const workspace = await fetch(`${host.baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: project, title: 'Context' }),
    })
    const workspaceBody = (await workspace.json()) as { workspace: { id: string } }
    const projects = (await (
      await fetch(`${host.baseUrl}/api/memories/projects`)
    ).json()) as {
      projects: { id: string; root: string; index: unknown; files: { name: string }[] }[]
    }
    const memoryProject = projects.projects.find((entry) => entry.id === workspaceBody.workspace.id)
    assert.ok(memoryProject)
    assert.equal(memoryProject.index, null, 'no index until it is created or rebuilt')
    assert.ok(memoryProject.files.some((file) => file.name === 'auto.md'))

    const fileResponse = await fetch(
      `${host.baseUrl}/api/memories/projects/${workspaceBody.workspace.id}/auto.md`,
    )
    assert.equal(fileResponse.status, 200)
    assert.match(((await fileResponse.json()) as { content: string }).content, /自动写入/)
    const search = await fetch(
      `${host.baseUrl}/api/memories/projects/${workspaceBody.workspace.id}/search?q=自动`,
    )
    assert.equal(search.status, 200)
    assert.ok(((await search.json()) as { hits: unknown[] }).hits.length > 0)
    const rebuild = await fetch(
      `${host.baseUrl}/api/memories/projects/${workspaceBody.workspace.id}/index`,
      { method: 'POST' },
    )
    assert.equal(rebuild.status, 200)
    const rebuiltProjects = (await (
      await fetch(`${host.baseUrl}/api/memories/projects`)
    ).json()) as { projects: { id: string; index: unknown }[] }
    assert.ok(rebuiltProjects.projects.find((entry) => entry.id === workspaceBody.workspace.id)?.index)
    const deleted = await fetch(
      `${host.baseUrl}/api/memories/projects/${workspaceBody.workspace.id}/auto.md`,
      { method: 'DELETE' },
    )
    assert.equal(deleted.status, 200)
  } finally {
    await host.close()
    await mock.close()
  }
})