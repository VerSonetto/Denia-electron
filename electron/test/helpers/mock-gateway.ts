// A small OpenAI-completions-compatible SSE gateway for integration tests.
//
// The responder sees the parsed request body and returns either text or tool
// calls; the helper emits the exact delta shape the adapter expects.

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

export interface GatewayMessage {
  role: string
  content?: unknown
  tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

export interface GatewayRequest {
  messages: GatewayMessage[]
  tools?: { function: { name: string } }[]
}

export interface GatewayPlan {
  text?: string
  calls?: { name: string; arguments: Record<string, unknown>; id?: string }[]
  usage?: {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    reasoningTokens?: number
  }
}

export interface MockGateway {
  baseURL: string
  requests: GatewayRequest[]
  close(): Promise<void>
}

export async function startMockGateway(
  respond: (request: GatewayRequest) => GatewayPlan,
): Promise<MockGateway> {
  const requests: GatewayRequest[] = []
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'mock-1' }] }))
      return
    }
    if (!req.url?.startsWith('/v1/chat/completions')) {
      res.writeHead(404)
      res.end()
      return
    }
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      let body: GatewayRequest = { messages: [] }
      try {
        body = JSON.parse(raw) as GatewayRequest
      } catch {
        /* ignore */
      }
      requests.push(body)
      const plan = respond(body)
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const write = (payload: unknown): void => {
        res.write(`data: ${JSON.stringify(payload)}\n\n`)
      }
      write({ choices: [{ index: 0, delta: { role: 'assistant' } }] })
      if (plan.text) {
        write({ choices: [{ index: 0, delta: { content: plan.text } }] })
      }
      if (plan.calls && plan.calls.length > 0) {
        write({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: plan.calls.map((call, index) => ({
                  index,
                  id: call.id ?? `call_${index}_${Date.now()}`,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                })),
              },
            },
          ],
        })
      }
      write({
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: plan.calls && plan.calls.length > 0 ? 'tool_calls' : 'stop',
          },
        ],
      })
      const usage = plan.usage ?? {}
      write({
        usage: {
          prompt_tokens: usage.inputTokens ?? 10,
          completion_tokens: usage.outputTokens ?? 5,
          ...(usage.cacheReadTokens ? { prompt_tokens_details: { cached_tokens: usage.cacheReadTokens } } : {}),
          ...(usage.reasoningTokens
            ? { completion_tokens_details: { reasoning_tokens: usage.reasoningTokens } }
            : {}),
        },
      })
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

export function lastToolContents(request: GatewayRequest): string[] {
  return request.messages
    .filter((message) => message.role === 'tool')
    .map((message) => (typeof message.content === 'string' ? message.content : ''))
}

export function lastUserText(request: GatewayRequest): string {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index]!
    if (message.role === 'user' && typeof message.content === 'string') {
      const text = message.content
      if (
        text.startsWith('<available_skills>') ||
        text.startsWith('<system-reminder>') ||
        text.startsWith('[denia ')
      ) {
        continue
      }
      return text
    }
  }
  return ''
}

export function writeConfig(home: string, baseURL: string): void {
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({
      providers: [
        {
          id: 'mock',
          name: 'Mock',
          baseURL,
          protocol: 'openai-completions',
          models: [{ id: 'mock-1', name: 'Mock 1', contextWindow: 128_000 }],
        },
      ],
      default: { provider: 'mock', model: 'mock-1' },
    }),
  )
}