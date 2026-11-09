// Alignment with ZCode's context trimming: reasoning stays out of requests,
// archived write arguments leave the model surface, repeat reads collapse to a
// pointer, and one request's image payload is bounded.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import type { ChatMessage, Envelope } from '../src/core/wire.ts'
import { deriveSurface } from '../src/agent/history.ts'
import { applyMediaBudget } from '../src/agent/media-budget.ts'
import { budgetFor, renderPreview } from '../src/agent/tool-output.ts'
import { SessionOutputStore } from '../src/agent/tool-output.ts'
import { SessionStore } from '../src/session/store.ts'
import { ReadStateStore } from '../src/tools/read-state.ts'
import { ReadFileTool, WriteFileTool } from '../src/tools/files.ts'
import type { ToolContext } from '../src/tools/types.ts'
import { toOpenAiMessages } from '../src/llm/openai-completions.ts'

let seq = 0
function envelope(event: Omit<Envelope, 'seq' | 'time'>): Envelope {
  seq += 1
  return { seq, time: 1_700_000_000_000 + seq, ...event } as Envelope
}

function assistantWithReasoning(id: string, text: string, reasoning: string): Envelope {
  return envelope({
    type: 'assistant-message',
    turn: 1,
    step: 1,
    blocks: [
      { type: 'reasoning', text: reasoning },
      { type: 'text', text },
      { type: 'tool-call', id, name: 'read_file', arguments: '{"path":"a.ts"}' },
    ],
  } as Omit<Envelope, 'seq' | 'time'>)
}

function ctxFor(cwd: string, readState: ReadStateStore, emit: (event: unknown) => void): ToolContext {
  return {
    sessionId: 's1',
    callId: 'c1',
    cwd,
    confined: true,
    cancel: new AbortController().signal,
    emit: emit as ToolContext['emit'],
    readState,
  }
}

test('reasoning text stays out of the request unless the route opts in', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      content: 'working',
      reasoningContent: 'deep thoughts',
      toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{}' }],
    },
    { role: 'tool', content: 'ok', toolCallId: 'c1' },
  ]

  const off = toOpenAiMessages(undefined, messages, false) as Record<string, unknown>[]
  const history = off.find((entry) => entry.role === 'assistant')!
  assert.equal('reasoning_content' in history, false)
  assert.equal(history.content, 'working')

  const on = toOpenAiMessages(undefined, messages, true) as Record<string, unknown>[]
  assert.equal(on.find((entry) => entry.role === 'assistant')!.reasoning_content, 'deep thoughts')
})

test('an archived write call and its result leave the model surface', () => {
  const events = [
    envelope({ type: 'turn-start', turn: 1 } as Omit<Envelope, 'seq' | 'time'>),
    envelope({ type: 'user-message', text: 'write it', injected: false } as Omit<Envelope, 'seq' | 'time'>),
    envelope({
      type: 'assistant-message',
      turn: 1,
      step: 1,
      blocks: [
        { type: 'tool-call', id: 'w1', name: 'write_file', arguments: '{"path":"big.txt","content":"..."}' },
      ],
    } as Omit<Envelope, 'seq' | 'time'>),
    envelope({
      type: 'tool-result',
      turn: 1,
      step: 1,
      call_id: 'w1',
      content: '已写入 big.txt',
      is_error: false,
    } as Omit<Envelope, 'seq' | 'time'>),
    envelope({
      type: 'args-cleared',
      turn: 1,
      step: 1,
      call_id: 'w1',
      placeholder: '[工具调用归档] big.txt 已成功写入',
    } as Omit<Envelope, 'seq' | 'time'>),
  ]

  const surface = deriveSurface(events)
  assert.equal(surface.some((item) => item.message.role === 'tool'), false)
  assert.equal(
    surface.some((item) => (item.message.toolCalls ?? []).some((call) => call.id === 'w1')),
    false,
  )
  // The call-only assistant message disappears with it; the note remains.
  assert.equal(surface.some((item) => item.message.role === 'assistant'), false)
  const note = surface.find((item) => item.message.content.startsWith('[工具调用归档]'))
  assert.ok(note)
})

test('a repeated read of an unchanged view returns a pointer, not the content', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-readstate-'))
  const file = path.join(dir, 'a.txt')
  fs.writeFileSync(file, 'line one\nline two\n', 'utf8')
  const readState = new ReadStateStore()
  const ctx = ctxFor(dir, readState, () => {})

  const first = await ReadFileTool.execute({ path: 'a.txt' }, ctx)
  assert.match(first.content, /line two/)
  const meta = (first as { meta?: unknown }).meta as {
    readStamp: { key: string; mtimeMs: number; size: number }
  }
  readState.remember(meta.readStamp.key, {
    callId: 'c1',
    seq: 1,
    stamp: { mtimeMs: meta.readStamp.mtimeMs, size: meta.readStamp.size },
  })

  const second = await ReadFileTool.execute({ path: 'a.txt' }, ctx)
  assert.match(second.content, /未变更/)
  assert.equal(second.content.includes('line two'), false)

  // A write to the same path makes the view readable again.
  await WriteFileTool.execute({ path: 'a.txt', content: 'changed\n' }, ctx)
  const third = await ReadFileTool.execute({ path: 'a.txt' }, ctx)
  assert.match(third.content, /changed/)
})

test('a cleared result drops the read stamp that pointed at it', () => {
  const readState = new ReadStateStore()
  readState.remember('k', { callId: 'c1', seq: 3, stamp: { mtimeMs: 1, size: 2 } })
  assert.equal(readState.isUnchanged('k', { mtimeMs: 1, size: 2 }), true)
  readState.forgetCalls(['c1'])
  assert.equal(readState.isUnchanged('k', { mtimeMs: 1, size: 2 }), false)
})

test('the media budget drops the oldest images and keeps the newest', () => {
  const image = (size: number) => ({ mime: 'image/png', data: 'a'.repeat(size) })
  const messages: ChatMessage[] = [
    { role: 'user', content: 'first', images: [image(600)] },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'second', images: [image(600)] },
  ]
  const result = applyMediaBudget(messages, 1_000)
  assert.equal(result.omittedImages, 1)
  assert.equal(result.messages[0]!.images?.length ?? 0, 0)
  assert.match(result.messages[0]!.content, /图片已省略/)
  assert.equal(result.messages[2]!.images?.length, 1)
  // Input stays untouched: the log is the source of truth.
  assert.equal(messages[0]!.images?.length, 1)
})

test('a single oversized image still reaches the model', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'shot', images: [{ mime: 'image/png', data: 'a'.repeat(5_000) }] },
  ]
  const result = applyMediaBudget(messages, 1_000)
  assert.equal(result.omittedImages, 0)
  assert.equal(result.messages[0]!.images?.length, 1)
})
test('command output keeps its tail, search output keeps its head', () => {
  const body = Array.from({ length: 1_000 }, (_, index) => `row ${index} ${'y'.repeat(40)}`).join(String.fromCharCode(10))
  const tail = renderPreview(body, budgetFor('bash'), 'art1')
  assert.match(tail.content, /row 999/)
  assert.match(tail.content, /中间部分省略/)
  assert.match(tail.content, /read_tool_output\(output_id="art1"/)
  assert.ok(Array.from(tail.content).length <= budgetFor('bash').max)

  const head = renderPreview(body, budgetFor('grep'), 'art2')
  assert.match(head.content, /row 0/)
  assert.match(head.content, /输出已截断/)
  assert.ok(Array.from(head.content).length <= budgetFor('grep').max)
})

test('a preview without an artifact still says what was lost', () => {
  const body = 'x'.repeat(40_000)
  const preview = renderPreview(body, budgetFor('read_file'), null)
  assert.match(preview.content, /输出已截断/)
  assert.equal(preview.content.includes('产物'), false)
})

test('artifacts never shadow an older pointer with the same call id', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-artifact-store-'))
  const store = new SessionStore(home)
  const outputs = new SessionOutputStore(store)
  const first = outputs.save('s1', 'call_1', 'first body')
  const second = outputs.save('s1', 'call_1', 'second body')
  assert.ok(first && second)
  assert.notEqual(first, second)
  assert.equal(outputs.read('s1', first!), 'first body')
  assert.equal(outputs.read('s1', second!), 'second body')
  // Artifact ids stay inside the session directory.
  assert.equal(outputs.read('s1', '../escape'), null)
})

// ---- oversized tool output: bounded preview plus a paged artifact ----

import { startHost } from '../src/host/server.ts'
import type { Host } from '../src/host/server.ts'
import {
  lastToolContents,
  startMockGateway,
  writeConfig,
} from './helpers/mock-gateway.ts'

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

async function waitForTurn(host: Host, id: string): Promise<Envelope[]> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const body = (await (await fetch(`${host.baseUrl}/api/sessions/${id}`)).json()) as {
      events: Envelope[]
    }
    if (body.events.some((event) => event.type === 'turn-end')) return body.events
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('turn did not finish in time')
}

test('an oversized tool result keeps its full text in a paged artifact', async () => {
  const home = tempDir('denia-artifact-home-')
  const project = tempDir('denia-artifact-cwd-')
  const lines = Array.from({ length: 1_200 }, (_, index) => `line ${index} of the big file ${'x'.repeat(40)}`)
  fs.writeFileSync(path.join(project, 'big.txt'), lines.join('\n'), 'utf8')

  const mock = await startMockGateway((request) => {
    const tools = lastToolContents(request)
    // Paging came back with the middle of the file: the turn can close.
    if (tools.some((content) => content.includes('line 1000 of the big file'))) {
      return { text: 'done' }
    }
    // First result was truncated: page through it instead of re-running.
    if (tools.some((content) => content.includes('完整内容保存为产物'))) {
      return { calls: [{ name: 'read_tool_output', arguments: { output_id: 'call_big', offset: 1001, limit: 2 } }] }
    }
    return { calls: [{ id: 'call_big', name: 'read_file', arguments: { path: 'big.txt', limit: 1200 } }] }
  })
  writeConfig(home, mock.baseURL)
  const host = await startHost({ home, webDir: tempDir('denia-artifact-web-'), port: 0 })
  try {
    const created = await fetch(`${host.baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: project }),
    })
    const sessionId = ((await created.json()) as { session: { id: string } }).session.id
    const prompted = await fetch(`${host.baseUrl}/api/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'read the big file', provider: 'mock', model: 'mock-1' }),
    })
    assert.equal(prompted.status, 202)

    const events = await waitForTurn(host, sessionId)
    const results = events.filter(
      (event): event is Extract<Envelope, { type: 'tool-result' }> => event.type === 'tool-result',
    )
    const first = results.find((event) => event.call_id === 'call_big')
    assert.ok(first, 'the read result must be in the log')
    assert.match(first.content, /输出已截断/)
    // The preview stays inside the tool's own budget.
    assert.ok(Array.from(first.content).length <= 32_000)
    const artifact = (first.meta as { outputArtifact?: { output_id: string; chars: number } })
      .outputArtifact
    assert.equal(artifact?.output_id, 'call_big')
    assert.ok((artifact?.chars ?? 0) > 32_000)

    // The full text is on disk, next to the session log.
    const stored = fs.readFileSync(
      path.join(home, 'sessions', sessionId, 'tool-output-call_big.txt'),
      'utf8',
    )
    assert.match(stored, /line 1199 of the big file/)

    // And the model could page through it without re-reading the file.
    const paged = results.find((event) => event.content.includes('产物 call_big 第 1001-1002 行'))
    assert.ok(paged, 'read_tool_output must return the requested page')
    assert.match(paged.content, /line 1000 of the big file/)
  } finally {
    await host.close()
    await mock.close()
  }
})
