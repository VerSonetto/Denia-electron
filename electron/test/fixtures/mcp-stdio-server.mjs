// Minimal stdio MCP server used by tests: newline-delimited JSON-RPC.
import readline from 'node:readline'

let callCount = 0

const tools = [
  {
    name: 'echo',
    description: 'Echo the input text',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'big',
    description: 'Return a long text',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'fail',
    description: 'Return a business error',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'count',
    description: 'Return how many times this tool ran',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'quirky name.v2',
    description: 'A tool whose name needs folding',
    inputSchema: { type: 'object', properties: {} },
  },
]

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

function respondError(id, code, message) {
  process.stdout.write(
    JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n',
  )
}

function call(name, args) {
  switch (name) {
    case 'echo':
      return { content: [{ type: 'text', text: `echo:${args.text ?? ''}` }] }
    case 'big':
      return { content: [{ type: 'text', text: '0123456789'.repeat(2000) }] }
    case 'fail':
      return { content: [{ type: 'text', text: 'boom' }], isError: true }
    case 'count':
      callCount += 1
      return { content: [{ type: 'text', text: `count:${callCount}` }] }
    case 'quirky name.v2':
      return {
        content: [
          { type: 'text', text: 'quirky' },
          { type: 'image', data: 'AAA' },
          { type: 'resource', resource: { uri: 'file:///a.txt' } },
        ],
      }
    default:
      return null
  }
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', (line) => {
  const trimmed = line.trim()
  if (trimmed === '') return
  let message
  try {
    message = JSON.parse(trimmed)
  } catch {
    return
  }
  if (message.method === 'initialize') {
    respond(message.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'fixture', version: '1.0.0' },
    })
    return
  }
  if (message.method === 'notifications/initialized') return
  if (message.method === 'tools/list') {
    respond(message.id, { tools })
    return
  }
  if (message.method === 'tools/call') {
    const result = call(message.params?.name, message.params?.arguments ?? {})
    if (result === null) {
      respondError(message.id, -32601, `unknown tool ${message.params?.name}`)
      return
    }
    respond(message.id, result)
    return
  }
  respondError(message.id, -32601, `unknown method ${message.method}`)
})