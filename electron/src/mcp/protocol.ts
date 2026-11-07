// MCP wire protocol: JSON-RPC 2.0 envelopes, SSE framing and content folding.
//
// MCP keeps a minimal surface here: initialize → notifications/initialized →
// tools/list / tools/call. Frames are newline-delimited JSON on stdio; HTTP
// transports may answer with a plain JSON body or an SSE stream.

export const PROTOCOL_VERSION = '2024-11-05'
export const CLIENT_NAME = 'denia'
export const CLIENT_VERSION = '0.2.0'

export const METHOD_INITIALIZE = 'initialize'
export const METHOD_INITIALIZED = 'notifications/initialized'
export const METHOD_TOOLS_LIST = 'tools/list'
export const METHOD_TOOLS_CALL = 'tools/call'

export const HEADER_PROTOCOL_VERSION = 'mcp-protocol-version'
export const HEADER_SESSION_ID = 'mcp-session-id'
export const ACCEPT_JSON_OR_SSE = 'application/json, text/event-stream'
export const ACCEPT_SSE = 'text/event-stream'

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: unknown
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcResponse {
  jsonrpc?: string
  id?: unknown
  result?: unknown
  error?: JsonRpcError
}

export interface McpToolDef {
  name: string
  description: string
  inputSchema: unknown
}

export interface McpCallResult {
  text: string
  isError: boolean
}

export function requestFrame(id: number, method: string, params?: unknown): JsonRpcRequest {
  return params === undefined
    ? { jsonrpc: '2.0', id, method }
    : { jsonrpc: '2.0', id, method, params }
}

export function notificationFrame(method: string, params?: unknown): Record<string, unknown> {
  return params === undefined
    ? { jsonrpc: '2.0', method }
    : { jsonrpc: '2.0', method, params }
}

export function initializeParams(): Record<string, unknown> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
  }
}

/** Fold an MCP `content` array into plain text the model can read. */
export function flattenContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const item of content) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const kind = typeof record.type === 'string' ? record.type : ''
    if (kind === 'text') {
      if (typeof record.text === 'string') parts.push(record.text)
    } else if (kind === 'image') {
      parts.push('[该工具返回了一张图片,denia 暂不支持回传图片内容]')
    } else if (kind === 'resource') {
      const resource = record.resource
      const uri =
        typeof resource === 'object' && resource !== null && typeof (resource as Record<string, unknown>).uri === 'string'
          ? ((resource as Record<string, unknown>).uri as string)
          : '(unknown)'
      parts.push(`[该工具返回了一个资源:${uri}]`)
    } else {
      parts.push(`[该工具返回了不支持的内容类型:${kind || 'unknown'}]`)
    }
  }
  return parts.join('\n')
}

export function callResultFrom(value: unknown): McpCallResult {
  if (typeof value !== 'object' || value === null) return { text: '', isError: false }
  const record = value as Record<string, unknown>
  return {
    text: flattenContent(record.content),
    isError: record.isError === true,
  }
}

export function parseToolsList(value: unknown): McpToolDef[] {
  if (typeof value !== 'object' || value === null) return []
  const tools = (value as Record<string, unknown>).tools
  if (!Array.isArray(tools)) return []
  const out: McpToolDef[] = []
  for (const item of tools) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const name = typeof record.name === 'string' ? record.name : ''
    if (name.trim() === '') continue
    const description = typeof record.description === 'string' ? record.description : ''
    const schema =
      record.inputSchema !== undefined && record.inputSchema !== null && typeof record.inputSchema === 'object'
        ? record.inputSchema
        : { type: 'object' }
    out.push({ name, description, inputSchema: schema })
  }
  return out
}

/**
 * Parse the first event in an SSE body and return its `data:` payload.
 * Multi-line `data:` fields are concatenated, a blank line ends the event.
 */
export function parseSseData(body: string): string | null {
  let payload = ''
  let sawData = false
  for (const raw of body.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line === '') {
      if (sawData) break
      continue
    }
    if (line.startsWith('data:')) {
      sawData = true
      payload += line.slice('data:'.length).replace(/^ /, '')
    }
  }
  return sawData && payload.trim() !== '' ? payload : null
}

export interface SseEvent {
  event: string
  data: string
}

/** Split a raw SSE text buffer into complete events. */
export function splitSseEvents(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = []
  let rest = buffer
  while (true) {
    const boundary = rest.indexOf('\n\n')
    const crlfBoundary = rest.indexOf('\r\n\r\n')
    if (boundary < 0 && crlfBoundary < 0) break
    const at = boundary >= 0 && (crlfBoundary < 0 || boundary < crlfBoundary) ? boundary : crlfBoundary
    const raw = rest.slice(0, at)
    rest = rest.slice(at + (at === boundary ? 2 : 4))
    let event = 'message'
    let data = ''
    for (const rawLine of raw.split('\n')) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
      if (line.startsWith('event:')) event = line.slice('event:'.length).trim()
      else if (line.startsWith('data:')) data += line.slice('data:'.length).replace(/^ /, '')
    }
    events.push({ event, data })
  }
  return { events, rest }
}