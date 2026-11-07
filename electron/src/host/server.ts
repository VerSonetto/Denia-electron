// The HTTP/SSE host. It reproduces the wire contract the existing web UI
// already speaks, so the renderer is reused unchanged:
//   - `/api/sessions/*` + `/api/events` (SSE) for the conversation surface
//   - `/api/llm/*`, `/api/settings`, `/api/agent-presets` for model selection
//   - static files from `web/dist` (same origin keeps relative `/api` working)
//
// The first milestone intentionally implements only the conversation path and
// the few reads the UI needs at startup. Endpoints outside that surface
// answer 501 with a clear code instead of pretending to work.

import fs from 'node:fs'
import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { SessionDriver } from '../agent/loop.ts'
import { buildSystemPrompt } from '../agent/system-prompt.ts'
import type { AppConfig } from '../config.ts'
import {
  credentialInfo,
  loadConfig,
  loadCredentialRefs,
  loadSettings,
  resolveHome,
  saveSettingsNamespace,
  setCredential,
  settingsDescribe,
  unsetCredential,
  workspacesPath,
} from '../config.ts'
import type { Envelope, ImageData, ModelSelection, SessionEvent } from '../core/wire.ts'
import { errorMessage, isRecord } from '../core/util.ts'
import { SessionStore } from '../session/store.ts'
import { ToolRegistry } from '../tools/index.ts'

const HEARTBEAT_MS = 15_000
const POLL_MAX_SEC = 30
const POLL_DEFAULT_SEC = 25
const RING_LIMIT = 128

export interface HostOptions {
  home?: string
  webDir?: string
  host?: string
  port?: number
}

export interface Host {
  server: http.Server
  home: string
  port: number
  baseUrl: string
  store: SessionStore
  driver: SessionDriver
  close(): Promise<void>
}

interface WorkspaceRecord {
  id: string
  path: string
  title: string
  createdAt: number
  sessionIds: string[]
}

interface GlobalEventEntry {
  seq: number
  event: { type: string; [key: string]: unknown }
}

interface WorkspaceFile {
  initialized: boolean
  order: string[]
  workspaces: Record<string, WorkspaceRecord>
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function apiError(res: ServerResponse, status: number, code: string, message: string): void {
  json(res, status, { error: { code, message } })
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > 64 * 1024 * 1024) throw new Error('请求体超过 64MB 上限')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  const parsed = JSON.parse(text) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('请求体必须是 JSON 对象')
  }
  return parsed as Record<string, unknown>
}

function queryNumber(url: URL, key: string): number | undefined {
  const raw = url.searchParams.get(key)
  if (raw === null || raw === '') return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

function sseHeaders(): Record<string, string> {
  return {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  }
}

function writeSse(res: ServerResponse, payload: unknown): void {
  if (res.writableEnded || res.destroyed) return
  try {
    res.write(`data: ${JSON.stringify(payload)}\n\n`)
  } catch {
    /* client went away; close handler cleans up */
  }
}

function mimeOf(file: string): string {
  const ext = path.extname(file).toLowerCase()
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8'
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8'
    case '.css':
      return 'text/css; charset=utf-8'
    case '.json':
    case '.map':
      return 'application/json; charset=utf-8'
    case '.svg':
      return 'image/svg+xml'
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    case '.ico':
      return 'image/x-icon'
    case '.woff':
      return 'font/woff'
    case '.woff2':
      return 'font/woff2'
    case '.ttf':
      return 'font/ttf'
    case '.wasm':
      return 'application/wasm'
    case '.txt':
    case '.md':
      return 'text/plain; charset=utf-8'
    case '.gz':
      return 'application/gzip'
    case '.br':
      return 'application/octet-stream'
    default:
      return 'application/octet-stream'
  }
}

export async function startHost(options: HostOptions = {}): Promise<Host> {
  const home = options.home ?? resolveHome()
  fs.mkdirSync(home, { recursive: true })
  const webDir = options.webDir ?? path.resolve(import.meta.dirname, '..', '..', '..', 'web', 'dist')

  let config = loadConfig(home)
  const store = new SessionStore(home)
  const registry = ToolRegistry.builtin()
  const workspaces = loadWorkspaces(home)
  const defaultPermissionMode = consolePermissionMode(home)

  // —— global push ring + SSE clients ——
  const sseClients = new Set<ServerResponse>()
  const ring: GlobalEventEntry[] = []
  let ringSeq = 0
  const heartbeatTimer = setInterval(() => {
    for (const client of sseClients) writeSse(client, { type: 'hb' })
  }, HEARTBEAT_MS)
  heartbeatTimer.unref?.()

  const broadcast = (event: { type: string; [key: string]: unknown }): void => {
    ringSeq += 1
    ring.push({ seq: ringSeq, event })
    if (ring.length > RING_LIMIT) ring.splice(0, ring.length - RING_LIMIT)
    for (const client of sseClients) writeSse(client, event)
  }

  const driver = new SessionDriver(
    store,
    registry,
    () => config,
    undefined,
    (sessionId, running) => {
      broadcast({ type: 'running-snapshot', ids: runningSessionIds() })
      void sessionId
      void running
    },
  )

  const runningSessionIds = (): string[] => driver.runningIds()

  const saveWorkspaces = (): void => {
    fs.writeFileSync(workspacesPath(home), JSON.stringify(workspaces, null, 2) + '\n', 'utf8')
  }

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = safeDecode(url.pathname)
    try {
      if (!pathname.startsWith('/api/')) {
        serveStatic(res, webDir, pathname)
        return
      }
      await handleApi(req, res, pathname, url)
    } catch (error) {
      if (!res.headersSent) apiError(res, 500, 'internal', errorMessage(error))
      else if (!res.writableEnded) res.end()
    }
  }

  const handleApi = async (
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    url: URL,
  ): Promise<void> => {
    const method = req.method ?? 'GET'

    // —— sessions ——
    if (pathname === '/api/sessions') {
      if (method === 'GET') {
        json(res, 200, { sessions: store.list() })
        return
      }
      if (method === 'POST') {
        const body = await readJson(req)
        const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : undefined
        let cwd = typeof body.cwd === 'string' ? body.cwd.trim() : ''
        if (workspaceId) {
          const workspace = workspaces.workspaces[workspaceId]
          if (!workspace) {
            apiError(res, 404, 'workspace/not-found', 'workspace not found')
            return
          }
          cwd = workspace.path
        }
        if (!cwd) {
          apiError(res, 400, 'session/workspace-required', '先选择工作区,再开始会话')
          return
        }
        if (!isDirectory(cwd)) {
          apiError(res, 400, 'session/bad-cwd', `'${cwd}' 不是目录`)
          return
        }
        const preset = typeof body.agentPreset === 'string' && body.agentPreset.trim()
          ? body.agentPreset.trim()
          : 'standard'
        const header = store.create(cwd, { sandbox: true })
        store.append(header.id, { type: 'permission-mode', mode: defaultPermissionMode })
        store.append(header.id, { type: 'agent-preset', preset })
        if (workspaceId) {
          const workspace = workspaces.workspaces[workspaceId]
          if (workspace) {
            workspace.sessionIds = [header.id, ...workspace.sessionIds.filter((id) => id !== header.id)]
            saveWorkspaces()
          }
        }
        broadcast({ type: 'sessions-updated' })
        json(res, 201, {
          session: {
            id: header.id,
            created_at: header.created_at,
            excerpt: null,
            cwd: header.cwd,
            sandbox: header.sandbox,
            agent_preset: preset,
          },
        })
        return
      }
    }

    const sessionMatch = /^\/api\/sessions\/([^/]+)(\/.*)?$/.exec(pathname)
    if (sessionMatch) {
      const sessionId = sessionMatch[1]!
      const rest = sessionMatch[2] ?? ''
      if (!store.header(sessionId)) {
        apiError(res, 404, 'session/not-found', 'session not found')
        return
      }
      if (rest === '' && method === 'GET') {
        const session = store.read(sessionId)
        if (!session) {
          apiError(res, 404, 'session/not-found', 'session not found')
          return
        }
        json(res, 200, session)
        return
      }
      if (rest === '' && method === 'DELETE') {
        if (driver.isRunning(sessionId)) {
          apiError(res, 409, 'session/running', 'cancel the running turn before deleting')
          return
        }
        store.flush(sessionId)
        store.delete(sessionId)
        for (const workspace of Object.values(workspaces.workspaces)) {
          workspace.sessionIds = workspace.sessionIds.filter((id) => id !== sessionId)
        }
        saveWorkspaces()
        broadcast({ type: 'sessions-updated' })
        json(res, 200, { ok: true })
        return
      }
      if (rest === '/events' && method === 'GET') {
        const before = queryNumber(url, 'before')
        const limit = queryNumber(url, 'limit') ?? 500
        const page = store.readPage(sessionId, before, Math.max(1, Math.min(2000, Math.floor(limit))))
        if (!page) {
          apiError(res, 404, 'session/not-found', 'session not found')
          return
        }
        json(res, 200, page)
        return
      }
      if (rest === '/prompt' && method === 'POST') {
        if (driver.isRunning(sessionId)) {
          apiError(res, 409, 'session/running', '上一轮还在运行,请先等待或取消')
          return
        }
        const body = await readJson(req)
        const prompt = typeof body.prompt === 'string' ? body.prompt : ''
        if (prompt.trim() === '') {
          apiError(res, 400, 'prompt/empty', '消息不能为空')
          return
        }
        const selection: ModelSelection | undefined =
          typeof body.provider === 'string' && typeof body.model === 'string'
            ? {
                provider: body.provider,
                model: body.model,
                ...(typeof body.reasoningEffort === 'string'
                  ? { reasoningEffort: body.reasoningEffort }
                  : {}),
              }
            : undefined
        const images = parseImages(body.images)
        void driver.startTurn(sessionId, prompt, {
          ...(selection ? { selection } : {}),
          ...(images.length > 0 ? { images } : {}),
          ...(typeof body.source === 'string' ? { source: body.source } : {}),
        })
        broadcast({ type: 'running-snapshot', ids: runningSessionIds() })
        json(res, 202, { accepted: true })
        return
      }
      if (rest === '/steer' && method === 'POST') {
        if (!driver.isRunning(sessionId)) {
          apiError(res, 409, 'session/not-running', '当前没有可引导的轮次')
          return
        }
        const body = await readJson(req)
        if (typeof body.prompt === 'string' && body.prompt.trim() !== '') {
          store.append(sessionId, { type: 'user-message', text: body.prompt, injected: false })
        }
        json(res, 202, { accepted: true })
        return
      }
      if (rest === '/cancel' && method === 'POST') {
        driver.cancel(sessionId)
        json(res, 200, { ok: true })
        return
      }
      if (rest === '/permission' && method === 'PUT') {
        const body = await readJson(req)
        const mode = body.mode
        if (mode !== 'read-only' && mode !== 'auto-edit' && mode !== 'plan' && mode !== 'full') {
          apiError(res, 400, 'permission/bad-mode', '未知权限档位')
          return
        }
        store.append(sessionId, { type: 'permission-mode', mode })
        json(res, 200, { mode })
        return
      }
      if (rest === '/agent-preset' && method === 'PUT') {
        const body = await readJson(req)
        const preset = typeof body.preset === 'string' ? body.preset : 'standard'
        store.append(sessionId, { type: 'agent-preset', preset })
        json(res, 200, { preset })
        return
      }
      if (rest.startsWith('/approvals/') && method === 'POST') {
        json(res, 200, { outcome: 'unavailable' })
        return
      }
      if (rest.startsWith('/asks/') && method === 'POST') {
        json(res, 200, { ok: true })
        return
      }
      if (rest === '/follow' && method === 'GET') {
        followSse(req, res, sessionId)
        return
      }
      if (rest === '/follow/poll' && method === 'GET') {
        await followPoll(res, sessionId, url)
        return
      }
      if (rest === '/goal' && method === 'GET') {
        json(res, 200, {
          goal: null,
          tokensUsed: 0,
          maxRounds: 0,
          maxGoalTokenBudget: 0,
        })
        return
      }
      if (rest === '/compact' && method === 'POST') {
        json(res, 202, { accepted: false })
        return
      }
      if (rest === '/context-breakdown' && method === 'GET') {
        json(res, 200, {
          breakdown: { systemTokens: 0, toolsTokens: 0, messageTokens: 0 },
          pressure: {},
          usage: {
            uncachedInputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
          },
        })
        return
      }
      if (rest === '/checkpoints' && method === 'GET') {
        json(res, 200, { checkpoints: [] })
        return
      }
      if (rest === '/skills' && method === 'GET') {
        json(res, 200, { skills: [] })
        return
      }
      if (rest === '/agents' && method === 'GET') {
        json(res, 200, { agents: [] })
        return
      }
      if (rest === '/jobs' && method === 'GET') {
        json(res, 200, { jobs: [] })
        return
      }
      notImplemented(res, pathname)
      return
    }

    // —— global events ——
    if (pathname === '/api/events' && method === 'GET') {
      res.writeHead(200, sseHeaders())
      res.write('retry: 1000\n\n')
      sseClients.add(res)
      writeSse(res, { type: 'running-snapshot', ids: runningSessionIds() })
      req.on('close', () => {
        sseClients.delete(res)
      })
      return
    }
    if (pathname === '/api/events/poll' && method === 'GET') {
      const after = queryNumber(url, 'after') ?? 0
      const waitSec = Math.max(0, Math.min(POLL_MAX_SEC, queryNumber(url, 'wait') ?? POLL_DEFAULT_SEC))
      const deadline = Date.now() + waitSec * 1000
      while (true) {
        const pending = ring.filter((entry) => entry.seq > after).slice(0, 64)
        if (pending.length > 0 || Date.now() >= deadline) {
          json(res, 200, {
            events: pending.map((entry) => entry.event),
            seq: pending.length > 0 ? pending[pending.length - 1]!.seq : after,
            resync: false,
            running: runningSessionIds(),
          })
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }

    // —— workspaces ——
    if (pathname === '/api/workspaces') {
      if (method === 'GET') {
        json(res, 200, { workspaces: workspaceList(workspaces) })
        return
      }
      if (method === 'POST') {
        const body = await readJson(req)
        const dir = typeof body.path === 'string' ? body.path.trim() : ''
        if (!dir || !isDirectory(dir)) {
          apiError(res, 400, 'workspace/bad-path', '工作区路径不是目录')
          return
        }
        const record: WorkspaceRecord = {
          id: randomUUID(),
          path: dir,
          title: typeof body.title === 'string' && body.title.trim() ? body.title.trim() : path.basename(dir),
          createdAt: Date.now(),
          sessionIds: [],
        }
        workspaces.workspaces[record.id] = record
        workspaces.order = [record.id, ...workspaces.order.filter((id) => id !== record.id)]
        saveWorkspaces()
        broadcast({ type: 'sessions-updated' })
        json(res, 201, { workspace: record })
        return
      }
    }
    const workspaceMatch = /^\/api\/workspaces\/([^/]+)$/.exec(pathname)
    if (workspaceMatch && method === 'DELETE') {
      const id = workspaceMatch[1]!
      delete workspaces.workspaces[id]
      workspaces.order = workspaces.order.filter((entry) => entry !== id)
      saveWorkspaces()
      broadcast({ type: 'sessions-updated' })
      json(res, 200, { ok: true })
      return
    }

    // —— models ——
    if (pathname === '/api/llm/providers' && method === 'GET') {
      json(res, 200, {
        providers: config.providers.map((provider) => ({ id: provider.id, name: provider.name })),
        configurable: [],
      })
      return
    }
    if (pathname === '/api/llm/catalog' && method === 'GET') {
      json(res, 200, {
        routableProviders: config.providers.map((provider) => provider.id),
        groups: config.providers.map((provider) => ({
          id: provider.id,
          name: provider.name,
          models: provider.models.map((model) => ({
            id: model.id,
            name: model.name ?? model.id,
            ...(model.description ? { description: model.description } : {}),
            ...(model.contextWindow ?? provider.defaultContextWindow
              ? { contextWindow: model.contextWindow ?? provider.defaultContextWindow }
              : {}),
            ...(model.inputModalities ? { inputModalities: model.inputModalities } : {}),
            ...(model.thinkingSupported ? { thinkingSupported: model.thinkingSupported } : {}),
            ...(model.reasoningEfforts
              ? {
                  reasoning: {
                    efforts: model.reasoningEfforts.map((effort) => ({ id: effort, name: effort })),
                    defaultEffort: model.reasoningEfforts[0],
                  },
                }
              : {}),
          })),
        })),
        failures: [],
      })
      return
    }
    if (pathname === '/api/llm/discover' && method === 'POST') {
      const body = await readJson(req)
      const baseURL = typeof body.baseURL === 'string' ? body.baseURL.trim() : ''
      if (!baseURL) {
        apiError(res, 400, 'llm/bad-base-url', 'baseURL 不能为空')
        return
      }
      try {
        const headers: Record<string, string> = { accept: 'application/json' }
        let key = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
        if (!key && typeof body.apiKeyEnv === 'string' && body.apiKeyEnv.trim()) {
          const ref = body.apiKeyEnv.trim()
          key = process.env[ref]?.trim() || loadCredentialRefs(home)[ref]?.trim() || ''
        }
        if (key) headers.authorization = `Bearer ${key}`
        const response = await fetch(`${baseURL.replace(/\/+$/, '')}/models`, { headers })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const payload = (await response.json()) as { data?: { id?: string }[] }
        const models = (payload.data ?? [])
          .map((entry) => entry.id)
          .filter((id): id is string => typeof id === 'string')
          .map((id) => ({ id, name: id }))
        json(res, 200, { models })
      } catch (error) {
        apiError(res, 502, 'llm/discover-failed', errorMessage(error))
      }
      return
    }

    // —— settings / credentials ——
    if (pathname === '/api/settings' && method === 'GET') {
      json(res, 200, settingsDescribe(home, config))
      return
    }
    const settingsMatch = /^\/api\/settings\/(.+)$/.exec(pathname)
    if (settingsMatch && (method === 'PATCH' || method === 'PUT')) {
      const ns = safeDecode(settingsMatch[1]!)
      const body = await readJson(req)
      saveSettingsNamespace(home, ns, body.value)
      config = loadConfig(home)
      broadcast({ type: 'settings-updated' })
      json(res, 200, { revision: 1, applies: 'restart' })
      return
    }
    if (pathname === '/api/credentials' && method === 'GET') {
      const refs = (url.searchParams.get('refs') ?? '')
        .split(',')
        .map((ref) => ref.trim())
        .filter(Boolean)
      json(res, 200, { credentials: credentialInfo(home, refs) })
      return
    }
    if (pathname.startsWith('/api/credentials/') && (method === 'PUT' || method === 'DELETE')) {
      const ref = safeDecode(pathname.slice('/api/credentials/'.length))
      try {
        if (method === 'PUT') {
          const body = await readJson(req)
          if (typeof body.value !== 'string') {
            apiError(res, 400, 'credential/invalid-value', 'value 必须是字符串')
            return
          }
          setCredential(home, ref, body.value)
        } else {
          unsetCredential(home, ref)
        }
        broadcast({ type: 'credentials-updated' })
        json(res, 200, { ok: true, credentials: credentialInfo(home, [ref]) })
      } catch (error) {
        apiError(res, 400, 'credential/invalid', errorMessage(error))
      }
      return
    }

    // —— agent presets ——
    if (pathname === '/api/agent-presets' && method === 'GET') {
      json(res, 200, {
        default: 'standard',
        modeSelection: true,
        root: path.join(home, 'agent-presets'),
        tools: registry.names().sort(),
        presets: builtinPresetRows(),
      })
      return
    }
    const presetMatch = /^\/api\/agent-presets\/([^/]+)$/.exec(pathname)
    if (presetMatch && method === 'GET') {
      const id = safeDecode(presetMatch[1]!)
      const preset = builtinPresetRows().find((entry) => entry.id === id)
      if (!preset) {
        apiError(res, 404, 'preset/not-found', 'preset not found')
        return
      }
      json(res, 200, { preset, text: '', spec: null })
      return
    }
    if (pathname.startsWith('/api/agent-presets') && method !== 'GET') {
      notImplemented(res, pathname)
      return
    }

    // —— filesystem ——
    if (pathname === '/api/fs/capability' && method === 'GET') {
      json(res, 200, { kind: 'browse', remote: false })
      return
    }
    if (pathname === '/api/fs/dirs' && method === 'GET') {
      const target = url.searchParams.get('path')
      json(res, 200, listDirectories(target))
      return
    }
    if (pathname === '/api/fs/pick' && method === 'POST') {
      json(res, 200, { path: null })
      return
    }
    if (pathname === '/api/fs/pick-files' && method === 'POST') {
      json(res, 200, { paths: [] })
      return
    }
    if (pathname === '/api/fs/mkdir' && method === 'POST') {
      const body = await readJson(req)
      const dir = typeof body.path === 'string' ? body.path : ''
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (!dir || !name) {
        apiError(res, 400, 'fs/bad-request', 'path 与 name 都必填')
        return
      }
      const created = path.join(dir, name)
      fs.mkdirSync(created, { recursive: true })
      json(res, 200, { path: created })
      return
    }
    if (pathname === '/api/fs/mentions' && method === 'GET') {
      const root = url.searchParams.get('path') ?? ''
      const query = url.searchParams.get('query') ?? ''
      json(res, 200, { items: listMentions(root, query) })
      return
    }
    if (pathname === '/api/fs/tree' && method === 'GET') {
      const root = url.searchParams.get('path') ?? ''
      const dir = url.searchParams.get('dir') ?? ''
      jsonOrError(res, () => treeListing(root, dir))
      return
    }
    if (pathname === '/api/fs/file' && method === 'GET') {
      const root = url.searchParams.get('path') ?? ''
      const file = url.searchParams.get('file') ?? ''
      jsonOrError(res, () => workspaceFile(root, file))
      return
    }
    if (pathname.startsWith('/api/fs/preview/')) {
      apiError(res, 404, 'fs/not-found', 'not found')
      return
    }

    // —— system prompt / rules ——
    if (pathname === '/api/system-prompt' && method === 'GET') {
      json(res, 200, {
        text: buildSystemPrompt({ cwd: process.cwd(), sandbox: true, tools: registry.schemas() }),
        source: 'default',
        path: '',
      })
      return
    }
    if (pathname === '/api/global-rules' && method === 'GET') {
      json(res, 200, { text: '', source: 'default', displayPath: '', path: '' })
      return
    }

    // —— small reads the UI may open ——
    if (pathname === '/api/mcp' && method === 'GET') {
      json(res, 200, { servers: [], toolCount: 0 })
      return
    }
    if (pathname === '/api/subagent-profiles' && method === 'GET') {
      json(res, 200, emptySubagentCatalog())
      return
    }
    if (pathname === '/api/subagent-tools' && method === 'GET') {
      json(res, 200, { registered: registry.names().length, tools: [] })
      return
    }
    if (pathname === '/api/memories/projects' && method === 'GET') {
      json(res, 200, { projects: [] })
      return
    }
    if (pathname === '/api/open-in-app/apps' && method === 'GET') {
      json(res, 200, { apps: [] })
      return
    }
    if (pathname === '/api/browser/state' && method === 'GET') {
      json(res, 200, { running: false, activeTabId: null, tabs: [] })
      return
    }
    if (pathname === '/api/channels/weixin' && method === 'GET') {
      json(res, 200, emptyWeixinStatus())
      return
    }
    if (pathname === '/api/channels/qqbot' && method === 'GET') {
      json(res, 200, emptyQqbotStatus())
      return
    }
    if (pathname === '/api/update/check' && method === 'GET') {
      json(res, 200, {
        currentVersion: '0.1.0',
        latest: null,
        updateAvailable: false,
        canInstall: false,
        checkedAt: Date.now(),
        repositoryUrl: '',
      })
      return
    }
    if (pathname === '/api/update/status' && method === 'GET') {
      json(res, 200, {
        phase: 'idle',
        version: null,
        downloadedBytes: 0,
        totalBytes: null,
        error: null,
        source: null,
      })
      return
    }
    if (pathname === '/api/git/status' && method === 'GET') {
      json(res, 200, { isRepository: false, entries: [] })
      return
    }

    notImplemented(res, pathname)
  }

  // —— per-session follow streams ——
  const followSse = (req: IncomingMessage, res: ServerResponse, sessionId: string): void => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const after = queryNumber(url, 'after') ?? 0
    res.writeHead(200, sseHeaders())
    res.write('retry: 1000\n\n')
    let lastSent = after
    let replaying = true
    const pending: Envelope[] = []

    const send = (envelope: Envelope): void => {
      if (envelope.seq <= lastSent) return
      lastSent = envelope.seq
      writeSse(res, envelope)
    }
    const unsubscribe = store.subscribe(sessionId, (envelope) => {
      if (replaying) pending.push(envelope)
      else send(envelope)
    })
    for (const envelope of store.eventsAfter(sessionId, after)) send(envelope)
    replaying = false
    for (const envelope of pending) send(envelope)
    const heartbeat = setInterval(() => writeSse(res, { type: 'hb' }), HEARTBEAT_MS)
    heartbeat.unref?.()
    req.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
  }

  const followPoll = async (res: ServerResponse, sessionId: string, url: URL): Promise<void> => {
    const after = queryNumber(url, 'after') ?? 0
    const waitSec = Math.max(0, Math.min(POLL_MAX_SEC, queryNumber(url, 'wait') ?? POLL_DEFAULT_SEC))
    const deadline = Date.now() + waitSec * 1000
    const unsubscribe = store.subscribe(sessionId, () => {})
    try {
      while (true) {
        const envelopes = store.eventsAfter(sessionId, after)
        if (envelopes.length > 0 || Date.now() >= deadline) {
          const last = envelopes[envelopes.length - 1]
          json(res, 200, { envelopes, seq: last?.seq ?? after })
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    } finally {
      unsubscribe()
    }
  }

  const server = http.createServer((req, res) => {
    void handler(req, res)
  })
  server.requestTimeout = 0

  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? Number(process.env.DENIA_PORT ?? 43655)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  const actualPort = typeof address === 'object' && address !== null ? address.port : port

  return {
    server,
    home,
    port: actualPort,
    baseUrl: `http://${host}:${actualPort}`,
    store,
    driver,
    async close() {
      clearInterval(heartbeatTimer)
      for (const client of sseClients) client.end()
      sseClients.clear()
      for (const id of store.list().map((summary) => summary.id)) {
        store.flush(id)
      }
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

function notImplemented(res: ServerResponse, pathname: string): void {
  apiError(res, 501, 'not-implemented', `${pathname} 尚未迁移到 TypeScript 宿主`)
}

function jsonOrError(res: ServerResponse, build: () => unknown): void {
  try {
    json(res, 200, build())
  } catch (error) {
    apiError(res, 400, 'fs/bad-request', errorMessage(error))
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

function loadWorkspaces(home: string): WorkspaceFile {
  const empty: WorkspaceFile = { initialized: true, order: [], workspaces: {} }
  const file = workspacesPath(home)
  if (!fs.existsSync(file)) return empty
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
  } catch {
    return empty
  }
  if (!isRecord(parsed)) return empty
  const rawWorkspaces = parsed.workspaces
  if (Array.isArray(rawWorkspaces)) {
    // Legacy TypeScript shape: plain array.
    const map: Record<string, WorkspaceRecord> = {}
    const order: string[] = []
    for (const entry of rawWorkspaces) {
      const record = normalizeWorkspace(entry)
      if (!record) continue
      map[record.id] = record
      order.push(record.id)
    }
    return { initialized: true, order, workspaces: map }
  }
  if (!isRecord(rawWorkspaces)) return empty
  const map: Record<string, WorkspaceRecord> = {}
  for (const [id, entry] of Object.entries(rawWorkspaces)) {
    const record = normalizeWorkspace(entry, id)
    if (record) map[record.id] = record
  }
  const order = Array.isArray(parsed.order)
    ? parsed.order.filter((id): id is string => typeof id === 'string' && id in map)
    : []
  for (const id of Object.keys(map)) {
    if (!order.includes(id)) order.push(id)
  }
  return { initialized: true, order, workspaces: map }
}

function normalizeWorkspace(raw: unknown, fallbackId?: string): WorkspaceRecord | null {
  if (!isRecord(raw)) return null
  const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : fallbackId
  if (!id || typeof raw.path !== 'string' || raw.path === '') return null
  return {
    id,
    path: raw.path,
    title: typeof raw.title === 'string' && raw.title !== '' ? raw.title : path.basename(raw.path),
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    sessionIds: Array.isArray(raw.sessionIds)
      ? raw.sessionIds.filter((entry): entry is string => typeof entry === 'string')
      : [],
  }
}

function workspaceList(file: WorkspaceFile): WorkspaceRecord[] {
  return file.order
    .map((id) => file.workspaces[id])
    .filter((record): record is WorkspaceRecord => record !== undefined)
}

function parseImages(value: unknown): ImageData[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .filter((entry) => typeof entry.mime === 'string' && typeof entry.data === 'string')
    .map((entry) => ({ mime: entry.mime as string, data: entry.data as string }))
}

function consolePermissionMode(home: string): 'read-only' | 'auto-edit' | 'full' {
  const document = loadSettings(home)
  const section = document && isRecord(document.console) ? document.console : null
  const mode = section && typeof section.defaultPermissionMode === 'string'
    ? section.defaultPermissionMode
    : ''
  return mode === 'read-only' || mode === 'full' || mode === 'auto-edit' ? mode : 'auto-edit'
}

function allFeatures(enabled: boolean) {
  return {
    agentsMd: enabled,
    memory: enabled,
    compaction: enabled,
    goal: enabled,
    taskLedger: enabled,
    skills: enabled,
    subagents: enabled,
    jobs: enabled,
    browser: enabled,
    ask: enabled,
    planMode: enabled,
  }
}

/** Shipped presets, mirroring `denia_core::preset::builtin_presets`. */
function builtinPresetRows() {
  return [
    {
      id: 'standard',
      trust: 'shipped' as const,
      name: '标准模式',
      description: '功能完整的编码 Agent:文件读写、Shell、检索、计划、目标、子代理与后台任务。',
      hasPersona: false,
      writable: false,
      features: allFeatures(true),
    },
    {
      id: 'creator',
      trust: 'shipped' as const,
      name: '创造模式',
      description: '让 Agent 帮你创建新预设:通过提问收集 persona、工具面与功能开关,直接落盘可用的 preset.yml。',
      hasPersona: true,
      writable: false,
      features: allFeatures(true),
    },
    {
      id: 'minimal',
      trust: 'shipped' as const,
      name: '极简模式',
      description: '只有持久 shell 的极简 Agent:系统提示一句话,无检索、记忆、计划与委派。',
      tools: ['bash'],
      hasPersona: true,
      writable: false,
      features: allFeatures(false),
    },
  ]
}

function serveStatic(res: ServerResponse, webDir: string, pathname: string): void {
  if (!isDirectory(webDir)) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(
      `web UI 构建产物不存在:${webDir}\n请先在 web/ 执行 pnpm install && pnpm build,或用 --web-dir 指定目录。`,
    )
    return
  }
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const resolved = path.resolve(webDir, relative)
  const webRoot = path.resolve(webDir)
  const inside = resolved === webRoot || resolved.startsWith(webRoot + path.sep)
  let file = inside ? resolved : webRoot
  if (!inside) {
    res.writeHead(403)
    res.end('forbidden')
    return
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    // SPA fallback only for extension-less routes; missing assets stay 404.
    if (path.extname(relative) !== '') {
      res.writeHead(404)
      res.end('not found')
      return
    }
    file = path.join(webRoot, 'index.html')
    if (!fs.existsSync(file)) {
      res.writeHead(404)
      res.end('index.html missing')
      return
    }
  }
  res.writeHead(200, {
    'content-type': mimeOf(file),
    'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
  })
  fs.createReadStream(file).pipe(res)
}

function listDirectories(target: string | null): { path: string; parent: string | null; dirs: string[] } {
  if (!target) {
    if (process.platform === 'win32') {
      const drives: string[] = []
      for (let code = 65; code <= 90; code += 1) {
        const drive = `${String.fromCharCode(code)}:\\`
        if (isDirectory(drive)) drives.push(drive)
      }
      return { path: '', parent: null, dirs: drives }
    }
    return { path: '/', parent: null, dirs: listChildDirs('/') }
  }
  const dir = path.resolve(target)
  if (!isDirectory(dir)) throw new Error(`不是目录:${dir}`)
  const parent = path.dirname(dir)
  return {
    path: dir,
    parent: parent === dir ? null : parent,
    dirs: listChildDirs(dir),
  }
}

function listChildDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('$'))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

function listMentions(root: string, query: string): { path: string; kind: 'file' | 'directory' }[] {
  if (!root || !isDirectory(root)) return []
  const items: { path: string; kind: 'file' | 'directory' }[] = []
  const lower = query.toLowerCase()
  const walk = (dir: string, prefix: string, depth: number): void => {
    if (items.length >= 50 || depth > 6) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (items.length >= 50) return
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (lower === '' || rel.toLowerCase().includes(lower)) {
        items.push({ path: rel, kind: entry.isDirectory() ? 'directory' : 'file' })
      }
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel, depth + 1)
    }
  }
  walk(root, '', 0)
  return items
}

function treeListing(root: string, dir: string): unknown {
  const base = path.resolve(root)
  if (!isDirectory(base)) throw new Error('工作区路径不是目录')
  const target = path.resolve(base, dir || '.')
  if (!target.startsWith(base)) throw new Error('路径越出工作区')
  if (!isDirectory(target)) throw new Error('不是目录')
  const entries = fs
    .readdirSync(target, { withFileTypes: true })
    .filter((entry) => entry.name !== '.git' && entry.name !== 'node_modules')
    .map((entry) => ({
      name: entry.name,
      path: dir ? `${dir}/${entry.name}` : entry.name,
      kind: entry.isDirectory() ? 'directory' : 'file',
    }))
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  return { root: base, dir, entries: entries.slice(0, 500), truncated: entries.length > 500 }
}

function workspaceFile(root: string, file: string): unknown {
  const base = path.resolve(root)
  const target = path.resolve(base, file)
  if (!target.startsWith(base)) throw new Error('路径越出工作区')
  const stat = fs.statSync(target)
  if (!stat.isFile()) throw new Error('不是文件')
  if (stat.size > 4 * 1024 * 1024) throw new Error('文件超过 4MB,无法预览')
  const content = fs.readFileSync(target, 'utf8')
  if (content.includes('\u0000')) throw new Error('二进制文件无法预览')
  const language = path.extname(target).slice(1) || null
  return {
    path: file,
    name: path.basename(target),
    content,
    size: stat.size,
    language,
    modifiedMs: stat.mtimeMs,
    lines: content.split('\n').length,
  }
}

function emptySubagentCatalog() {
  return {
    scope: 'user' as const,
    projectRoot: null,
    projectDir: null,
    userDir: '',
    revision: 1,
    effective: [],
    shadowed: [],
    diagnostics: [],
    colors: [],
    sources: [],
  }
}

function emptyWeixinStatus() {
  return {
    connected: false,
    account: null,
    lastError: null,
    lastInboundAt: null,
    lastInboundChars: 0,
    lastAction: null,
    login: null,
  }
}

function emptyQqbotStatus() {
  return {
    connected: false,
    account: null,
    lastError: null,
    lastInboundAt: null,
    lastInboundChars: 0,
    lastAction: null,
  }
}

export {}