// MCP server configuration: shape, validation and model-visible tool names.
//
// Servers live in `settings.yaml` under the `mcp` namespace:
//   mcp:
//     servers:
//       - id: fs
//         transport: stdio
//         command: npx
//         args: ["-y", "@modelcontextprotocol/server-filesystem", "."]
//
// Environment values and request headers are credentials: the describe surface
// only returns their keys.

export type McpServerScope = 'user' | 'project'

export interface McpServerConfig {
  id: string
  transport: string
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string | null
  url: string | null
  headers: Record<string, string>
  enabled: boolean
  disabledTools: string[]
  scope: McpServerScope
  workspaceId?: string | null
  protocolVersion: string
  callTimeoutMs?: number | null
}

export const SUPPORTED_TRANSPORTS = ['stdio', 'http', 'sse'] as const
export const MAX_SERVERS = 32
export const MAX_ARGS = 64
/** Handshake and tools/list timeout. */
export const REQUEST_TIMEOUT_MS = 30_000
/** Default tools/call timeout; external tools can be slow. */
export const CALL_TIMEOUT_MS = 120_000

export function defaultServerConfig(id = ''): McpServerConfig {
  return {
    id,
    transport: 'stdio',
    command: '',
    args: [],
    env: {},
    cwd: null,
    url: null,
    headers: {},
    enabled: true,
    disabledTools: [],
    scope: 'user',
    protocolVersion: '2024-11-05',
    callTimeoutMs: null,
  }
}

export function isSupportedTransport(value: string): boolean {
  return (SUPPORTED_TRANSPORTS as readonly string[]).includes(value)
}

/** Server id grammar: `[a-z][a-z0-9-]{0,31}` (it prefixes every tool name). */
export function isValidServerId(id: string): boolean {
  if (!/^[a-z][a-z0-9-]*$/.test(id)) return false
  return id.length <= 32
}

export function isValidUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Model-visible tool name: `mcp__<server>__<tool>`.
 * Tool names are folded to `[A-Za-z0-9_-]` with runs of underscores collapsed,
 * so a server-provided odd name is still writable by the model.
 */
export function qualifyToolName(server: string, tool: string): string {
  let sanitized = ''
  let lastUnderscore = false
  for (const ch of tool) {
    if (/[A-Za-z0-9]/.test(ch)) {
      sanitized += ch
      lastUnderscore = false
    } else if (ch === '_' || ch === '-' || /\s/.test(ch) || ch === '.') {
      if (!lastUnderscore) {
        sanitized += '_'
        lastUnderscore = true
      }
    }
  }
  sanitized = sanitized.replace(/^_+|_+$/g, '')
  if (sanitized === '') sanitized = 'tool'
  return `mcp__${server}__${sanitized}`
}

/** Connection fingerprint: tool toggles are filters and must not reconnect. */
export function connectionKey(config: McpServerConfig): string {
  return JSON.stringify([
    config.command,
    config.args,
    sortedEntries(config.env),
    config.cwd,
    config.transport,
    config.enabled,
    config.url,
    sortedEntries(config.headers),
  ])
}

function sortedEntries(value: Record<string, string>): [string, string][] {
  return Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
}

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') out[key] = entry
  }
  return out
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

/** Normalize one incoming config object (unknown fields are ignored). */
export function normalizeServerConfig(raw: unknown): McpServerConfig {
  const record = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}
  const transport = typeof record.transport === 'string' ? record.transport : 'stdio'
  return {
    id: typeof record.id === 'string' ? record.id : '',
    transport,
    command: typeof record.command === 'string' ? record.command : '',
    args: stringArray(record.args),
    env: stringRecord(record.env),
    cwd: typeof record.cwd === 'string' && record.cwd.trim() !== '' ? record.cwd : null,
    url: typeof record.url === 'string' && record.url.trim() !== '' ? record.url : null,
    headers: stringRecord(record.headers),
    enabled: record.enabled !== false,
    disabledTools: stringArray(record.disabledTools),
    scope: record.scope === 'project' ? 'project' : 'user',
    ...(typeof record.workspaceId === 'string' ? { workspaceId: record.workspaceId } : {}),
    protocolVersion:
      typeof record.protocolVersion === 'string' && record.protocolVersion.trim() !== ''
        ? record.protocolVersion
        : '2024-11-05',
    callTimeoutMs:
      typeof record.callTimeoutMs === 'number' && Number.isFinite(record.callTimeoutMs)
        ? record.callTimeoutMs
        : null,
  }
}

/** Validate one server; returns a Chinese, field-naming error or null. */
export function validateServer(server: McpServerConfig): string | null {
  if (!isValidServerId(server.id)) {
    return `服务器 id '${server.id}' 不合法:必须小写字母开头,只含 a-z/0-9/-,长度 1-32`
  }
  if (!isSupportedTransport(server.transport)) {
    return `服务器 '${server.id}' 的 transport '${server.transport}' 不受支持;可用:${SUPPORTED_TRANSPORTS.join(' / ')}`
  }
  if (server.transport !== 'stdio') {
    if (!server.url || !isValidUrl(server.url)) {
      return `服务器 '${server.id}' 是 ${server.transport} 传输,url 必须是合法的 http/https 地址;当前是 '${server.url ?? ''}'`
    }
    if (server.command.trim() !== '') {
      return `服务器 '${server.id}' 是 ${server.transport} 传输,不接受 command/args/env;请改选 stdio 或清空这些字段`
    }
  } else if (server.command.trim() === '') {
    return `服务器 '${server.id}' 缺少 command`
  }
  if (server.args.length > MAX_ARGS) {
    return `服务器 '${server.id}' 的参数过多(最多 ${MAX_ARGS} 个)`
  }
  if (server.args.some((arg) => arg.trim() === '')) {
    return `服务器 '${server.id}' 的参数不能为空字符串`
  }
  if (Object.keys(server.env).some((key) => key.trim() === '')) {
    return `服务器 '${server.id}' 的环境变量名不能为空`
  }
  if (Object.keys(server.headers).some((key) => key.trim() === '')) {
    return `服务器 '${server.id}' 的请求头名不能为空`
  }
  if (server.cwd !== null && !isAbsolutePath(server.cwd)) {
    return `服务器 '${server.id}' 的 cwd 必须是绝对路径,当前是 '${server.cwd}'`
  }
  if (server.scope === 'project' && !server.workspaceId) {
    return `服务器 '${server.id}' 选了「项目」作用域却没指定 workspaceId`
  }
  if (server.callTimeoutMs !== null && server.callTimeoutMs !== undefined) {
    if (server.callTimeoutMs < 1 || server.callTimeoutMs > 600_000) {
      return `服务器 '${server.id}' 的 callTimeoutMs 必须在 1-600000 之间`
    }
  }
  return null
}

function isAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('\\\\')
}

/** Validate a whole `mcp` namespace value; throws with the first problem. */
export function validateMcpNamespace(value: unknown): { servers: McpServerConfig[] } {
  const record = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
  if (!Array.isArray(record.servers)) {
    if (record.servers !== undefined) throw new Error('mcp.servers 必须是数组')
    return { servers: [] }
  }
  if (record.servers.length > MAX_SERVERS) {
    throw new Error(`servers 最多 ${MAX_SERVERS} 条,当前 ${record.servers.length} 条`)
  }
  const servers: McpServerConfig[] = []
  const seen = new Set<string>()
  for (const raw of record.servers) {
    const server = normalizeServerConfig(raw)
    const error = validateServer(server)
    if (error) throw new Error(error)
    if (seen.has(server.id)) throw new Error(`服务器 id 重复:'${server.id}'`)
    seen.add(server.id)
    servers.push(server)
  }
  return { servers }
}

/**
 * Merge an edit over the stored config. With `preserveSecrets`, empty env /
 * header values keep the stored secret, and hidden fields stay untouched.
 */
export function mergeServerConfig(
  existing: McpServerConfig,
  incoming: McpServerConfig,
  preserveSecrets: boolean,
): McpServerConfig {
  if (!preserveSecrets) return incoming
  const env = { ...existing.env }
  for (const [key, value] of Object.entries(incoming.env)) {
    if (value !== '') env[key] = value
    else if (!(key in env)) env[key] = value
  }
  const headers = { ...existing.headers }
  for (const [key, value] of Object.entries(incoming.headers)) {
    if (value !== '') headers[key] = value
    else if (!(key in headers)) headers[key] = value
  }
  return {
    ...incoming,
    env,
    headers,
    scope: existing.scope,
    workspaceId: existing.workspaceId ?? null,
    protocolVersion: existing.protocolVersion,
    callTimeoutMs: existing.callTimeoutMs,
  }
}