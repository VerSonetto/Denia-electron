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

import { BrowserManager } from '../browser/manager.ts'
import { createBrowserTool } from '../tools/browser.ts'
import { SessionDriver } from '../agent/loop.ts'
import { CompletionLifecycle } from '../agent/lifecycle.ts'
import type { ApprovalBridge } from '../agent/gate.ts'
import { createModelReviewer } from '../agent/reviewer.ts'
import type { Reviewer } from '../agent/reviewer.ts'
import { RemoteRuntime, decideAccess, isBlockedForRemote, type AccessDecision } from './remote.ts'
import { handleRemoteApi } from './remote-api.ts'
import { Updater } from './update.ts'
import {
  findProvider,
  loadConfig,
  resolveDefault,
  resolveHome,
} from '../config.ts'
import { ExecPolicy } from '../core/exec-policy.ts'
import { streamFor } from '../llm/index.ts'
import type { SessionHeader } from '../core/wire.ts'
import { errorMessage } from '../core/util.ts'
import { UsageIndex } from '../session/usage.ts'
import { SessionStore } from '../session/store.ts'
import { FileHistoryStore } from '../session/file-history.ts'
import { GoalStore } from '../goal/store.ts'
import { GoalRuntime } from '../goal/runtime.ts'
import { ToolRegistry } from '../tools/index.ts'
import { ServerApprovalBridge } from './approval-bridge.ts'
import { HostServices } from './services.ts'
import { SkillTool } from '../tools/skill.ts'
import { JOB_TOOL_NAMES } from '../tools/jobs.ts'
import { JOB_OUTPUT_CAP, JobManager } from '../jobs/manager.ts'
import { McpManager } from '../mcp/manager.ts'
import { loadMcpSettings } from '../mcp/settings.ts'
import { ProjectStore } from '../project/store.ts'
import type { ProjectRecord } from '../project/store.ts'
import { ProfileStore } from '../subagents/profiles.ts'
import { SubagentRuntime, subagentCapabilityNames } from '../subagents/runtime.ts'
import { GlobalEventHub } from './events.ts'
import { subagentPolicyConcurrency } from './helpers.ts'
import {
  apiError,
  isLoopbackHost,
  json,
  notImplemented,
  readJson,
  safeDecode,
} from './http.ts'
import { handleIntegrationsApi } from './routes/integrations.ts'
import { handleMcpApi } from './routes/mcp.ts'
import { handleSessionsApi } from './routes/sessions.ts'
import { handleSettingsApi } from './routes/settings.ts'
import { handleSkillsApi } from './routes/skills.ts'
import { handleSubagentsApi } from './routes/subagents.ts'
import { handleWorkspaceApi } from './routes/workspace.ts'
import { serveStatic } from './static.ts'

/** 远程设备在配对前必须能访问的端点:查状态、兑换配对码、退出。其余一律要令牌。 */
const REMOTE_PUBLIC_PATHS = new Set([
  '/api/remote/status',
  '/api/remote/redeem',
  '/api/remote/logout',
])

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
  /** Test seam: substitute the browser hub (null = no browser tool). */
  browser?: BrowserManager | null
  /** Root for projects created without an explicit directory. */
  projectsRoot?: string
}

export interface Host {
  server: http.Server
  home: string
  port: number
  baseUrl: string
  store: SessionStore
  driver: SessionDriver
  /** Cross-session token usage fold; the usage page reads it directly. */
  usage: UsageIndex
  /** 远程访问的设备台账与配对状态；测试与设置页都会读它。 */
  remote: RemoteRuntime
  /** Project registry; tests and the settings pages read it. */
  projects: ProjectStore
  close(): Promise<void>
}

export async function startHost(options: HostOptions = {}): Promise<Host> {
  const home = options.home ?? resolveHome()
  // Launching GUI apps only makes sense for the machine the host runs on.
  const localOnly = isLoopbackHost(options.host ?? '127.0.0.1')
  fs.mkdirSync(home, { recursive: true })
  // 主监听端口先按配置估一个值,真正绑定后再回填 ephemeral 端口的实际值。
  let boundPort = options.port ?? Number(process.env.DENIA_PORT ?? 43655)
  const remote = new RemoteRuntime({
    home,
    port: () => boundPort,
    bindHost: () => options.host ?? '127.0.0.1',
  })
  const webDir = options.webDir ?? path.resolve(import.meta.dirname, '..', '..', '..', 'web', 'dist')
  const updater = new Updater({
    currentVersion: options.version ?? '0.0.0',
    repository: UPDATE_REPOSITORY,
    downloadDir: path.join(home, 'updates'),
  })

  let config = loadConfig(home)
  const store = new SessionStore(home)
  const usage = new UsageIndex(store.sessionsDir)
  const fileHistory = new FileHistoryStore(home)
  const registry = ToolRegistry.builtin()
  registry.register(new SkillTool(home))
  const browser = options.browser === undefined ? new BrowserManager({ home }) : options.browser
  if (browser) registry.register(createBrowserTool(browser))
  const projects = new ProjectStore(home, { ...(options.projectsRoot ? { managedRoot: options.projectsRoot } : {}) })
  const projectOfHeader = (header: SessionHeader): ProjectRecord =>
    projects.get(header.project_id) ??
    projects.projectForPath(header.cwd) ??
    projects.default
  const rootsOfHeader = (header: SessionHeader): string[] =>
    projects.rootsOf(projectOfHeader(header), header.cwd)
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
  let hub: GlobalEventHub
  const broadcast = (event: { type: string; [key: string]: unknown }): void => {
    hub.broadcast(event)
  }

  /** Child sessions inherit the parent's project, like the Rust host. */
  const attachToParentProjects = (childId: string, parentId: string): void => {
    const parent = store.header(parentId)
    if (!parent) return
    const project =
      projects.get(parent.project_id) ??
      projects.projectForPath(parent.cwd) ??
      projects.default
    if (projects.attachSession(project.id, childId)) projects.save()
    broadcast({ type: 'sessions-updated' })
  }

  const detachFromProjects = (childId: string): void => {
    if (projects.detachSession(childId)) projects.save()
    broadcast({ type: 'sessions-updated' })
  }

  /**
   * Give every session a project: legacy logs may predate `project_id`, and
   * legacy sessions imported from before projects have no membership.
   */
  const reconcileProjectSessions = (): void => {
    let changed = false
    for (const summary of store.list()) {
      if (!summary.cwd) continue
      const project =
        projects.get(summary.project_id) ??
        projects.projectForPath(summary.cwd) ??
        projects.default
      if (projects.attachSession(project.id, summary.id)) changed = true
      if (summary.project_id !== project.id) {
        store.updateHeader(summary.id, { project_id: project.id })
        changed = true
      }
    }
    if (changed) projects.save()
  }
  reconcileProjectSessions()

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
  hub = new GlobalEventHub(runningSessionIds)

  // —— MCP + subagents ——
  const mcp = new McpManager(registry.names())
  let mcpSettings = loadMcpSettings(home)
  let mcpReady = mcp.reload(mcpSettings.servers).catch((error: unknown) => {
    console.error('[denia] MCP 初始化失败:', errorMessage(error))
  })
  const reloadMcp = async (): Promise<void> => {
    mcpSettings = loadMcpSettings(home)
    mcpReady = mcp.reload(mcpSettings.servers)
    await mcpReady
  }
  const profiles = new ProfileStore(home)
  // One queue for both producers: a settled child and a finished background
  // job are the same kind of completion. The lifecycle persists them as
  // `agent-inbox` first and only promotes them at an action boundary.
  const completions = new CompletionLifecycle({
    store,
    startTurn: (sessionId) => driver.startTurn(sessionId, '', { continueOnly: true }),
    isRunning: (sessionId) => driver.isRunning(sessionId),
  })
  const subagents = new SubagentRuntime(store, profiles, {
    startTurn: (sessionId, prompt, turnOptions) =>
      driver.startTurn(sessionId, prompt, turnOptions ?? {}),
    cancel: (sessionId) => driver.cancel(sessionId),
    isRunning: (sessionId) => driver.isRunning(sessionId),
    append: (sessionId, event) => store.append(sessionId, event),
    permissionStateOf: (sessionId) => driver.permissionStateOf(sessionId),
  }, {
    maxConcurrentRuns: subagentPolicyConcurrency(home),
    childCreated: attachToParentProjects,
    childRemoved: detachFromProjects,
    definitionsChanged: () => broadcast({ type: 'subagents-updated' }),
    config: () => config,
    completions,
  })
  const jobs = new JobManager({
    onDone: (job) => {
      let text = `[后台任务完成]\n${JSON.stringify(jobs.peek(job.id, job.owner))}`
      if (text.length > JOB_OUTPUT_CAP) {
        text = `${Array.from(text).slice(0, JOB_OUTPUT_CAP).join('')}\n（后台任务结果已截断，完整输出请用 job_output 读取。）`
      }
      try {
        completions.push({
          id: `job:${job.id}`,
          target: job.owner,
          text,
          source: 'job-completed',
        })
        return true
      } catch {
        // The owning session is gone; the result stays readable while retained.
        return false
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
    projects,
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
        // 静态资源不设门:远程设备要能先把界面加载出来,才谈得上输入配对码。
        serveStatic(req, res, webDir, pathname)
        return
      }
      const access = decideAccess(remote, req, { requireToken: true })
      // 只在宿主机上有意义的能力,远程来源一律拒绝 —— 不靠 UI 藏。
      if (access.kind !== 'local' && isBlockedForRemote(pathname)) {
        apiError(res, 403, 'remote/blocked', '该能力只能在宿主机器上使用')
        return
      }
      if (access.kind === 'unauthorized' && !REMOTE_PUBLIC_PATHS.has(pathname)) {
        apiError(res, 401, 'remote/unauthorized', '需要先与宿主配对')
        return
      }
      await handleApi(req, res, pathname, url, access)
    } catch (error) {
      if (!res.headersSent) apiError(res, 500, 'internal', errorMessage(error))
      else if (!res.writableEnded) res.end()
    }
  }

  // —— 远程监听 ——
  //
  // 独立第二个 http.Server,与回环主监听共用同一个 handler:
  //   - 主监听保持 127.0.0.1 不变,桌面窗口不受任何影响;
  //   - 远程监听绑在 config.listenPort(默认主端口 + 1)上,开关即时生效,
  //     不需要重启进程,也不用把回环端口暴露出去。
  let remoteServer: http.Server | null = null
  let remoteListenError: string | null = null
  let remoteListenHost: string | null = null
  let remoteListenPort = 0

  const remoteListenerState = () => ({
    listening: remoteServer !== null,
    host: remoteListenHost,
    port: remoteListenPort,
    error: remoteListenError,
  })

  const stopRemoteListener = async (): Promise<void> => {
    const current = remoteServer
    remoteServer = null
    remoteListenHost = null
    remoteListenPort = 0
    if (!current) return
    // SSE 是常驻连接,close() 会一直等下去,必须先掐断。
    current.closeAllConnections?.()
    await new Promise<void>((resolve) => current.close(() => resolve()))
  }

  const startRemoteListener = async (): Promise<void> => {
    await stopRemoteListener()
    const config = remote.readConfig()
    const host = config.bindHost ?? '0.0.0.0'
    const port = config.listenPort
    const next = http.createServer((req, res) => {
      void handler(req, res)
    })
    next.requestTimeout = 0
    try {
      await new Promise<void>((resolve, reject) => {
        next.once('error', reject)
        next.listen(port, host, () => {
          next.off('error', reject)
          resolve()
        })
      })
    } catch (error) {
      remoteListenError = errorMessage(error)
      throw error
    }
    remoteServer = next
    remoteListenHost = host
    remoteListenPort = port
    remoteListenError = null
  }

  const handleApi = async (
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    url: URL,
    access: AccessDecision,
  ): Promise<void> => {
    const method = req.method ?? 'GET'

    // —— remote access ——
    if (await handleRemoteApi(req, res, pathname, url, access, {
      remote,
      json,
      apiError,
      readJson,
      listener: () => remoteListenerState(),
      startListener: startRemoteListener,
      stopListener: stopRemoteListener,
      serverLabel: () => os.hostname() || 'Denia',
    })) return

    // —— permissions ——
    if (pathname === '/api/permissions/catalog' && method === 'GET') {
      json(res, 200, {
        modes: ['read-only', 'project-write', 'approve-for-me', 'full-access'],
        default: 'project-write',
      })
      return
    }

    if (pathname === '/api/sessions' || pathname.startsWith('/api/sessions/')) {
      await handleSessionsApi({
        home,
        store,
        driver,
        projects,
        subagents,
        jobs,
        completions,
        goalStore,
        fileHistory,
        approvalChannel,
        goalRuntime,
        config: () => config,
        broadcast,
        runningSessionIds,
        rootsOfHeader,
      }, req, res, pathname, url, method)
      return
    }

    // —— global events ——
    if (pathname === '/api/events' && method === 'GET') {
      hub.handleSse(req, res)
      return
    }
    if (pathname === '/api/events/poll' && method === 'GET') {
      await hub.handlePoll(res, url)
      return
    }

    if (await handleWorkspaceApi({
      projects,
      store,
      driver,
      subagents,
      jobs,
      completions,
      goalStore,
      fileHistory,
      broadcast,
    }, req, res, pathname, url, method)) return

    if (await handleSettingsApi({
      home,
      config: () => config,
      setConfig: (next) => { config = next },
      mcp,
      subagents,
      describedToolNames,
      reloadMcp,
      broadcast,
    }, req, res, pathname, url, method)) return

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

    if (await handleMcpApi({
      home,
      mcp,
      servers: () => mcpSettings.servers,
      ready: () => mcpReady,
      reloadMcp,
      broadcast,
    }, req, res, pathname, method)) return

    if (await handleSubagentsApi({
      home,
      store,
      driver,
      profiles,
      subagents,
      projects,
      config: () => config,
      describedToolNames,
      rootsOfHeader,
      broadcast,
    }, req, res, pathname, url, method)) return

    if (await handleSkillsApi({
      home,
      projects,
      broadcast,
    }, req, res, pathname, url, method)) return

    if (await handleIntegrationsApi({
      localOnly,
      browser,
      updater,
      usage,
      config: () => config,
      broadcast,
    }, req, res, pathname, url, method)) return

    notImplemented(res, pathname)
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
  boundPort = actualPort
  instanceBase = `http://${host}:${actualPort}`

  // 上次退出时远程是开着的就自动恢复监听。失败不阻断启动:桌面端照常可用,
  // 原因通过 /api/remote/status 的 listenerError 暴露给设置页。
  if (remote.readConfig().enabled) {
    try {
      await startRemoteListener()
    } catch (error) {
      console.error('[denia] 远程监听启动失败:', errorMessage(error))
    }
  }

  return {
    server,
    home,
    port: actualPort,
    baseUrl: `http://${host}:${actualPort}`,
    store,
    driver,
    usage,
    remote,
    projects,
    async close() {
      await stopRemoteListener()
      hub.close()
      await browser?.dispose()
      subagents.close()
      completions.close()
      await mcp.shutdownAll()
      driver.dispose()
      for (const id of store.list().map((summary) => summary.id)) {
        store.flush(id)
      }
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
