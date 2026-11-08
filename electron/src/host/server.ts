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
import type { ApprovalBridge } from '../agent/gate.ts'
import type { ApprovalAnswer } from '../agent/gate.ts'
import { createModelReviewer } from '../agent/reviewer.ts'
import type { Reviewer } from '../agent/reviewer.ts'
import { deriveSurface } from '../agent/history.ts'
import { estimatePressure } from '../agent/prefix.ts'
import { summarizeContextUsage } from '../agent/context-usage.ts'
import { allPresetFeatures, presetForSession, presetRows, presetSettings } from '../agent/presets.ts'
import type { AgentPresetRow } from '../agent/presets.ts'
import { scheduleSessionTitle } from '../agent/session-title.ts'
import { Updater } from './update.ts'
import { availableApps, iconFor, launchApp } from './open-in-app.ts'
import { compactSession } from '../agent/compact.ts'
import type { AppConfig } from '../config.ts'
import {
  credentialInfo,
  findProvider,
  loadConfig,
  loadCredentialRefs,
  loadSettings,
  resolveDefault,
  resolveHome,
  saveSettingsNamespace,
  setCredential,
  settingsDescribe,
  unsetCredential,
  workspacesPath,
} from '../config.ts'
import { ExecPolicy } from '../core/exec-policy.ts'
import { legacyModeOf, presetState, stateFromLegacy } from '../core/permission.ts'
import { streamFor } from '../llm/index.ts'
import type { Envelope, ImageData, ModelSelection, SessionEvent, ToolCallRef } from '../core/wire.ts'
import { errorMessage, isRecord } from '../core/util.ts'
import { SessionStore } from '../session/store.ts'
import { FileHistoryStore } from '../session/file-history.ts'
import { GoalStore } from '../goal/store.ts'
import { GoalCommandError, GoalRuntime } from '../goal/runtime.ts'
import { ToolRegistry } from '../tools/index.ts'
import { ServerApprovalBridge } from './approval-bridge.ts'
import { HostServices } from './services.ts'
import { SkillTool } from '../tools/skill.ts'
import { JOB_TOOL_NAMES } from '../tools/jobs.ts'
import { JOB_OUTPUT_CAP, JobManager } from '../jobs/manager.ts'
import { McpManager } from '../mcp/manager.ts'
import type { McpServerConfig } from '../mcp/config.ts'
import {
  mergeServerConfig,
  normalizeServerConfig,
  validateMcpNamespace,
} from '../mcp/config.ts'
import { loadMcpSettings, mcpRevision, saveMcpSettings } from '../mcp/settings.ts'
import {
  deleteSkill,
  discoverSkills,
  getManagedSkill,
  importSkills,
  listManagedSkills,
  saveSkill,
  setSkillEnabled,
} from '../skills/skills.ts'
import {
  deleteMemoryFile,
  memoryHealth,
  memoryRoot,
  readMemoryFile,
  rebuildIndex,
  scanManifest,
  searchMemories,
} from '../context/memory.ts'
import { ProfileError, ProfileStore } from '../subagents/profiles.ts'
import { SubagentRuntime, subagentCapabilityNames } from '../subagents/runtime.ts'
import {
  modeOfPermission,
  normalizeInlineSpec,
  parentGrant,
  resolveDispatch,
  toolCatalogRows,
  effectivePermissionMode,
} from '../subagents/resolver.ts'
import { PROFILE_COLORS } from '../subagents/types.ts'

const HEARTBEAT_MS = 15_000
const POLL_MAX_SEC = 30
const POLL_DEFAULT_SEC = 25
const RING_LIMIT = 128

/** 发布仓库；更新检查与安装包下载都指向它。 */
const UPDATE_REPOSITORY = 'VerSonetto/Denia-electron'

export interface HostOptions {
  home?: string
  webDir?: string
  /** 应用版本，更新检查用它和发布版本比较；打包版由 main.ts 传入。 */
  version?: string
  host?: string
  port?: number
  /** Test seam: substitute the approval channel. */
  bridge?: ApprovalBridge
  /** Test seam: substitute the automatic reviewer. */
  reviewer?: Reviewer
  /** Test seam: substitute the command rule engine. */
  policy?: ExecPolicy
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
  // Launching GUI apps only makes sense for the machine the host runs on.
  const localOnly = isLoopbackHost(options.host ?? '127.0.0.1')
  fs.mkdirSync(home, { recursive: true })
  const webDir = options.webDir ?? path.resolve(import.meta.dirname, '..', '..', '..', 'web', 'dist')
  const updater = new Updater({
    currentVersion: options.version ?? '0.0.0',
    repository: UPDATE_REPOSITORY,
    downloadDir: path.join(home, 'updates'),
  })

  let config = loadConfig(home)
  const store = new SessionStore(home)
  const fileHistory = new FileHistoryStore(home)
  const registry = ToolRegistry.builtin()
  registry.register(new SkillTool(home))
  const workspaces = loadWorkspaces(home)
  const defaultPermissionMode = consolePermissionMode(home)
  const policy = options.policy ?? ExecPolicy.load(path.join(home, 'execpolicy.json'))
  const bridge = options.bridge ?? new ServerApprovalBridge()
  // Only the built-in channel knows how to settle requests from HTTP.
  const approvalChannel = bridge instanceof ServerApprovalBridge ? bridge : undefined

  // The automatic reviewer answers one non-streaming completion per prompt.
  const completeForReview = async (
    system: string,
    user: string,
    signal: AbortSignal,
  ): Promise<string> => {
    const selection = resolveDefault(config)
    const provider = findProvider(config, selection.provider) ?? config.providers[0]
    if (!provider) throw new Error('没有可用的模型提供商')
    const parts: string[] = []
    for await (const chunk of streamFor({
      provider,
      model: selection.model,
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      signal,
    })) {
      if (chunk.type === 'text-delta') parts.push(chunk.text)
    }
    return parts.join('')
  }
  const reviewer = options.reviewer ?? createModelReviewer(completeForReview)

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

  const saveWorkspaces = (): void => {
    fs.writeFileSync(workspacesPath(home), JSON.stringify(workspaces, null, 2) + '\n', 'utf8')
  }

  /** Child sessions inherit the parent's workspace membership, like the Rust host. */
  const attachToParentWorkspaces = (childId: string, parentId: string): void => {
    let changed = false
    for (const workspace of Object.values(workspaces.workspaces)) {
      if (!workspace.sessionIds.includes(parentId)) continue
      if (workspace.sessionIds.includes(childId)) continue
      workspace.sessionIds = [childId, ...workspace.sessionIds]
      changed = true
    }
    if (changed) saveWorkspaces()
    broadcast({ type: 'sessions-updated' })
  }

  const detachFromWorkspaces = (childId: string): void => {
    let changed = false
    for (const workspace of Object.values(workspaces.workspaces)) {
      const before = workspace.sessionIds.length
      workspace.sessionIds = workspace.sessionIds.filter((id) => id !== childId)
      if (workspace.sessionIds.length !== before) changed = true
    }
    if (changed) saveWorkspaces()
    broadcast({ type: 'sessions-updated' })
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
    {
      bridge,
      reviewer,
      policy,
    },
  )

  const runningSessionIds = (): string[] => driver.runningIds()

  // —— MCP + subagents ——
  const mcp = new McpManager(registry.names())
  let mcpSettings = loadMcpSettings(home)
  let mcpReady = mcp.reload(mcpSettings.servers).catch((error: unknown) => {
    console.error('[denia] MCP 初始化失败:', errorMessage(error))
  })
  const profiles = new ProfileStore(home)
  const subagents = new SubagentRuntime(store, profiles, {
    startTurn: (sessionId, prompt, turnOptions) =>
      driver.startTurn(sessionId, prompt, turnOptions ?? {}),
    cancel: (sessionId) => driver.cancel(sessionId),
    isRunning: (sessionId) => driver.isRunning(sessionId),
    append: (sessionId, event) => store.append(sessionId, event),
    permissionStateOf: (sessionId) => driver.permissionStateOf(sessionId),
  }, {
    maxConcurrentRuns: subagentPolicyConcurrency(home),
    childCreated: attachToParentWorkspaces,
    childRemoved: detachFromWorkspaces,
    definitionsChanged: () => broadcast({ type: 'subagents-updated' }),
    config: () => config,
  })
  const jobs = new JobManager({
    onDone: (job) => {
      // The completion notice is enqueued as an inbox event and only becomes
      // model-visible at the next step boundary, so a busy turn is never
      // interrupted mid-action.
      let text = `[后台任务完成]\n${JSON.stringify(jobs.peek(job.id, job.owner))}`
      if (text.length > JOB_OUTPUT_CAP) {
        text = `${Array.from(text).slice(0, JOB_OUTPUT_CAP).join('')}\n（后台任务结果已截断，完整输出请用 job_output 读取。）`
      }
      try {
        subagents.enqueue(job.owner, `job:${job.id}`, text, 'job-completed')
      } catch {
        // The owning session is gone; the result stays readable while retained.
      }
    },
  })
  const describedToolNames = (): string[] =>
    [...new Set([
      ...registry.names(),
      ...subagentCapabilityNames(),
      ...JOB_TOOL_NAMES,
      ...mcp.snapshot().toolNames(),
    ])].sort()
  subagents.setToolNames(describedToolNames)
  // A settled child must not leave background processes behind: they belong to
  // the child's lifetime, and the notice lists what was cancelled.
  subagents.setJobCleaner((sessionId) => jobs.removeOwner(sessionId))
  const goalStore = new GoalStore(home)
  const goalRuntime = new GoalRuntime({
    goalStore,
    config: () => config,
    isRunning: (sessionId) => driver.isRunning(sessionId),
    startTurn: (sessionId, prompt, options) => {
      void driver.startTurn(sessionId, prompt, options)
    },
    cancel: (sessionId) => driver.cancel(sessionId),
    selectionOf: (sessionId) => driver.selectionOf(sessionId),
    verify: (input) => driver.runGoalVerification(input),
    planEnabled: (sessionId) => driver.permissionStateOf(sessionId).collaboration === 'plan',
    append: (sessionId, event) => store.append(sessionId, event),
  })
  let instanceBase = ''
  const hostServices = new HostServices({
    mcp,
    subagents,
    jobs,
    home,
    store,
    fileHistory,
    goal: goalRuntime,
    permissionStateOf: (sessionId) => driver.permissionStateOf(sessionId),
    apiBase: () => instanceBase,
  })
  driver.attachServices(hostServices)

  // Startup recovery: results enqueued before the host stopped are still in the
  // session log; replay recent child completions and wake their sessions.
  setImmediate(() => {
    try {
      for (const summary of store.list()) subagents.recover(summary.id)
    } catch (error) {
      console.error('[denia] 完成结果恢复失败:', errorMessage(error))
    }
  })

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

    // —— permissions ——
    if (pathname === '/api/permissions/catalog' && method === 'GET') {
      json(res, 200, {
        modes: ['read-only', 'workspace-write', 'approve-for-me', 'full-access'],
        default: 'workspace-write',
      })
      return
    }

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
          : presetSettings(home).default
        const header = store.create(cwd, { sandbox: true })
        const initial = stateFromLegacy(defaultPermissionMode)
        store.append(header.id, { type: 'permission-mode', mode: defaultPermissionMode })
        store.append(header.id, {
          type: 'permission-selection',
          sandbox: initial.sandbox,
          approval: initial.approval,
          reviewer: initial.reviewer,
          collaboration: initial.collaboration,
        })
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
        try {
          subagents.ensureRemovable(sessionId)
        } catch (error) {
          apiError(res, 409, 'session/agents-running', errorMessage(error))
          return
        }
        subagents.removeOwner(sessionId)
        jobs.removeOwner(sessionId)
        goalStore.remove(sessionId)
        driver.forgetCacheWarm(sessionId)
        store.flush(sessionId)
        store.delete(sessionId)
        fileHistory.forget(sessionId)
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
        const skills = Array.isArray(body.skills)
          ? [...new Set(
              body.skills
                .filter((name): name is string => typeof name === 'string')
                .map((name) => name.trim())
                .filter((name) => name !== ''),
            )]
          : []
        void driver.startTurn(sessionId, prompt, {
          ...(selection ? { selection } : {}),
          ...(images.length > 0 ? { images } : {}),
          ...(skills.length > 0 ? { skills } : {}),
          ...(typeof body.source === 'string' ? { source: body.source } : {}),
        })
        void scheduleSessionTitle({
          store,
          config,
          sessionId,
          ...(selection ? { selection } : {}),
          prompt,
          onUpdated: () => broadcast({ type: 'sessions-updated' }),
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
        goalRuntime.pause(sessionId)
        driver.cancel(sessionId)
        json(res, 200, { ok: true })
        return
      }
      if (rest === '/permission' && method === 'PUT') {
        const body = await readJson(req)
        const mode = body.mode
        if (mode === 'read-only' || mode === 'auto-edit' || mode === 'plan' || mode === 'full') {
          const next = stateFromLegacy(mode, driver.permissionStateOf(sessionId))
          store.append(sessionId, { type: 'permission-mode', mode })
          store.append(sessionId, {
            type: 'permission-selection',
            sandbox: next.sandbox,
            approval: next.approval,
            reviewer: next.reviewer,
            collaboration: next.collaboration,
          })
          json(res, 200, { mode, selection: next })
          return
        }
        if (mode === 'approve-for-me') {
          const next = presetState('approve-for-me')
          store.append(sessionId, { type: 'permission-mode', mode: legacyModeOf(next) })
          store.append(sessionId, {
            type: 'permission-selection',
            sandbox: next.sandbox,
            approval: next.approval,
            reviewer: next.reviewer,
            collaboration: next.collaboration,
          })
          json(res, 200, { mode, selection: next })
          return
        }
        // Preset-level write (the agent-mode selector).
        const agentMode = body.agentMode
        if (agentMode === 'read-only' || agentMode === 'workspace-write' || agentMode === 'approve-for-me' || agentMode === 'full-access') {
          const next = presetState(agentMode)
          store.append(sessionId, { type: 'permission-mode', mode: legacyModeOf(next) })
          store.append(sessionId, {
            type: 'permission-selection',
            sandbox: next.sandbox,
            approval: next.approval,
            reviewer: next.reviewer,
            collaboration: next.collaboration,
          })
          json(res, 200, { agentMode, selection: next })
          return
        }
        apiError(res, 400, 'permission/bad-mode', '未知权限档位')
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
        const requestId = rest.slice('/approvals/'.length)
        const body = await readJson(req)
        const answer = approvalAnswerOf(body)
        if (!answer) {
          apiError(res, 400, 'approval/bad-decision', "decision must be 'allow-once', 'allow-session', 'reject' or 'cancel'")
          return
        }
        if (!approvalChannel || !approvalChannel.answer(requestId, answer)) {
          apiError(res, 404, 'approval/not-found', '该审批请求不存在或已结算')
          return
        }
        json(res, 200, { ok: true })
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
        json(res, 200, goalRuntime.view(sessionId))
        return
      }
      if (rest === '/goal' && method === 'POST') {
        const body = await readJson(req)
        const action = typeof body.action === 'string' ? body.action : 'set'
        const objective = typeof body.objective === 'string' ? body.objective : ''
        const rawBudget = body.tokenBudget
        const tokenBudget =
          typeof rawBudget === 'number'
            ? rawBudget
            : rawBudget === null
              ? null
              : undefined
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
        if (typeof body.echoText === 'string' && body.echoText.trim() !== '') {
          store.append(sessionId, { type: 'command-run', name: 'goal', text: body.echoText })
        }
        try {
          if (action === 'pause') {
            goalRuntime.pause(sessionId)
          } else if (action === 'clear') {
            goalRuntime.clear(sessionId)
          } else if (action === 'resume') {
            goalRuntime.resume(sessionId, selection)
          } else if (action === 'set' || action === 'edit') {
            if (driver.isRunning(sessionId)) {
              apiError(res, 409, 'session/running', '上一轮还在运行，请先等待或暂停目标')
              return
            }
            goalRuntime.set(sessionId, objective, tokenBudget, selection)
          } else {
            apiError(res, 400, 'goal/bad-action', `未知的目标操作: ${action}`)
            return
          }
        } catch (error) {
          if (error instanceof GoalCommandError) {
            apiError(res, error.status, error.code, error.message)
            return
          }
          throw error
        }
        json(res, 200, goalRuntime.view(sessionId))
        return
      }
      if (rest === '/compact' && method === 'POST') {
        if (driver.isRunning(sessionId)) {
          apiError(res, 409, 'session/running', '会话正在运行，压缩不可用')
          return
        }
        json(res, 202, { accepted: true, id: sessionId })
        driver.cancelCacheWarm(sessionId)
        void compactSession({
          store,
          config,
          sessionId,
          onFailed: (message) =>
            broadcast({ type: 'compaction-failed', id: sessionId, message }),
          onUpdated: () => broadcast({ type: 'sessions-updated' }),
        })
        return
      }
      if (rest === '/context-breakdown' && method === 'GET') {
        const events = store.read(sessionId)?.events ?? []
        const surface = deriveSurface(events)
        let lastWindow: number | undefined
        for (let index = events.length - 1; index >= 0; index -= 1) {
          const event = events[index]!
          if (event.type === 'request-context' && event.context_window) {
            lastWindow = event.context_window
            break
          }
        }
        const pressure = estimatePressure(events, surface, lastWindow)
        const usage = {
          uncachedInputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        }
        for (const event of events) {
          if (event.type !== 'assistant-message' || !event.usage) continue
          usage.uncachedInputTokens += event.usage.inputTokens ?? 0
          usage.outputTokens += event.usage.outputTokens ?? 0
          usage.cacheReadTokens += event.usage.cacheReadTokens ?? 0
          usage.reasoningTokens += event.usage.reasoningTokens ?? 0
        }
        // Total is provider usage; parts estimate the same request surface
        // independently.
        const parts = driver.contextUsage(sessionId)?.parts ?? []
        json(res, 200, {
          breakdown: {
            ...summarizeContextUsage(parts),
            parts,
          },
          pressure: {
            ...(lastWindow ? { contextWindow: lastWindow } : {}),
            ...(pressure
              ? {
                  pressureTokens: pressure.anchorTokens,
                  projectedTokens: pressure.projectedTokens,
                }
              : {}),
          },
          usage,
        })
        return
      }
      if (rest === '/checkpoints' && method === 'GET') {
        const session = store.read(sessionId)
        if (!session) {
          apiError(res, 404, 'session/not-found', 'session not found')
          return
        }
        const checkpoints: { seq: number; time: number; text: string }[] = []
        for (const event of session.events) {
          if (event.type !== 'user-message' || event.injected) continue
          checkpoints.push({ seq: event.seq, time: event.time, text: event.text })
        }
        json(res, 200, { checkpoints })
        return
      }
      const checkpointDiff = /^\/checkpoints\/(\d+)\/diff$/.exec(rest)
      if (checkpointDiff && method === 'GET') {
        const header = store.header(sessionId)!
        const seq = Number(checkpointDiff[1])
        try {
          json(res, 200, { changes: fileHistory.diff(sessionId, header.cwd, seq) })
        } catch (error) {
          apiError(res, 400, 'file-history/diff', errorMessage(error))
        }
        return
      }
      if (rest === '/rewind' && method === 'POST') {
        if (driver.isRunning(sessionId)) {
          apiError(res, 409, 'session/running', 'cancel the running turn before rewinding')
          return
        }
        const body = await readJson(req)
        const toSeq = typeof body.toSeq === 'number' ? body.toSeq : Number.NaN
        if (!Number.isInteger(toSeq) || toSeq <= 0) {
          apiError(res, 400, 'session/not-rewind-point', '回退点必须是正整数 seq')
          return
        }
        // Validate the target before touching files: a rejected rewind must not
        // restore half the workspace.
        const target = store.read(sessionId)?.events.find((event) => event.seq === toSeq)
        if (!target || target.type !== 'user-message' || target.injected) {
          apiError(res, 400, 'session/not-rewind-point', '只能回退到用户消息')
          return
        }
        const header = store.header(sessionId)!
        let changedFiles: string[]
        try {
          // Files first: if restoring fails the conversation log is untouched.
          changedFiles = fileHistory.rewind(sessionId, header.cwd, toSeq)
        } catch (error) {
          apiError(res, 400, 'file-history/rewind', errorMessage(error))
          return
        }
        let outcome
        try {
          outcome = store.rewind(sessionId, toSeq)
        } catch (error) {
          apiError(res, 400, 'session/rewind', errorMessage(error))
          return
        }
        // The removed branch may have left paused flags or auto-wake budgets;
        // both point at events that no longer exist on the new branch.
        subagents.onSessionRewound(sessionId)
        driver.forgetCacheWarm(sessionId)
        broadcast({ type: 'sessions-updated' })
        json(res, 200, {
          ok: true,
          toSeq: outcome.toSeq,
          toMessage: outcome.toMessage,
          removedEvents: outcome.removedEvents,
          changedFiles,
        })
        return
      }
      if (rest === '/skills' && method === 'GET') {
        const header = store.header(sessionId)
        const skills = header ? discoverSkills(home, header.cwd).skills : []
        json(res, 200, {
          skills: skills.map((skill) => ({
            name: skill.name,
            description: skill.description,
            source: skill.source,
            modelInvocable: skill.modelInvocable,
            userInvocable: skill.userInvocable,
          })),
        })
        return
      }
      if (rest === '/agents' && method === 'GET') {
        json(res, 200, { agents: subagents.list(sessionId) })
        return
      }
      const agentActionMatch = /^\/agents\/([^/]+)\/(message|interrupt)$/.exec(rest)
      if (agentActionMatch && method === 'POST') {
        const target = safeDecode(agentActionMatch[1]!)
        const action = agentActionMatch[2]!
        try {
          if (action === 'message') {
            const body = await readJson(req)
            const message = typeof body.message === 'string' ? body.message : ''
            if (message.trim() === '') {
              apiError(res, 400, 'subagent/message-empty', '消息不能为空')
              return
            }
            json(res, 202, subagents.send(sessionId, target, message))
          } else {
            subagents.interrupt(sessionId, target)
            json(res, 200, { ok: true })
          }
        } catch (error) {
          apiError(res, 400, 'subagent/control-failed', errorMessage(error))
        }
        return
      }
      if (rest === '/jobs' && method === 'GET') {
        json(res, 200, { jobs: jobs.list(sessionId) })
        return
      }
      const jobMatch = /^\/jobs\/([^/]+)\/(output|kill)$/.exec(rest)
      if (jobMatch) {
        const jobId = jobMatch[1]!
        const action = jobMatch[2]
        try {
          if (action === 'output' && method === 'GET') {
            json(res, 200, jobs.peek(jobId, sessionId))
            return
          }
          if (action === 'kill' && method === 'POST') {
            jobs.kill(jobId, sessionId)
            json(res, 200, { ok: true })
            return
          }
        } catch (error) {
          apiError(res, 400, 'job/not-found', errorMessage(error))
          return
        }
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
      if (ns === 'subagent-policy') {
        const value = body.value
        if (!isRecord(value) || !Number.isInteger(value.maxConcurrentRuns) || (value.maxConcurrentRuns as number) < 1 || (value.maxConcurrentRuns as number) > 64) {
          apiError(res, 400, 'subagent-policy/invalid', 'maxConcurrentRuns 必须是 1–64 的整数')
          return
        }
      }
      saveSettingsNamespace(home, ns, body.value)
      config = loadConfig(home)
      if (ns === 'subagent-policy') subagents.setConcurrencyLimit(subagentPolicyConcurrency(home))
      if (ns === 'mcp') {
        mcpSettings = loadMcpSettings(home)
        mcpReady = mcp.reload(mcpSettings.servers)
        await mcpReady
        broadcast({ type: 'mcp-updated' })
      }
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
    // 本机桌面应用:凭据存在本机明文 YAML,读取回显供设置界面查看/编辑。
    const credentialValueMatch = /^\/api\/credentials\/(.+)\/value$/.exec(pathname)
    if (credentialValueMatch && method === 'GET') {
      const ref = safeDecode(credentialValueMatch[1]!)
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) {
        apiError(res, 400, 'credential/invalid', '凭据引用名非法')
        return
      }
      const value = process.env[ref]?.trim() || loadCredentialRefs(home)[ref]?.trim() || ''
      json(res, 200, { value })
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
        ...presetSettings(home),
        root: path.join(home, 'agent-presets'),
        tools: describedToolNames(),
        presets: presetRows(home),
      })
      return
    }
    const presetMatch = /^\/api\/agent-presets\/([^/]+)$/.exec(pathname)
    if (presetMatch && method === 'GET') {
      const id = safeDecode(presetMatch[1]!)
      const preset = presetRows(home).find((entry) => entry.id === id)
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
      json(res, 200, { kind: 'browse' })
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
    if (pathname === '/api/system-prompt') {
      if (method === 'GET') {
        json(res, 200, hostServices.systemPromptView())
        return
      }
      if (method === 'PUT') {
        const body = await readJson(req)
        const text = typeof body.text === 'string' ? body.text : ''
        if (Buffer.byteLength(text, 'utf8') > 1_048_576) {
          apiError(res, 413, 'system-prompt/too-large', '系统提示词超过 1 MiB 上限')
          return
        }
        hostServices.saveSystemPrompt(text)
        json(res, 200, hostServices.systemPromptView())
        return
      }
      if (method === 'DELETE') {
        hostServices.resetSystemPrompt()
        json(res, 200, hostServices.systemPromptView())
        return
      }
    }
    if (pathname === '/api/global-rules') {
      const file = path.join(home, 'AGENTS.md')
      const view = () => {
        let text = ''
        try {
          text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
        } catch {
          /* not configured */
        }
        return {
          text,
          source: text === '' ? ('default' as const) : ('file' as const),
          displayPath: '~/AGENTS.md',
          path: file,
        }
      }
      if (method === 'GET') {
        json(res, 200, view())
        return
      }
      if (method === 'PUT') {
        const body = await readJson(req)
        const text = typeof body.text === 'string' ? body.text : ''
        if (Buffer.byteLength(text, 'utf8') > 1_048_576) {
          apiError(res, 413, 'rules/too-large', '全局规则超过 1 MiB 上限')
          return
        }
        if (text.trim() === '') fs.rmSync(file, { force: true })
        else fs.writeFileSync(file, text, 'utf8')
        json(res, 200, view())
        return
      }
    }

    // —— MCP ——
    const describeMcp = () => ({
      servers: mcp.snapshot().servers,
      toolCount: mcp.snapshot().toolDefs().length,
    })
    if (pathname === '/api/mcp' && method === 'GET') {
      await mcpReady
      json(res, 200, describeMcp())
      return
    }
    if (pathname === '/api/mcp/servers' && method === 'PUT') {
      const body = await readJson(req)
      if (!isRecord(body.server)) {
        apiError(res, 400, 'mcp/invalid-server', 'server 必须是对象')
        return
      }
      const incoming = normalizeServerConfig(body.server)
      const preserve = body.preserveSecrets === true
      const existing = mcpSettings.servers.find((server) => server.id === incoming.id)
      const merged = existing ? mergeServerConfig(existing, incoming, preserve) : incoming
      const servers = existing
        ? mcpSettings.servers.map((server) => (server.id === merged.id ? merged : server))
        : [...mcpSettings.servers, merged]
      try {
        validateMcpNamespace({ servers })
      } catch (error) {
        apiError(res, 400, 'mcp/invalid-config', errorMessage(error))
        return
      }
      const expected = typeof body.expectedRevision === 'number' ? body.expectedRevision : undefined
      if (expected !== undefined && expected !== mcpRevision(home)) {
        apiError(res, 409, 'mcp/revision-conflict', 'MCP 配置已被外部修改，请刷新后重试')
        return
      }
      try {
        saveMcpSettings(home, { servers })
      } catch (error) {
        apiError(res, 400, 'mcp/invalid-config', errorMessage(error))
        return
      }
      mcpSettings = loadMcpSettings(home)
      mcpReady = mcp.reload(mcpSettings.servers)
      await mcpReady
      broadcast({ type: 'mcp-updated' })
      json(res, 200, describeMcp())
      return
    }
    const mcpServerMatch = /^\/api\/mcp\/servers\/([^/]+)$/.exec(pathname)
    if (mcpServerMatch) {
      const id = safeDecode(mcpServerMatch[1]!)
      if (method === 'DELETE') {
        if (!mcpSettings.servers.some((server) => server.id === id)) {
          apiError(res, 404, 'mcp/unknown-server', `未知的 MCP 服务器:${id}`)
          return
        }
        const servers = mcpSettings.servers.filter((server) => server.id !== id)
        saveMcpSettings(home, { servers })
        mcpSettings = loadMcpSettings(home)
        mcpReady = mcp.reload(mcpSettings.servers)
        await mcpReady
        broadcast({ type: 'mcp-updated' })
        json(res, 200, describeMcp())
        return
      }
      if (method === 'POST') {
        const body = await readJson(req)
        const action = typeof body.action === 'string' ? body.action : ''
        const existing = mcpSettings.servers.find((server) => server.id === id)
        if (action === 'reconnect') {
          if (!existing) {
            apiError(res, 404, 'mcp/unknown-server', `未知的 MCP 服务器:${id}`)
            return
          }
          await mcp.disconnect(id)
          mcpReady = mcp.reload(mcpSettings.servers)
          await mcpReady
        } else if (action === 'enable' || action === 'disable') {
          if (!existing) {
            apiError(res, 404, 'mcp/unknown-server', `未知的 MCP 服务器:${id}`)
            return
          }
          const servers = mcpSettings.servers.map((server) =>
            server.id === id ? { ...server, enabled: action === 'enable' } : server,
          )
          saveMcpSettings(home, { servers })
          mcpSettings = loadMcpSettings(home)
          mcpReady = mcp.reload(mcpSettings.servers)
          await mcpReady
        } else {
          apiError(res, 400, 'mcp/unknown-action', `未知的 action:${action}(可用:enable / disable / reconnect)`)
          return
        }
        broadcast({ type: 'mcp-updated' })
        json(res, 200, describeMcp())
        return
      }
    }
    if (pathname === '/api/mcp/tools' && method === 'POST') {
      const body = await readJson(req)
      const serverId = typeof body.server === 'string' ? body.server : ''
      const tool = typeof body.tool === 'string' ? body.tool : ''
      const enabled = body.enabled === true
      const existing = mcpSettings.servers.find((server) => server.id === serverId)
      if (!existing) {
        apiError(res, 404, 'mcp/unknown-server', `未知的 MCP 服务器:${serverId}`)
        return
      }
      const disabledTools = enabled
        ? existing.disabledTools.filter((name) => name !== tool)
        : existing.disabledTools.includes(tool)
          ? existing.disabledTools
          : [...existing.disabledTools, tool]
      const servers = mcpSettings.servers.map((server) =>
        server.id === serverId ? { ...server, disabledTools } : server,
      )
      saveMcpSettings(home, { servers })
      mcpSettings = loadMcpSettings(home)
      mcpReady = mcp.reload(mcpSettings.servers)
      await mcpReady
      broadcast({ type: 'mcp-updated' })
      json(res, 200, describeMcp())
      return
    }

    // —— subagent definitions ——
    const scopeRoot = (sessionId: string | null, cwd: string | null): string | null => {
      if (sessionId) {
        const header = store.header(sessionId)
        if (!header) throw new ProfileError('subagent/profile-not-found', `未知的会话:${sessionId}`)
        if (!isDirectory(header.cwd)) {
          throw new ProfileError('subagent/cwd-missing', `会话 ${sessionId} 的工作目录已不存在：${header.cwd}`)
        }
        return ProfileStore.projectRoot(header.cwd)
      }
      if (cwd) {
        if (!isDirectory(cwd)) {
          throw new ProfileError('subagent/cwd-missing', `项目目录不存在：${cwd}`)
        }
        return ProfileStore.projectRoot(cwd)
      }
      return null
    }
    const profileError = (res: ServerResponse, error: unknown): void => {
      if (error instanceof ProfileError) {
        const status = error.code === 'subagent/profile-not-found'
          ? 404
          : error.code === 'subagent/profile-exists' ||
              error.code === 'subagent/revision-conflict' ||
              error.code === 'subagent/profile-shadowed'
            ? 409
            : error.code === 'subagent/scope-forbidden'
              ? 403
              : error.code === 'subagent/ambiguous-spec' ||
                  error.code === 'subagent/depth-config-removed' ||
                  error.code === 'subagent/cwd-missing'
                ? 400
                : 422
        let message = error.message
        if (error.field) message += `（字段：${error.field}）`
        if (error.candidates.length > 0) message += `；可用候选：${error.candidates.join('、')}`
        apiError(res, status, error.code, message)
        return
      }
      apiError(res, 400, 'subagent/invalid', errorMessage(error))
    }
    const profileFromBody = (raw: unknown): {
      profile: import('../subagents/types.ts').SubagentProfile
      body: string
    } => {
      if (!isRecord(raw)) throw new ProfileError('subagent/profile-invalid', 'profile 必须是对象', 'profile')
      const profile: import('../subagents/types.ts').SubagentProfile = {
        schemaVersion: typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 1,
        id: typeof raw.id === 'string' ? raw.id : '',
        name: typeof raw.name === 'string' ? raw.name : '',
        description: typeof raw.description === 'string' ? raw.description : '',
        instructions: typeof raw.instructions === 'string' ? raw.instructions : '',
        enabled: raw.enabled !== false,
        tools: isRecord(raw.tools)
          ? raw.tools.mode === 'allowlist'
            ? {
                mode: 'allowlist',
                names: Array.isArray(raw.tools.names)
                  ? raw.tools.names.filter((name): name is string => typeof name === 'string')
                  : [],
              }
            : { mode: 'inherit' }
          : { mode: 'inherit' },
        model: isRecord(raw.model) && raw.model.mode === 'explicit' && isRecord(raw.model.selection)
          ? {
              mode: 'explicit',
              selection: {
                provider: typeof raw.model.selection.provider === 'string' ? raw.model.selection.provider : '',
                model: typeof raw.model.selection.model === 'string' ? raw.model.selection.model : '',
                ...(typeof raw.model.selection.reasoningEffort === 'string'
                  ? { reasoningEffort: raw.model.selection.reasoningEffort }
                  : {}),
              },
            }
          : { mode: 'inherit' },
        permissionCeiling: raw.permissionCeiling === 'read-only' ? 'read-only' : 'inherit',
        ...(typeof raw.color === 'string' && (PROFILE_COLORS as string[]).includes(raw.color)
          ? { color: raw.color as import('../subagents/types.ts').ProfileColor }
          : {}),
      }
      return { profile, body: profile.instructions }
    }

    if (pathname === '/api/subagent-profiles' && method === 'GET') {
      try {
        const root = scopeRoot(url.searchParams.get('sessionId'), url.searchParams.get('cwd'))
        const catalog = profiles.catalog(root)
        json(res, 200, {
          scope: root ? 'project' : 'user',
          projectRoot: catalog.projectRoot,
          projectDir: catalog.projectDir,
          userDir: catalog.userDir,
          revision: catalog.revision,
          effective: catalog.effective,
          shadowed: catalog.shadowed,
          diagnostics: catalog.diagnostics,
          colors: PROFILE_COLORS,
          sources: ['builtin', 'user', 'project'],
        })
      } catch (error) {
        profileError(res, error)
      }
      return
    }
    if (pathname === '/api/subagent-profiles' && method === 'POST') {
      try {
        const body = await readJson(req)
        const root = scopeRoot(
          typeof body.sessionId === 'string' ? body.sessionId : null,
          typeof body.cwd === 'string' ? body.cwd : null,
        )
        const scope = body.scope === 'project' ? 'project' : 'user'
        const parsed = profileFromBody(body.profile)
        const view = profiles.create(scope, root, parsed.profile, parsed.body)
        broadcast({ type: 'subagents-updated' })
        json(res, 201, { profile: view })
      } catch (error) {
        profileError(res, error)
      }
      return
    }
    if (pathname === '/api/subagent-profiles/preview' && method === 'POST') {
      const body = await readJson(req)
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : null
      if (!sessionId) {
        json(res, 200, {
          sessionId: null,
          final: false,
          note: '未指定父会话：只能显示定义请求集合，不能判断最终可用工具。',
          requested:
            typeof body.profileId === 'string'
              ? body.profileId
              : isRecord(body.inline) && typeof body.inline.name === 'string'
                ? body.inline.name
                : null,
        })
        return
      }
      try {
        const header = store.header(sessionId)
        if (!header) {
          apiError(res, 404, 'subagent/profile-not-found', `未知的会话:${sessionId}`)
          return
        }
        const root = isDirectory(header.cwd) ? ProfileStore.projectRoot(header.cwd) : null
        const mode = modeOfPermission(driver.permissionStateOf(sessionId))
        const selection = lastSelectionOf(store.read(sessionId)?.events ?? [], config)
        const registered = describedToolNames()
        const grant = parentGrant(registered, undefined, mode)
        const profileId = typeof body.profileId === 'string' ? body.profileId : undefined
        const inline = body.inline
        const resolved = profileId
          ? profiles.resolve(root, profileId)
          : inline === undefined
            ? profiles.resolveDefault(root)
            : undefined
        const dispatch = resolveDispatch({
          args: {
            prompt: 'preview',
            ...(profileId ? { profile_id: profileId } : {}),
            ...(inline !== undefined ? { inline } : {}),
          },
          fork: false,
          parent: { registered, mode, selection },
          ...(resolved ? { profile: resolved } : {}),
          defaulted: profileId === undefined && inline === undefined,
        })
        let model = dispatch.selection
        let origin = dispatch.modelOrigin
        let modelFallback: string | null = null
        const provider = findProvider(config, model.provider)
        if (!provider || !provider.models.some((entry) => entry.id === model.model)) {
          if (origin === 'profile-explicit') {
            modelFallback = `定义的模型 ${model.provider}/${model.model} 当前不可用，实际会回退为跟随主会话 ${selection.provider}/${selection.model}`
            model = selection
            origin = 'parent'
          } else {
            apiError(res, 400, 'subagent/model-unavailable', `模型 ${model.provider}/${model.model} 当前不可用`)
            return
          }
        }
        json(res, 200, {
          sessionId,
          final: true,
          profile: {
            qualifiedId: dispatch.qualifiedId,
            name: dispatch.name,
            description: dispatch.description,
            inline: dispatch.inline,
            revision: dispatch.revision,
          },
          tools: dispatch.tools,
          toolCount: dispatch.tools.length,
          model,
          modelOrigin: origin,
          modelFallback,
          permissionCeiling: dispatch.permissionCeiling,
          effectivePermissionMode: effectivePermissionMode(dispatch.permissionCeiling, mode),
          delegationAllowed: false,
          instructionScope: 'project-only',
          fingerprint: previewFingerprint(dispatch.qualifiedId, dispatch.tools, dispatch.instructions),
        })
      } catch (error) {
        profileError(res, error)
      }
      return
    }
    const resetMatch = /^\/api\/subagent-profiles\/([^/]+)\/reset$/.exec(pathname)
    if (resetMatch && method === 'POST') {
      try {
        const body = await readJson(req)
        const root = scopeRoot(
          typeof body.sessionId === 'string' ? body.sessionId : null,
          typeof body.cwd === 'string' ? body.cwd : null,
        )
        const scope = body.scope === 'project' ? 'project' : 'user'
        const restored = profiles.reset(root, safeDecode(resetMatch[1]!), scope)
        broadcast({ type: 'subagents-updated' })
        json(res, 200, { restored })
      } catch (error) {
        profileError(res, error)
      }
      return
    }
    const profileMatch = /^\/api\/subagent-profiles\/([^/]+)$/.exec(pathname)
    if (profileMatch) {
      const qualifiedId = safeDecode(profileMatch[1]!)
      try {
        if (method === 'PUT') {
          const body = await readJson(req)
          const root = scopeRoot(
            typeof body.sessionId === 'string' ? body.sessionId : null,
            typeof body.cwd === 'string' ? body.cwd : null,
          )
          if (typeof body.expectedRevision !== 'number') {
            apiError(res, 400, 'subagent/revision-required', 'expectedRevision 必须是数字')
            return
          }
          const parsed = profileFromBody(body.profile)
          const view = profiles.update(root, qualifiedId, parsed.profile, parsed.body, body.expectedRevision)
          broadcast({ type: 'subagents-updated' })
          json(res, 200, { profile: view })
          return
        }
        if (method === 'DELETE') {
          const root = scopeRoot(
            url.searchParams.get('sessionId'),
            url.searchParams.get('cwd'),
          )
          const expectedRaw = url.searchParams.get('expectedRevision')
          const expected = expectedRaw === null ? undefined : Number(expectedRaw)
          let scope: import('../subagents/types.ts').ProfileWriteScope | undefined =
            url.searchParams.get('scope') === 'project'
              ? 'project'
              : url.searchParams.get('scope') === 'user'
                ? 'user'
                : undefined
          if (!scope) {
            const catalog = profiles.catalog(root)
            const view = catalog.effective.find((entry) => entry.qualifiedId === qualifiedId)
            if (!view) {
              throw new ProfileError('subagent/profile-not-found', `未知的子代理定义：${qualifiedId}`)
            }
            scope = profiles.writeScopeFor(view)
          }
          const restored = profiles.delete(root, qualifiedId, scope, expected)
          broadcast({ type: 'subagents-updated' })
          json(res, 200, { restored })
          return
        }
      } catch (error) {
        profileError(res, error)
        return
      }
      notImplemented(res, pathname)
      return
    }
    if (pathname === '/api/subagent-tools' && method === 'GET') {
      try {
        const sessionId = url.searchParams.get('sessionId')
        const registered = describedToolNames()
        let grant: string[] | null = null
        if (sessionId) {
          const header = store.header(sessionId)
          if (!header) {
            apiError(res, 404, 'subagent/profile-not-found', `未知的会话:${sessionId}`)
            return
          }
          const preset = presetForSession(home, header, store.read(sessionId)?.events ?? [])
          grant = parentGrant(registered, preset.tools, modeOfPermission(driver.permissionStateOf(sessionId)), preset.features)
        } else if (url.searchParams.get('cwd')) {
          scopeRoot(null, url.searchParams.get('cwd'))
        }
        json(res, 200, {
          sessionId,
          registered: registered.length,
          tools: toolCatalogRows(registered, grant),
        })
      } catch (error) {
        profileError(res, error)
      }
      return
    }
    // —— skills management ——
    const skillError = (res: ServerResponse, error: unknown): void => {
      const message = errorMessage(error)
      const status = message.includes('找不到') ? 404 : 400
      apiError(res, status, 'skills/invalid', message)
    }
    const skillCwd = url.searchParams.get('cwd')
    if (pathname === '/api/skills' && method === 'GET') {
      try {
        json(res, 200, {
          skills: listManagedSkills(home, skillCwd),
          directory: path.join(home, 'skills'),
        })
      } catch (error) {
        skillError(res, error)
      }
      return
    }
    if (pathname === '/api/skills/import' && method === 'POST') {
      try {
        const body = await readJson(req)
        const imported = importSkills(
          home,
          typeof body.cwd === 'string' ? body.cwd : null,
          typeof body.path === 'string' ? body.path : '',
          body.scope === 'project' ? 'project' : 'user',
        )
        broadcast({ type: 'skills-updated' })
        json(res, 200, { skills: imported })
      } catch (error) {
        skillError(res, error)
      }
      return
    }
    const skillEnabledMatch = /^\/api\/skills\/([^/]+)\/enabled$/.exec(pathname)
    if (skillEnabledMatch && method === 'POST') {
      try {
        const body = await readJson(req)
        const skill = setSkillEnabled(
          home,
          typeof body.cwd === 'string' ? body.cwd : null,
          safeDecode(skillEnabledMatch[1]!),
          body.enabled !== false,
        )
        broadcast({ type: 'skills-updated' })
        json(res, 200, { skill })
      } catch (error) {
        skillError(res, error)
      }
      return
    }
    const skillMatch = /^\/api\/skills\/([^/]+)$/.exec(pathname)
    if (skillMatch) {
      const name = safeDecode(skillMatch[1]!)
      try {
        if (method === 'GET') {
          json(res, 200, getManagedSkill(home, skillCwd, name))
          return
        }
        if (method === 'PUT') {
          const body = await readJson(req)
          if (typeof body.content !== 'string') {
            apiError(res, 400, 'skills/invalid-content', 'content 必须是字符串')
            return
          }
          const skill = saveSkill(
            home,
            typeof body.cwd === 'string' ? body.cwd : null,
            name,
            body.content,
            {
              create: body.create === true,
              scope: body.scope === 'project' ? 'project' : 'user',
            },
          )
          broadcast({ type: 'skills-updated' })
          json(res, 200, { skill })
          return
        }
        if (method === 'DELETE') {
          deleteSkill(home, skillCwd, name)
          broadcast({ type: 'skills-updated' })
          json(res, 200, { ok: true })
          return
        }
      } catch (error) {
        skillError(res, error)
        return
      }
    }

    // —— project memory ——
    if (pathname === '/api/memories/projects' && method === 'GET') {
      const projects = workspaceList(workspaces).map((workspace) => {
        const root = memoryRoot(home, workspace.path)
        const manifest = scanManifest(root)
        return {
          id: workspace.id,
          title: workspace.title,
          path: workspace.path,
          updatedAt: manifest.updatedAt,
          root: manifest.root,
          index: manifest.index,
          files: manifest.files,
        }
      })
      json(res, 200, { projects })
      return
    }
    const memoryIdMatch = /^\/api\/memories\/projects\/([^/]+)(\/.*)$/.exec(pathname)
    if (memoryIdMatch) {
      const id = safeDecode(memoryIdMatch[1]!)
      const restPath = memoryIdMatch[2]!
      const workspace = workspaces.workspaces[id]
      if (!workspace) {
        apiError(res, 404, 'memory/workspace-not-found', 'workspace not found')
        return
      }
      const root = memoryRoot(home, workspace.path)
      if (restPath === '/search' && method === 'GET') {
        const query = url.searchParams.get('q') ?? ''
        const kindRaw = url.searchParams.get('kind')
        const kind =
          kindRaw === 'experience' || kindRaw === 'fact' ? kindRaw : undefined
        const limit = queryNumber(url, 'limit') ?? 20
        const includeSuperseded = url.searchParams.get('include_superseded') === 'true'
        json(res, 200, searchMemories(root, query, limit, kind, includeSuperseded))
        return
      }
      if (restPath === '/index' && method === 'POST') {
        try {
          json(res, 200, { rebuilt: rebuildIndex(root) })
        } catch (error) {
          apiError(res, 400, 'memory/rebuild-failed', errorMessage(error))
        }
        return
      }
      if (restPath === '/health' && method === 'GET') {
        json(res, 200, { health: memoryHealth(root) })
        return
      }
      const file = safeDecode(restPath.replace(/^\/+/, ''))
      try {
        if (method === 'GET') {
          json(res, 200, readMemoryFile(root, file))
          return
        }
        if (method === 'DELETE') {
          json(res, 200, { deleted: deleteMemoryFile(root, file) })
          return
        }
      } catch (error) {
        const status = isRecord(error) && typeof error.status === 'number' ? error.status : 400
        apiError(
          res,
          status,
          status === 404 ? 'memory/file-not-found' : status === 413 ? 'memory/file-too-large' : 'memory/bad-path',
          errorMessage(error),
        )
        return
      }
    }
    const openInAppIcon = /^\/api\/open-in-app\/icon\/([A-Za-z0-9_-]+)$/.exec(pathname)
    if (openInAppIcon !== null && method === 'GET') {
      const png = localOnly ? await iconFor(openInAppIcon[1]!) : null
      if (png === null) {
        apiError(res, 404, 'open-in-app/no-icon', `no icon for app '${openInAppIcon[1]}'`)
        return
      }
      res.writeHead(200, {
        'content-type': 'image/png',
        'cache-control': 'public, max-age=3600',
      })
      res.end(png)
      return
    }
    if (pathname === '/api/open-in-app/open' && method === 'POST') {
      if (!localOnly) {
        apiError(res, 403, 'open-in-app/remote-disabled', '远程访问时不能启动宿主机应用')
        return
      }
      const body = await readJson(req)
      const app = typeof body.app === 'string' ? body.app : ''
      const dir = typeof body.path === 'string' ? body.path : ''
      if (dir === '' || !path.isAbsolute(dir)) {
        apiError(res, 400, 'open-in-app/bad-path', 'path 必须是绝对路径')
        return
      }
      let stat: fs.Stats | null = null
      try {
        stat = fs.statSync(dir)
      } catch {
        stat = null
      }
      if (!stat?.isDirectory()) {
        apiError(res, 404, 'open-in-app/dir-not-found', `目录不存在:${dir}`)
        return
      }
      const outcome = await launchApp(app, dir)
      if (outcome === 'unknown') {
        apiError(res, 400, 'open-in-app/unknown-app', `未知或不可用的应用:${app}`)
        return
      }
      if (outcome === 'failed') {
        apiError(res, 502, 'open-in-app/launch-failed', `启动失败:${app}`)
        return
      }
      json(res, 200, { ok: true })
      return
    }
    if (pathname === '/api/open-in-app/apps' && method === 'GET') {
      json(res, 200, { apps: localOnly ? availableApps() : [] })
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
      const force = url.searchParams.get('force') === 'true'
      try {
        json(res, 200, await updater.check(force))
      } catch (error) {
        apiError(res, 502, 'update/check-failed', errorMessage(error))
      }
      return
    }
    if (pathname === '/api/update/status' && method === 'GET') {
      json(res, 200, updater.status())
      return
    }
    if (pathname === '/api/update/install' && method === 'POST') {
      const body = await readJson(req)
      const version = typeof body.version === 'string' ? body.version : ''
      if (!version) {
        apiError(res, 400, 'update/bad-version', '缺少目标版本')
        return
      }
      try {
        json(res, 200, await updater.install(version))
      } catch (error) {
        apiError(res, 502, 'update/install-failed', errorMessage(error))
      }
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
  instanceBase = `http://${host}:${actualPort}`

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
      subagents.close()
      await mcp.shutdownAll()
      driver.dispose()
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

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
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

function approvalAnswerOf(body: Record<string, unknown>): ApprovalAnswer | null {
  const decision = body.decision
  let choice: ApprovalAnswer['choice']
  switch (decision) {
    // Legacy web UI values and the preset values are both accepted.
    case 'allow-once':
    case 'accept':
      choice = 'accept'
      break
    case 'allow-session':
    case 'accept-for-session':
      choice = 'accept-for-session'
      break
    case 'accept-with-rule':
      choice = 'accept-with-rule'
      break
    case 'reject':
    case 'decline':
      choice = 'decline'
      break
    case 'cancel':
      choice = 'cancel'
      break
    default:
      return null
  }
  const hasPlan =
    body.executeMode !== undefined || body.selection !== undefined || body.feedback !== undefined
  if (!hasPlan) return { choice }
  const selection =
    isRecord(body.selection) &&
    typeof body.selection.provider === 'string' &&
    typeof body.selection.model === 'string'
      ? {
          provider: body.selection.provider,
          model: body.selection.model,
          ...(typeof body.selection.reasoningEffort === 'string'
            ? { reasoningEffort: body.selection.reasoningEffort }
            : {}),
        }
      : undefined
  return {
    choice,
    plan: {
      outcome:
        choice === 'decline' ? 'rejected' : choice === 'cancel' ? 'cancelled' : 'allowed-once',
      ...(body.executeMode === 'full' || body.executeMode === 'auto-edit'
        ? { executeMode: body.executeMode }
        : {}),
      ...(selection ? { selection } : {}),
      ...(typeof body.feedback === 'string' ? { feedback: body.feedback } : {}),
    },
  }
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
  return allPresetFeatures(enabled)
}

/** Shipped presets, mirroring `denia_core::preset::builtin_presets`. */
function builtinPresetRows(): AgentPresetRow[] {
  return [
    {
      id: 'standard',
      name: '标准模式',
      description: '功能完整的编码 Agent:文件读写、Shell、检索、计划、目标、子代理与后台任务。',
      hasPersona: false,
      features: allFeatures(true),
    },
    {
      id: 'creator',
      name: '创造模式',
      description: '让 Agent 帮你创建新预设:通过提问收集 persona、工具面与功能开关,直接落盘可用的 preset.yml。',
      hasPersona: true,
      features: allFeatures(true),
    },
    {
      id: 'minimal',
      name: '极简模式',
      description: '只有持久 shell 的极简 Agent:系统提示一句话,无检索、记忆、计划与委派。',
      tools: ['bash'],
      hasPersona: true,
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

function lastSelectionOf(events: Envelope[], config: AppConfig): ModelSelection {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.type === 'request-context') {
      return { provider: event.provider, model: event.model }
    }
    if (event.type === 'request-header') {
      return {
        provider: event.header.config.provider,
        model: event.header.config.model,
        ...(event.header.config.reasoningEffort
          ? { reasoningEffort: event.header.config.reasoningEffort }
          : {}),
      }
    }
  }
  return resolveDefault(config)
}

function previewFingerprint(qualifiedId: string, tools: string[], instructions: string): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const text = `${qualifiedId}\x01${tools.join(',')}\x01${instructions}`
  for (const byte of Buffer.from(text, 'utf8')) {
    hash ^= BigInt(byte)
    hash = (hash * prime) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, '0')
}

function subagentPolicyConcurrency(home: string): number {
  const document = loadSettings(home)
  const section = document?.['subagent-policy']
  if (!isRecord(section)) return 8
  const value = section.maxConcurrentRuns
  if (typeof value !== 'number' || !Number.isInteger(value)) return 8
  return Math.max(1, Math.min(64, value))
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