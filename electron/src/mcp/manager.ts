// MCP server pool: configs → connections → tool catalog → tool calls.
//
// The pool exposes an immutable snapshot, so the tool surface stays coherent
// for a whole step. Reloads are incremental: a server reconnects only when its
// connection key changes. One broken server never takes the others down.

import { McpClient } from './client.ts'
import type { McpServerConfig } from './config.ts'
import { connectionKey, qualifyToolName } from './config.ts'
import type { McpCallResult, McpToolDef } from './protocol.ts'

export type McpServerStatus = 'connected' | 'disabled' | 'error'

export interface McpToolState {
  name: string
  qualified: string
  description: string
  enabled: boolean
  disabledReason?: string
}

export interface McpServerState {
  id: string
  transport: string
  command: string
  args: string[]
  url: string | null
  envKeys: string[]
  headerKeys: string[]
  cwd: string | null
  enabled: boolean
  status: McpServerStatus
  error?: string
  tools: McpToolState[]
}

export interface McpToolDefView {
  name: string
  description: string
  schema: unknown
}

interface ConnectedServer {
  client: McpClient
  tools: McpToolDef[]
  fingerprint: string
}

export class McpSnapshot {
  readonly servers: McpServerState[]
  private readonly routes = new Map<string, [string, string]>()
  private readonly schemas = new Map<string, unknown>()
  private readonly descriptions = new Map<string, string>()

  constructor(
    servers: McpServerState[],
    routes: Map<string, [string, string]>,
    schemas: Map<string, unknown>,
    descriptions: Map<string, string>,
  ) {
    this.servers = servers
    this.routes = routes
    this.schemas = schemas
    this.descriptions = descriptions
  }

  static empty(): McpSnapshot {
    return new McpSnapshot([], new Map(), new Map(), new Map())
  }

  toolNames(): string[] {
    return [...this.routes.keys()].sort()
  }

  toolDefs(): McpToolDefView[] {
    return this.toolNames().map((name) => ({
      name,
      description: this.descriptions.get(name) ?? '',
      schema: this.schemas.get(name) ?? { type: 'object' },
    }))
  }

  schemaOf(name: string): unknown {
    return this.schemas.get(name)
  }

  descriptionOf(name: string): string {
    return this.descriptions.get(name) ?? ''
  }

  route(name: string): [string, string] | undefined {
    return this.routes.get(name)
  }

  hasConnected(): boolean {
    return this.servers.some((server) => server.enabled && server.status === 'connected')
  }
}

/** Result identity / pagination failures. Never silently re-run a tool. */
export type PagedFailureKind = 'unknown-result' | 'foreign-session' | 'lost-result' | 'call'

export class PagedFailure extends Error {
  readonly kind: PagedFailureKind

  constructor(kind: PagedFailureKind, message: string) {
    super(message)
    this.kind = kind
  }
}

export interface PageCall {
  qualified: string
  arguments: Record<string, unknown>
  offset: number
  limit: number
  resultId?: string
  legacyResume: boolean
  session?: string
}

export interface PagedResult {
  text: string
  isError: boolean
  totalChars: number
  offset: number
  shownChars: number
  hasMore: boolean
  fromCache: boolean
  uncached: boolean
  resultId: string | null
}

/** Characters per page and per call; independent of transport framing. */
export const PAGE_CHARS = 8_000
export const MAX_PAGE_CHARS = 32_000
export const MAX_CACHED_CHARS = 1_048_576
const MAX_CACHE_ENTRIES = 256

interface CachedResult {
  session: string | null
  tool: string
  arguments: string
  text: string
  isError: boolean
  seq: number
}

/** Stable JSON for legacy offset resume matching (object keys sorted). */
function argumentsKey(value: unknown): string {
  const canonical = (node: unknown): string => {
    if (Array.isArray(node)) return `[${node.map(canonical).join(',')}]`
    if (typeof node === 'object' && node !== null) {
      const entries = Object.entries(node as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
    }
    return JSON.stringify(node) ?? 'null'
  }
  return canonical(value)
}

export class McpManager {
  private readonly builtinNames: Set<string>
  private connected = new Map<string, ConnectedServer>()
  private current = McpSnapshot.empty()
  private reloadChain: Promise<void> = Promise.resolve()
  private readonly results = new Map<string, CachedResult>()
  private nextCacheSeq = 0
  private nextCacheId = 0

  constructor(builtinNames: Iterable<string> = []) {
    this.builtinNames = new Set(builtinNames)
  }

  snapshot(): McpSnapshot {
    return this.current
  }

  /** Rebuild connections and the snapshot. Serialized; failures are isolated. */
  reload(configs: McpServerConfig[]): Promise<void> {
    this.reloadChain = this.reloadChain.then(async () => {
      const desired = new Map(configs.map((config) => [config.id, config]))
      for (const [id, entry] of [...this.connected]) {
        const config = desired.get(id)
        if (!config || !config.enabled || entry.fingerprint !== connectionKey(config)) {
          this.connected.delete(id)
          await entry.client.shutdown()
        }
      }
      const states: McpServerState[] = []
      const schemaSource = new Map<string, unknown>()
      this.results.clear()
      for (const config of configs) {
        if (!config.enabled) {
          states.push(disabledState(config))
          continue
        }
        let entry = this.connected.get(config.id)
        if (!entry) {
          try {
            const client = await McpClient.connect(config)
            const tools = await client.listTools()
            entry = { client, tools, fingerprint: connectionKey(config) }
            this.connected.set(config.id, entry)
          } catch (error) {
            states.push(errorState(config, error instanceof Error ? error.message : String(error)))
            continue
          }
        }
        states.push(connectedState(config, entry, this.builtinNames))
        for (const tool of entry.tools) {
          schemaSource.set(qualifyToolName(config.id, tool.name), tool.inputSchema)
        }
      }
      dedupeQualifiedNames(states)
      this.current = buildSnapshot(states, schemaSource, this.builtinNames)
    })
    return this.reloadChain
  }

  async call(qualified: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const route = this.current.route(qualified)
    if (!route) throw new Error(`unknown tool: ${qualified}`)
    const [server, tool] = route
    const entry = this.connected.get(server)
    if (!entry) {
      throw new Error(
        `MCP 服务器 ${server} 当前未连接;到设置 → MCP 检查该服务器状态,或点"重新连接"后重试`,
      )
    }
    return entry.client.callTool(tool, args)
  }

  /**
   * One paginated call:
   * - a token resumes that exact result without re-running the tool;
   * - a legacy `offset > 0` without a token only resumes a uniquely matching
   *   cached result, otherwise fails instead of re-executing;
   * - no token = a new call = real execution.
   */
  async callPaged(call: PageCall): Promise<PagedResult> {
    if (call.resultId) {
      const cached = this.resumeCached(call.resultId, call.qualified, call.session)
      return pageOf(cached.text, cached.isError, call, true, call.resultId)
    }
    if (call.legacyResume) {
      const found = this.latestCached(call.qualified, argumentsKey(call.arguments), call.session)
      if (!found) {
        throw new PagedFailure(
          'lost-result',
          '无法翻页:没有可续读的结果(用 offset>0 续读时,原结果必须还在缓存里)',
        )
      }
      return pageOf(found.text, found.isError, call, true, found.id)
    }
    const result = await this.call(call.qualified, call.arguments).catch((error: unknown) => {
      throw new PagedFailure('call', error instanceof Error ? error.message : String(error))
    })
    const resultId = this.storeCached(call.qualified, call.arguments, call.session, result)
    return pageOf(result.text, result.isError, call, false, resultId)
  }

  private resumeCached(
    resultId: string,
    qualified: string,
    session?: string,
  ): { text: string; isError: boolean } {
    const entry = this.results.get(resultId)
    if (!entry || entry.tool !== qualified) {
      throw new PagedFailure(
        'unknown-result',
        `无法续读结果:${resultId} 已不存在(服务器重连或缓存已淘汰)`,
      )
    }
    if ((entry.session ?? null) !== (session ?? null)) {
      throw new PagedFailure('foreign-session', `无法续读结果:${resultId} 属于另一个会话`)
    }
    this.nextCacheSeq += 1
    entry.seq = this.nextCacheSeq
    return { text: entry.text, isError: entry.isError }
  }

  private latestCached(
    qualified: string,
    argumentsText: string,
    session?: string,
  ): { id: string; text: string; isError: boolean } | null {
    let best: { id: string; entry: CachedResult } | null = null
    for (const [id, entry] of this.results) {
      if (entry.tool !== qualified) continue
      if (entry.arguments !== argumentsText) continue
      if ((entry.session ?? null) !== (session ?? null)) continue
      if (!best || entry.seq > best.entry.seq) best = { id, entry }
    }
    return best ? { id: best.id, text: best.entry.text, isError: best.entry.isError } : null
  }

  private storeCached(
    qualified: string,
    args: Record<string, unknown>,
    session: string | undefined,
    result: McpCallResult,
  ): string | null {
    const total = Array.from(result.text).length
    if (result.text === '' || total > MAX_CACHED_CHARS) return null
    if (this.results.size >= MAX_CACHE_ENTRIES) {
      let oldest: string | null = null
      let oldestSeq = Number.POSITIVE_INFINITY
      for (const [id, entry] of this.results) {
        if (entry.seq < oldestSeq) {
          oldestSeq = entry.seq
          oldest = id
        }
      }
      if (oldest) this.results.delete(oldest)
    }
    this.nextCacheId += 1
    this.nextCacheSeq += 1
    const id = `res-${process.pid}-${this.nextCacheId}`
    this.results.set(id, {
      session: session ?? null,
      tool: qualified,
      arguments: argumentsKey(args),
      text: result.text,
      isError: result.isError,
      seq: this.nextCacheSeq,
    })
    return id
  }

  async disconnect(id: string): Promise<void> {
    const entry = this.connected.get(id)
    if (!entry) return
    this.connected.delete(id)
    await entry.client.shutdown()
    this.results.clear()
  }

  async shutdownAll(): Promise<void> {
    for (const entry of this.connected.values()) {
      await entry.client.shutdown()
    }
    this.connected.clear()
    this.results.clear()
    this.current = McpSnapshot.empty()
  }
}

function pageOf(
  text: string,
  isError: boolean,
  call: PageCall,
  fromCache: boolean,
  resultId: string | null,
): PagedResult {
  const limit = Math.max(1, Math.min(MAX_PAGE_CHARS, call.limit))
  const chars = Array.from(text)
  const totalChars = chars.length
  const start = Math.min(call.offset, totalChars)
  const page = chars.slice(start, start + limit).join('')
  const shownChars = Array.from(page).length
  return {
    text: page,
    isError,
    totalChars,
    offset: start,
    shownChars,
    hasMore: start + shownChars < totalChars,
    fromCache,
    uncached: totalChars > MAX_CACHED_CHARS,
    resultId,
  }
}

function connectedState(
  config: McpServerConfig,
  entry: ConnectedServer,
  builtinNames: Set<string>,
): McpServerState {
  const disabled = new Set(config.disabledTools)
  const tools = entry.tools.map((tool) => {
    const qualified = qualifyToolName(config.id, tool.name)
    let disabledReason: string | undefined
    if (builtinNames.has(qualified)) {
      disabledReason = `与内置工具 ${qualified} 同名,已跳过以免覆盖内置能力`
    } else if (disabled.has(tool.name)) {
      disabledReason = '已在设置中关闭'
    }
    return {
      name: tool.name,
      qualified,
      description: tool.description,
      enabled: disabledReason === undefined,
      ...(disabledReason ? { disabledReason } : {}),
    }
  })
  return {
    id: config.id,
    transport: config.transport,
    command: config.command,
    args: config.args,
    url: config.url,
    envKeys: Object.keys(config.env),
    headerKeys: Object.keys(config.headers),
    cwd: config.cwd,
    enabled: true,
    status: 'connected',
    tools,
  }
}

/** Two servers may fold different raw names onto the same model-visible name. */
function dedupeQualifiedNames(states: McpServerState[]): void {
  const seen = new Set<string>()
  for (const state of states) {
    if (!state.enabled || state.status !== 'connected') continue
    for (const tool of state.tools) {
      if (!tool.enabled) continue
      if (seen.has(tool.qualified)) {
        tool.enabled = false
        tool.disabledReason = `与另一个 MCP 工具同名(${tool.qualified})，已跳过`
        continue
      }
      seen.add(tool.qualified)
    }
  }
}

function disabledState(config: McpServerConfig): McpServerState {
  return {
    id: config.id,
    transport: config.transport,
    command: config.command,
    args: config.args,
    url: config.url,
    envKeys: Object.keys(config.env),
    headerKeys: Object.keys(config.headers),
    cwd: config.cwd,
    enabled: false,
    status: 'disabled',
    tools: [],
  }
}

function errorState(config: McpServerConfig, error: string): McpServerState {
  return {
    id: config.id,
    transport: config.transport,
    command: config.command,
    args: config.args,
    url: config.url,
    envKeys: Object.keys(config.env),
    headerKeys: Object.keys(config.headers),
    cwd: config.cwd,
    enabled: true,
    status: 'error',
    error,
    tools: [],
  }
}

function buildSnapshot(
  states: McpServerState[],
  schemas: Map<string, unknown>,
  builtinNames: Set<string>,
): McpSnapshot {
  const routes = new Map<string, [string, string]>()
  const descriptions = new Map<string, string>()
  const toolSchemas = new Map<string, unknown>()
  for (const state of states) {
    if (!state.enabled || state.status !== 'connected') continue
    for (const tool of state.tools) {
      if (!tool.enabled || builtinNames.has(tool.qualified)) continue
      routes.set(tool.qualified, [state.id, tool.name])
      descriptions.set(tool.qualified, tool.description)
      toolSchemas.set(tool.qualified, schemas.get(tool.qualified) ?? { type: 'object' })
    }
  }
  return new McpSnapshot(states, routes, toolSchemas, descriptions)
}

/** Catalog text rendered for the `mcp_list` tool. */
export function renderToolCatalog(
  servers: McpServerState[],
  only: string | undefined,
  granted: string[] | null,
): string {
  const allowed = (qualified: string): boolean =>
    granted === null || granted.includes(qualified)
  const visible = servers.filter(
    (server) =>
      server.enabled &&
      server.status === 'connected' &&
      (only === undefined || server.id === only) &&
      server.tools.some((tool) => tool.enabled && allowed(tool.qualified)),
  )
  if (visible.length === 0) {
    if (granted !== null) {
      return only
        ? `当前会话没有被授予服务器 ${only} 的任何 MCP 工具；需要外部能力请让父代理用授予了对应工具的定义重新派遣。`
        : '当前会话没有被授予任何 MCP 外部工具；需要外部能力请让父代理用授予了 MCP 工具的定义重新派遣。'
    }
    return only
      ? `没有名为 ${only} 的已连接 MCP 服务器;不带 server 参数再调一次可查看全部。`
      : '当前没有已连接的 MCP 服务器;可到设置 → MCP 检查服务器状态或重新连接。'
  }
  const lines = ['已接入的 MCP 外部工具(按名称直接调用;首次调用只返回参数定义,不会执行):']
  for (const server of visible) {
    lines.push('', `[服务器 ${server.id}]`)
    for (const tool of server.tools) {
      if (!tool.enabled || !allowed(tool.qualified)) continue
      const description = tool.description.trim() || '(无描述)'
      lines.push(`- ${tool.qualified} — ${description}`)
    }
  }
  return lines.join('\n')
}