// `browser` 工具的渲染契约:命令面、截图注入、错误身份。

import assert from 'node:assert/strict'
import test from 'node:test'

import type { CommandOutcome } from '../src/browser/types.ts'
import type { SessionEvent } from '../src/core/wire.ts'
import { createBrowserTool } from '../src/tools/browser.ts'
import type { ToolContext } from '../src/tools/types.ts'

function context(events: SessionEvent[]): ToolContext {
  return {
    sessionId: 's1',
    callId: 'c1',
    cwd: process.cwd(),
    confined: false,
    cancel: new AbortController().signal,
    emit: (event) => {
      events.push(event)
    },
  }
}

function backendReturning(outcome: CommandOutcome) {
  const calls: Record<string, unknown>[] = []
  return {
    calls,
    backend: {
      async execute(command: Record<string, unknown>): Promise<CommandOutcome> {
        calls.push(command)
        return outcome
      },
      requestVisualMode(): void {},
    },
  }
}

test('the browser schema advertises the analysis commands', () => {
  const tool = createBrowserTool(backendReturning({ ok: true, elapsedMs: 1 }).backend)
  assert.equal(tool.schema.name, 'browser')
  const parameters = tool.schema.parameters as { properties: { method: { enum: string[] } } }
  for (const method of ['navigate', 'clickElement', 'setBreakpointOnText', 'getPausedInfo', 'shutdownBrowser']) {
    assert.ok(parameters.properties.method.enum.includes(method), `missing method: ${method}`)
  }
  assert.ok(tool.schema.description.includes('shutdownBrowser'), 'the shutdown contract is documented')
})

test('a successful outcome renders value and tabs', async () => {
  const outcome: CommandOutcome = {
    ok: true,
    elapsedMs: 3,
    value: { url: 'https://example.com' },
    tabs: [{ tabId: 't1', url: 'https://example.com', title: 'Example', active: true }],
  }
  const tool = createBrowserTool(backendReturning(outcome).backend)
  const output = await tool.execute({ method: 'navigate', url: 'https://example.com' }, context([]))
  assert.equal(output.isError, false)
  assert.ok(output.content.includes('https://example.com'))
  assert.ok(output.content.includes('* t1'), 'the active tab is marked')
})

test('a screenshot is injected as vision input, not just text', async () => {
  const outcome: CommandOutcome = {
    ok: true,
    elapsedMs: 5,
    image: { base64: 'aGVsbG8=', mimeType: 'image/png' },
  }
  const events: SessionEvent[] = []
  const tool = createBrowserTool(backendReturning(outcome).backend)
  const output = await tool.execute({ method: 'screenshot' }, context(events))
  assert.equal(output.isError, false)
  assert.ok(output.content.includes('截图'))
  const injected = events.find((event) => event.type === 'user-message')
  assert.ok(injected && injected.type === 'user-message')
  assert.equal(injected.injected, true)
  assert.equal(injected.images?.[0]?.mime, 'image/png')
  assert.equal(injected.images?.[0]?.data, 'aGVsbG8=')
})

test('a failed command keeps the upstream error code', async () => {
  const outcome: CommandOutcome = {
    ok: false,
    elapsedMs: 2,
    error: { code: 'not-found', message: '没有第 0 个标签页' },
  }
  const tool = createBrowserTool(backendReturning(outcome).backend)
  const output = await tool.execute({ method: 'activate', tabId: 't9' }, context([]))
  assert.equal(output.isError, true)
  assert.equal(output.errorIdentity?.code, 'not-found')
  assert.ok(output.content.includes('没有第 0 个标签页'))
})

test('visualMode asks the host to expand the sidebar before running', async () => {
  let requested = 0
  const calls: Record<string, unknown>[] = []
  const tool = createBrowserTool({
    async execute(command): Promise<CommandOutcome> {
      calls.push(command)
      return { ok: true, elapsedMs: 1 }
    },
    requestVisualMode(): void {
      requested += 1
    },
  })
  await tool.execute({ method: 'list', visualMode: true }, context([]))
  assert.equal(requested, 1)
  assert.equal(calls[0]?.visualMode, true)
})