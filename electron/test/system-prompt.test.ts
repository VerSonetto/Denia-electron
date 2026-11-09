// System prompt assembly: the factory persona and the shipped discipline
// sections mirror the Rust host's wording, and every tool-owned section only
// appears when its tool is actually on the table.

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildRuntimeContext,
  buildSystemPrompt,
  DEFAULT_PERSONA,
} from '../src/agent/system-prompt.ts'
import { presetState } from '../src/core/permission.ts'
import type { PermissionState } from '../src/core/permission.ts'
import type { ToolSchema } from '../src/core/wire.ts'

function tool(name: string): ToolSchema {
  return { name, description: '', parameters: { type: 'object', properties: {} } }
}

const BASE_TOOL_NAMES = [
  'bash',
  'read_file',
  'write_file',
  'edit',
  'ls',
  'glob',
  'grep',
  'todo_write',
  'exit_plan',
  'skill',
  'job_start',
  'job_output',
  'job_kill',
  'spawn_agent',
  'fork_agent',
  'send_message',
  'goal_read',
]

function prompt(overrides: Partial<Parameters<typeof buildSystemPrompt>[0]> = {}): string {
  return buildSystemPrompt({
    cwd: '/work',
    sandbox: false,
    permission: presetState('workspace-write'),
    tools: BASE_TOOL_NAMES.map(tool),
    ...overrides,
  })
}

test('the persona stays outside the priority frame', () => {
  const text = prompt()
  assert.ok(text.startsWith(DEFAULT_PERSONA), 'the factory persona comes first')
  assert.ok(text.includes('【系统指令 — 最高优先级】'), 'the model-facing frame exists')
  assert.ok(
    text.indexOf(DEFAULT_PERSONA) < text.indexOf('【系统指令 — 最高优先级】'),
    'the frame wraps the rules, not the persona',
  )
  for (const heading of [
    '## 核心原则',
    '## 行动与安全',
    '## 工具准则',
    '## 进度、协作与目标',
    '## 验证与完成判断',
    '## 提问与计划',
    '## 预设创建',
    '## 沟通与交付',
  ]) {
    assert.ok(text.includes(heading), `missing section heading: ${heading}`)
  }
  assert.ok(text.includes('默认简体中文'), 'the language rule is part of the communication section')
})

test('tool-owned sections follow the tool surface', () => {
  const full = prompt()
  assert.ok(full.includes('- bash 只跑构建'), 'bash discipline appears with bash')
  assert.ok(full.includes('有目标时以达成目标为先'), 'goal discipline appears with goal_read')

  const withBrowser = prompt({ tools: [...BASE_TOOL_NAMES, 'browser'].map(tool) })
  assert.ok(withBrowser.includes('- browser 控制本机 Chrome/Edge'), 'browser discipline appears with browser')
  assert.ok(withBrowser.includes('shutdownBrowser'), 'the shutdown contract ships with the tool')

  const withoutBash = prompt({ tools: BASE_TOOL_NAMES.filter((name) => name !== 'bash').map(tool) })
  assert.ok(!withoutBash.includes('- bash 只跑构建'), 'no bash discipline without bash')
  assert.ok(withoutBash.includes('## 工具准则'), 'the group heading survives a removed tool')

  const withoutGoal = prompt({ tools: BASE_TOOL_NAMES.filter((name) => name !== 'goal_read').map(tool) })
  assert.ok(!withoutGoal.includes('有目标时以达成目标为先'), 'no goal discipline without goal_read')

  // This host has no ask / run_checks / web_fetch / browser / read_tool_output.
  for (const absent of ['ask 只在真正卡住时用', 'run_checks', 'web_fetch', 'shutdownBrowser', 'read_tool_output']) {
    assert.ok(!full.includes(absent), `section for an absent tool leaked: ${absent}`)
  }
})

test('runtime-owned sections land at their fixed slots', () => {
  const bare = prompt()
  assert.ok(!bare.includes('## 项目记忆'), 'memory only appears when the host provides it')
  assert.ok(!bare.includes('当前已接入的 MCP 服务器'), 'MCP only appears when connected')

  const text = prompt({
    extraSections: [
      { name: 'memory', text: '## 项目记忆\n- memory-body' },
      { name: 'mcp', text: '当前已接入的 MCP 服务器：demo。\n- mcp-body' },
    ],
  })
  const mcpAt = text.indexOf('当前已接入的 MCP 服务器：demo。')
  const toolsAt = text.indexOf('## 工具准则')
  const progressAt = text.indexOf('## 进度、协作与目标')
  assert.ok(toolsAt < mcpAt && mcpAt < progressAt, 'MCP sits inside the tool group')

  const memoryAt = text.indexOf('## 项目记忆')
  const presetAt = text.indexOf('## 预设创建')
  const commAt = text.indexOf('## 沟通与交付')
  assert.ok(presetAt < memoryAt && memoryAt < commAt, 'memory sits before the communication group')
})

test('subagents get role and constraint sections in the parent prompt', () => {
  const text = prompt({
    tools: [tool('read_file')],
    subagent: {
      name: 'explore',
      instructions: '只读调查代码。',
      permissionCeiling: 'read-only',
      effectiveTools: ['read_file'],
    },
  })
  assert.ok(text.includes('# 你的角色（子代理）\n名称：explore\n只读调查代码。'))
  assert.ok(text.includes('# 子代理约束'))
  assert.ok(text.includes('可用工具仅限：read_file。'))
  assert.ok(text.includes('权限上限：read-only（写文件与命令一律被拒绝）；'))
  assert.ok(!text.includes('- bash 只跑构建'), 'the child does not see ungranted tool rules')
  assert.ok(text.includes('不能派遣子代理'))
})

test('runtime context carries workspace, permission and instance facts', () => {
  const runtime = buildRuntimeContext({
    cwd: 'D:/work',
    sandbox: false,
    permission: presetState('read-only'),
  })
  assert.ok(runtime.startsWith('Current runtime context.'))
  assert.ok(runtime.includes('工作目录:D:/work（相对路径以它为根）'))
  assert.ok(runtime.includes('当前权限模式:只读'))
  assert.ok(!runtime.includes('本实例 API'))

  const planned = buildRuntimeContext({
    cwd: '/work',
    sandbox: false,
    permission: presetState('workspace-write', 'plan'),
    apiBase: 'http://127.0.0.1:43655',
  })
  assert.ok(planned.includes('当前权限模式:计划'))
  assert.ok(planned.includes('本实例 API:http://127.0.0.1:43655'))
})

test('a custom persona replaces the factory text and interpolates variables', () => {
  const text = prompt({
    persona: '项目 persona at {{cwd}} via {{provider}}/{{model}}',
    model: 'm',
    provider: 'p',
  })
  assert.ok(text.startsWith('项目 persona at /work via p/m'))
  assert.ok(!text.includes(DEFAULT_PERSONA))
})

test('permission presets keep their routing note distinct', () => {
  const states: Array<[PermissionState, string]> = [
    [presetState('workspace-write'), '当前权限模式:自动编辑'],
    [presetState('approve-for-me'), '当前权限模式:自动审查'],
    [presetState('full-access'), '当前权限模式:完全访问'],
  ]
  for (const [permission, expected] of states) {
    const runtime = buildRuntimeContext({ cwd: '/w', sandbox: false, permission })
    assert.ok(runtime.includes(expected), `missing permission text: ${expected}`)
  }
})