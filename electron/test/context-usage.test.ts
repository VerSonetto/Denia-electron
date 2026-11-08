// Context usage accounting: density, per-message cost and the disjoint split
// between the frozen system prompt, injected baseline rows, tool schemas and
// the conversation.

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildContextUsageSnapshot,
  estimateMessageChars,
  estimateMessageTokens,
  estimateTextTokens,
  summarizeContextUsage,
} from '../src/agent/context-usage.ts'
import type { SurfaceItem } from '../src/agent/history.ts'
import type { ToolSchema } from '../src/core/wire.ts'

function item(
  seq: number,
  channel: string | null,
  message: SurfaceItem['message'],
): SurfaceItem {
  return { seq, channel, isError: false, message }
}

const READ_TOOL: ToolSchema = {
  name: 'read_file',
  description: '读取文件内容',
  parameters: { type: 'object', properties: { path: { type: 'string' } } },
}

const MCP_TOOL: ToolSchema = {
  name: 'mcp__fixture__echo',
  description: 'Echo text',
  parameters: { type: 'object', properties: { text: { type: 'string' } } },
}

test('token density: CJK one per character, others four per token', () => {
  assert.equal(estimateTextTokens(''), 0)
  assert.equal(estimateTextTokens('abcd'), 1)
  assert.equal(estimateTextTokens('abcde'), 2)
  assert.equal(estimateTextTokens('你好'), 2)
  assert.equal(estimateTextTokens('你好abcd'), 3)
  // Fullwidth punctuation and kana are CJK too.
  assert.equal(estimateTextTokens('（、あ'), 3)
})

test('message cost: role frame, content, images, reasoning and tool calls', () => {
  assert.equal(estimateMessageTokens({ role: 'user', content: 'hello' }), 6)
  // Tool results carry only their body, even if a stray call list is present.
  assert.equal(
    estimateMessageTokens({
      role: 'tool',
      content: 'ok',
      toolCallId: 'call-1',
      toolCalls: [{ id: 'call-1', name: 'read_file', arguments: '{}' }],
    }),
    5,
  )
  const call = { id: 'call-1', name: 'read_file', arguments: '{"path":"a"}' }
  const body = estimateMessageTokens({ role: 'assistant', content: '', toolCalls: [call] })
  const callCost =
    4 +
    estimateTextTokens(call.id) +
    estimateTextTokens(call.name) +
    estimateTextTokens(call.arguments)
  assert.equal(body, 4 + callCost)
  // Characters are counted from the same pieces, without the role frame.
  assert.equal(estimateMessageChars({ role: 'user', content: '你好' }), 2)
})

test('snapshot: baseline rows, skills and tool sources are disjoint', () => {
  const surface: SurfaceItem[] = [
    item(1, 'runtime-context', { role: 'user', content: '运行时事实 abc' }),
    item(2, 'skill-catalog', { role: 'user', content: '<system-reminder>\n技能目录:' }),
    item(3, 'skill-invocation', { role: 'user', content: '[技能正文]' }),
    item(4, null, { role: 'user', content: '问题' }),
    item(5, null, {
      role: 'assistant',
      content: '回答',
      toolCalls: [{ id: 'call-1', name: 'read_file', arguments: '{"path":"a"}' }],
    }),
    item(6, null, { role: 'tool', content: '结果', toolCallId: 'call-1' }),
  ]
  const system = '系统提示词'
  const snapshot = buildContextUsageSnapshot({
    system,
    tools: [READ_TOOL, MCP_TOOL],
    surface,
  })

  const part = (key: string) => snapshot.parts.find((entry) => entry.key === key)!
  assert.equal(part('systemPrompt').tokens, estimateTextTokens(system))
  assert.equal(part('metaUserContext').tokens, estimateMessageTokens(surface[0]!.message))
  assert.equal(part('skills').tokens, estimateMessageTokens(surface[1]!.message))
  assert.equal(
    part('messages').tokens,
    surface
      .slice(2)
      .reduce((sum, entry) => sum + estimateMessageTokens(entry.message), 0),
  )
  assert.ok(part('systemTools').tokens > 0)
  assert.ok(part('mcpTools').tokens > 0)
  assert.deepEqual(
    snapshot.tools.map((tool) => [tool.name, tool.source]),
    [
      ['read_file', 'system'],
      ['mcp__fixture__echo', 'mcp'],
    ],
  )
  assert.deepEqual(
    Object.fromEntries(snapshot.messageRoles.map((role) => [role.role, role.count])),
    { user: 2, assistant: 1, tool: 1 },
  )
  assert.equal(
    snapshot.totalTokens,
    snapshot.parts.reduce((sum, entry) => sum + entry.tokens, 0),
  )

  const summary = summarizeContextUsage(snapshot.parts)
  assert.equal(
    summary.systemTokens,
    part('systemPrompt').tokens + part('metaUserContext').tokens + part('skills').tokens,
  )
  assert.equal(summary.toolsTokens, part('systemTools').tokens + part('mcpTools').tokens)
  assert.equal(summary.messageTokens, part('messages').tokens)
})

test('legacy reminder rows without a channel count as runtime context', () => {
  const snapshot = buildContextUsageSnapshot({
    system: '',
    tools: [],
    surface: [
      item(1, null, { role: 'user', content: '<system-reminder>\n历史提醒' }),
      item(2, null, { role: 'user', content: '问题' }),
    ],
  })
  const part = (key: string) => snapshot.parts.find((entry) => entry.key === key)!
  assert.equal(part('metaUserContext').tokens, estimateMessageTokens({ role: 'user', content: '<system-reminder>\n历史提醒' }))
  assert.equal(part('messages').tokens, estimateMessageTokens({ role: 'user', content: '问题' }))
})

test('pending system update is counted with the baseline context', () => {
  const update = '<system-reminder>\n系统提示更新'
  const snapshot = buildContextUsageSnapshot({
    system: '冻结前缀',
    tools: [],
    surface: [],
    pendingSystemUpdate: update,
  })
  const meta = snapshot.parts.find((part) => part.key === 'metaUserContext')!
  assert.equal(meta.tokens, estimateMessageTokens({ role: 'user', content: update }))
})
