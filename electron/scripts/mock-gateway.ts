// Stateful OpenAI-compatible mock gateway for UI smoke tests.
//
// Step 1: todo_write → Step 2: bash(echo hi-from-mock) → Step 3: final text.
// Also streams a reasoning block on the first step so the UI can exercise it.

import http from 'node:http'

const port = Number(process.env.MOCK_PORT ?? 8787)
const delay = Number(process.env.MOCK_DELAY_MS ?? 120)

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

http
  .createServer((req, res) => {
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
    req.on('end', async () => {
      let body = {}
      try {
        body = JSON.parse(raw)
      } catch {
        /* ignore */
      }
      const toolContents = (body.messages ?? [])
        .filter((message) => message.role === 'tool')
        .map((message) => (typeof message.content === 'string' ? message.content : ''))
      const sawTodo = toolContents.some((content) => content.includes('已更新任务列表'))
      const sawBash = toolContents.some((content) => content.includes('hi-from-mock'))

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const write = (payload) => res.write(sse(payload))

      if (!sawTodo) {
        write({ choices: [{ index: 0, delta: { role: 'assistant' } }] })
        for (const part of ['先看任务，', '再规划步骤。']) {
          await wait(delay)
          write({ choices: [{ index: 0, delta: { reasoning_content: part } }] })
        }
        await wait(delay)
        write({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_todo',
                    type: 'function',
                    function: {
                      name: 'todo_write',
                      arguments: JSON.stringify({
                        todos: [{ content: '运行命令验证链路', status: 'in_progress' }],
                      }),
                    },
                  },
                ],
              },
            },
          ],
        })
        write({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
        write({ usage: { prompt_tokens: 10, completion_tokens: 5 } })
        res.end()
        return
      }
      if (!sawBash) {
        write({ choices: [{ index: 0, delta: { role: 'assistant' } }] })
        write({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_bash',
                    type: 'function',
                    function: { name: 'bash', arguments: JSON.stringify({ command: 'echo hi-from-mock' }) },
                  },
                ],
              },
            },
          ],
        })
        write({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
        res.end()
        return
      }
      write({ choices: [{ index: 0, delta: { role: 'assistant' } }] })
      for (const part of ['链路验证完成：', 'todo 与 bash 都已执行。']) {
        await wait(delay)
        write({ choices: [{ index: 0, delta: { content: part } }] })
      }
      write({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      write({
        usage: {
          prompt_tokens: 30,
          completion_tokens: 8,
          prompt_tokens_details: { cached_tokens: 4 },
        },
      })
      res.end()
    })
  })
  .listen(port, '127.0.0.1', () => {
    console.log(`[mock] http://127.0.0.1:${port}/v1`)
  })