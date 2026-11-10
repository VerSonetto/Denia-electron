// 浏览器中枢:Playwright(Patchright)驱动本机 Chrome/Edge,CDP 会话补深度能力。
//
// 分工与 js-reverse-mcp 一致:
// - 页面生命周期、导航、交互、截图、请求/控制台列表都走 Playwright 事件;
// - 调试器、网络 initiator、screencast 走页级 CDP 会话,且按需懒启用,
//   导航期间不额外开域。
//
// 命令面同时服务两个调用方:模型工具(`browser`)与控制台侧栏(/api/browser/*),
// 两者共用同一个实例,不存在两份状态。

import fs from 'node:fs'
import path from 'node:path'

import { chromium } from '@zhizhuodemao/patchright'
import type {
  BrowserContext,
  CDPSession,
  Dialog,
  Frame,
  Page,
  Request,
  Response,
  WebSocket,
} from '@zhizhuodemao/patchright'

import * as ax from './ax.ts'
import { detectBrowserExecutable, launchSpec, probeUserAgent, type BrowserLaunchSpec } from './chrome.ts'
import { ConsoleLog } from './console.ts'
import { TabDebugger } from './debugger.ts'
import { keyGap, scrollStepDelay, scrollSteps } from './humanize.ts'
import { NetworkRecorder, SocketRecorder, initiatorFrames } from './network.ts'
import {
  auditFingerprint,
  buildProfile,
  COLLECT_FINGERPRINT,
  stealthArgs,
  stealthScript,
  type StealthProfile,
} from './stealth.ts'
import type { NetworkEntry } from './network.ts'
import {
  bool,
  errorOutcome,
  num,
  str,
  strList,
  type BrowserEvent,
  type CommandOutcome,
  type TabInfo,
} from './types.ts'

type Command = Record<string, unknown>
type CommandResult = Partial<Omit<CommandOutcome, 'ok' | 'elapsedMs'>>

const TAB_LIMIT = 32
const DEFAULT_NAV_TIMEOUT = 20_000
const DEFAULT_ACTION_TIMEOUT = 10_000
const IDLE_RELEASE_MS = 300_000
const IDLE_TICK_MS = 10_000
const MAX_BODY_ENTRIES = 300

function friendlyLaunchError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const first = message.split('\n')[0] ?? message
  if (/ProcessSingleton|SingletonLock|already in use|already running/i.test(message)) {
    return `浏览器 profile 已被另一个实例占用(可能是另一个 Denia 窗口或残留进程):${first}`
  }
  return `启动浏览器失败:${first}`
}

class CommandFailure extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

function fail(code: string, message: string): never {
  throw new CommandFailure(code, message)
}

interface Tab {
  tabId: string
  page: Page
  session: CDPSession
  network: NetworkRecorder
  sockets: SocketRecorder
  console: ConsoleLog
  debugger: TabDebugger
  refs: Map<string, number>
  dialog: Dialog | null
  frame: Frame | null
  screencast: boolean
  networkCdp: boolean
  bodies: Map<number, { request: Request; response?: Response }>
  requestIds: WeakMap<Request, number>
  socketIds: WeakMap<WebSocket, number>
  disposing: boolean
}

export interface BrowserManagerOptions {
  home: string
}

export class BrowserManager {
  readonly #home: string
  readonly #listeners = new Set<(event: BrowserEvent) => void>()
  readonly #tabs = new Map<string, Tab>()
  readonly #order: string[] = []
  readonly #pendingPages = new WeakMap<Page, Promise<void>>()
  readonly #stealthEnabled: boolean
  readonly #humanize: boolean
  #stealth: StealthProfile | null = null
  #context: BrowserContext | null = null
  #launching: Promise<BrowserContext> | null = null
  #activeTabId: string | null = null
  #nextTabId = 1
  #queue: Promise<unknown> = Promise.resolve()
  #lastActivity = Date.now()
  #idleTimer: ReturnType<typeof setInterval> | undefined
  #closing = false
  #visualMode = false

  constructor(options: BrowserManagerOptions) {
    this.#home = options.home
    // 默认开启:既然要驱动真实浏览器,就没有理由再把自己标成自动化。
    // `DENIA_BROWSER_STEALTH=0` / `DENIA_BROWSER_HUMANIZE=0` 可关掉做对照。
    this.#humanize = process.env.DENIA_BROWSER_HUMANIZE?.trim() !== '0'
    this.#stealthEnabled = process.env.DENIA_BROWSER_STEALTH?.trim() !== '0'
  }

  subscribe(listener: (event: BrowserEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  requestVisualMode(): void {
    if (this.#visualMode) return
    this.#visualMode = true
    this.#emit({ type: 'visual-mode-requested' })
  }

  get running(): boolean {
    return this.#context !== null
  }

  async state(): Promise<Record<string, unknown>> {
    const tabs = await this.#tabInfos()
    const dialogs: { tabId: string; dialog: { type: string; message: string } }[] = []
    for (const tab of this.#tabs.values()) {
      if (tab.dialog) {
        dialogs.push({ tabId: tab.tabId, dialog: { type: tab.dialog.type(), message: tab.dialog.message() } })
      }
    }
    return { running: this.running, activeTabId: this.#activeTabId ?? null, tabs, dialogs }
  }

  /** Execute one command; serialized so page/CDP state never interleaves. */
  execute(command: Command): Promise<CommandOutcome> {
    const started = Date.now()
    const run = async (): Promise<CommandOutcome> => {
      const method = str(command, 'method')?.trim() ?? ''
      if (method === '') return errorOutcome('invalid-argument', '缺少 method', Date.now() - started)
      this.#lastActivity = Date.now()
      if (bool(command, 'visualMode') === true) this.requestVisualMode()
      try {
        const result = await this.#dispatch(method, command)
        return { ok: true, ...result, elapsedMs: Date.now() - started }
      } catch (error) {
        if (error instanceof CommandFailure) {
          return errorOutcome(error.code, error.message, Date.now() - started)
        }
        if (this.#closing) {
          return errorOutcome('cancelled', '浏览器已回收', Date.now() - started)
        }
        return errorOutcome('failed', error instanceof Error ? error.message : String(error), Date.now() - started)
      }
    }
    const chained = this.#queue.then(run, run)
    this.#queue = chained.catch(() => undefined)
    return chained
  }

  async shutdown(): Promise<boolean> {
    const context = this.#context
    if (!context) return false
    this.#closing = true
    this.#context = null
    this.#launching = null
    this.#clearTabs()
    this.#stopIdleWatchdog()
    try {
      await context.close({ reason: 'denia browser shutdown' })
    } catch {
      /* 进程可能已经退出 */
    }
    this.#closing = false
    this.#visualMode = false
    this.#emit({ type: 'exited' })
    return true
  }

  async dispose(): Promise<void> {
    await this.shutdown()
  }

  /* ---------------- 生命周期 ---------------- */

  #spec(): BrowserLaunchSpec {
    return launchSpec(this.#home)
  }

  /**
   * 按当前浏览器探一次真实 UA,再据此构造伪装档位。
   *
   * 不能用写死的版本号:浏览器升级后 UA 字符串与 `userAgentData.brands`
   * 会互相矛盾,那比保留无头标记更容易被判定为伪造。探测失败时退回
   * 保守配置,不阻断启动。
   */
  async #buildStealth(spec: BrowserLaunchSpec): Promise<StealthProfile> {
    let userAgent = ''
    try {
      userAgent = (await probeUserAgent(spec.executable)) ?? ''
    } catch {
      userAgent = ''
    }
    // 探测失败时保留浏览器默认 UA:与其编一个,不如不加标记地沿用。
    return buildProfile({
      userAgent,
      viewport: spec.viewport,
    })
  }

  async #ensureContext(): Promise<BrowserContext> {
    if (this.#context) return this.#context
    if (this.#launching) return this.#launching
    const launch = this.#start()
    this.#launching = launch
    try {
      let context: BrowserContext
      try {
        context = await launch
      } catch (error) {
        throw new Error(friendlyLaunchError(error))
      }
      this.#context = context
      this.#startIdleWatchdog()
      return context
    } finally {
      if (this.#launching === launch) this.#launching = null
    }
  }

  async #start(): Promise<BrowserContext> {
    const spec = this.#spec()
    fs.mkdirSync(spec.profileDir, { recursive: true })
    fs.mkdirSync(spec.artifactsDir, { recursive: true })
    const stealth = this.#stealthEnabled ? await this.#buildStealth(spec) : null
    this.#stealth = stealth
    const context = await chromium.launchPersistentContext(spec.profileDir, {
      executablePath: spec.executable,
      // stealth 模式固定用 `--headless=new`(而不是 Playwright 的 headless
      // 开关):后者会让窗口/屏幕信息整体退化。有头模式则走真实窗口。
      headless: stealth ? false : spec.headless,
      viewport: stealth ? spec.viewport : spec.headless ? spec.viewport : null,
      ignoreHTTPSErrors: true,
      chromiumSandbox: true,
      ...(stealth
        ? {
            deviceScaleFactor: stealth.deviceScaleFactor,
            locale: stealth.locale,
            // Playwright 会把 UA 与 UA-CH 一起改;直接给 `--user-agent`
            // 不会同步 UA-CH,两者对不上反而更可疑。
            userAgent: stealth.userAgent,
          }
        : { deviceScaleFactor: 1 }),
      args: stealth
        ? stealthArgs(stealth)
        : [
            '--test-type',
            '--hide-crash-restore-bubble',
            '--no-first-run',
            '--no-default-browser-check',
            `--window-size=${spec.viewport.width},${spec.viewport.height}`,
          ],
    })
    // 先落引用再注册初始页面:attachPage 依赖它,持久 profile 恢复的 tab
    // 也要登记,否则面板与模型都看不到这些页面。
    this.#context = context
    context.on('page', (page) => {
      void this.#registerPage(page).catch(() => undefined)
    })
    context.on('close', () => {
      if (this.#context !== context) return
      this.#context = null
      this.#clearTabs()
      this.#stopIdleWatchdog()
      this.#emit({ type: 'exited' })
    })
    for (const page of context.pages()) {
      await this.#registerPage(page).catch(() => undefined)
    }
    if (context.pages().length === 0) {
      const page = await context.newPage()
      await this.#registerPage(page)
    }
    return context
  }

  #stopIdleWatchdog(): void {
    if (this.#idleTimer) clearInterval(this.#idleTimer)
    this.#idleTimer = undefined
  }

  #startIdleWatchdog(): void {
    if (this.#idleTimer) return
    const configured = Number(process.env.DENIA_BROWSER_IDLE_SECS ?? '')
    const idleMs = Number.isFinite(configured) && configured >= 0 ? configured * 1000 : IDLE_RELEASE_MS
    if (idleMs === 0) return
    this.#idleTimer = setInterval(() => {
      if (!this.running) return
      if (Date.now() - this.#lastActivity < idleMs) return
      void this.shutdown()
    }, Math.min(IDLE_TICK_MS, idleMs))
    this.#idleTimer.unref?.()
  }

  #clearTabs(): void {
    for (const tab of this.#tabs.values()) tab.disposing = true
    this.#tabs.clear()
    this.#order.length = 0
    this.#activeTabId = null
  }

  #emit(event: BrowserEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event)
      } catch {
        /* 单个订阅者出错不影响其它订阅者 */
      }
    }
  }

  /* ---------------- tab 注册 ---------------- */

  async #registerPage(page: Page): Promise<void> {
    if (page.isClosed()) return
    for (const tab of this.#tabs.values()) if (tab.page === page) return
    const pending = this.#pendingPages.get(page)
    if (pending) return pending
    const task = this.#attachPage(page).finally(() => {
      this.#pendingPages.delete(page)
    })
    this.#pendingPages.set(page, task)
    return task
  }

  async #attachPage(page: Page): Promise<void> {
    const context = this.#context
    if (!context) return
    if (this.#tabs.size >= TAB_LIMIT) {
      await page.close().catch(() => undefined)
      fail('tab-limit', `标签页数量已达上限(${TAB_LIMIT})`)
    }
    const session = await context.newCDPSession(page)
    // 注入必须在这一页第一个导航之前挂上:页级 CDP 的新文档脚本对
    // 「已经开始的导航」不生效,而持久 profile 恢复的标签页往往已经加载过。
    await this.#injectStealth(session)
    const tabId = `t${this.#nextTabId++}`
    const tab: Tab = {
      tabId,
      page,
      session,
      network: new NetworkRecorder(),
      sockets: new SocketRecorder(),
      console: new ConsoleLog(),
      debugger: new TabDebugger((method, params) => session.send(method as never, params as never) as Promise<Record<string, unknown>>),
      refs: new Map(),
      dialog: null,
      frame: null,
      screencast: false,
      networkCdp: false,
      bodies: new Map(),
      requestIds: new WeakMap(),
      socketIds: new WeakMap(),
      disposing: false,
    }
    this.#tabs.set(tabId, tab)
    this.#order.push(tabId)
    if (this.#activeTabId === null) this.#activeTabId = tabId
    this.#wirePage(tab)
    this.#emit({ type: 'tabs-changed' })
  }

  /**
   * 挂上页级新文档脚本。
   *
   * 为什么不用 `context.addInitScript`:Patchright 会把它丢弃 —— 实测在
   * 主世界完全看不到影子。页级 CDP 才是我们自己的通道。
   *
   * 新文档脚本只对「注入之后开始的导航」生效,而持久 profile 恢复的标签页
   * 往往已经加载完了。这里再补一次即时求值,让已存在的文档也拿到补丁;
   * 补丁自身逐项比较现值,重复执行是幂等的。
   */
  async #injectStealth(session: CDPSession): Promise<void> {
    const stealth = this.#stealth
    if (!stealth) return
    const source = stealthScript(stealth)
    try {
      await session.send('Page.enable')
      await session.send('Page.addScriptToEvaluateOnNewDocument', { source })
    } catch {
      // 注入失败不应该拦住页面注册;最坏情况只是回到无伪装状态。
    }
    try {
      await session.send('Runtime.evaluate', { expression: source })
    } catch {
      // about:blank 等还没有可求值上下文的情况,交给新文档脚本处理。
    }
  }

  #unregister(tab: Tab): void {
    if (tab.disposing) return
    tab.disposing = true
    this.#tabs.delete(tab.tabId)
    const index = this.#order.indexOf(tab.tabId)
    if (index >= 0) this.#order.splice(index, 1)
    if (this.#activeTabId === tab.tabId) {
      this.#activeTabId = this.#order[0] ?? null
    }
    this.#emit({ type: 'tabs-changed' })
    if (this.#tabs.size === 0 && this.running) {
      void this.shutdown()
    }
  }

  #wirePage(tab: Tab): void {
    const { page, session } = tab
    page.on('console', (message) => {
      const location = message.location()
      tab.console.push({
        type: message.type(),
        text: message.text(),
        location: location.url ? `${location.url}:${location.line + 1}` : undefined,
      })
    })
    page.on('pageerror', (error) => {
      tab.console.push({ type: 'error', text: error.message, location: error.stack?.split('\n')[0] })
    })
    page.on('dialog', (dialog) => {
      tab.dialog = dialog
      this.#emit({ type: 'dialog-opened', tabId: tab.tabId, kind: dialog.type(), message: dialog.message() })
    })
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return
      tab.refs.clear()
      tab.debugger.clearScripts()
      this.#emit({ type: 'navigated', tabId: tab.tabId, url: frame.url(), title: '' })
      this.#emit({ type: 'tabs-changed' })
    })
    page.on('request', (request) => {
      const id = tab.network.start({
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        postData: request.postData() ?? undefined,
        frameUrl: request.frame()?.url(),
      })
      tab.requestIds.set(request, id)
      this.#rememberBody(tab, id, request)
    })
    page.on('response', (response) => {
      const id = tab.requestIds.get(response.request())
      if (id === undefined) return
      void response
        .allHeaders()
        .then(() => undefined)
        .catch(() => undefined)
      tab.network.response(id, {
        status: response.status(),
        statusText: response.statusText(),
        mimeType: response.headers()['content-type'],
      })
      const entry = tab.bodies.get(id)
      if (entry) entry.response = response
    })
    page.on('requestfinished', (request) => {
      const id = tab.requestIds.get(request)
      if (id !== undefined) tab.network.finish(id)
    })
    page.on('requestfailed', (request) => {
      const id = tab.requestIds.get(request)
      if (id !== undefined) tab.network.finish(id, { failed: request.failure()?.errorText })
    })
    page.on('websocket', (socket) => {
      const id = tab.sockets.create(socket.url())
      tab.socketIds.set(socket, id)
      socket.on('framesent', (data) => {
        tab.sockets.frame(id, 'sent', String(data.payload))
      })
      socket.on('framereceived', (data) => {
        tab.sockets.frame(id, 'received', String(data.payload))
      })
      socket.on('close', () => {
        tab.sockets.close(id)
      })
    })
    page.on('close', () => {
      this.#unregister(tab)
    })
    session.on('Page.javascriptDialogClosed', () => {
      if (!tab.dialog) return
      tab.dialog = null
      this.#emit({ type: 'dialog-closed', tabId: tab.tabId })
    })
    session.on('Page.screencastFrame', (params) => {
      const data = typeof params.data === 'string' ? params.data : ''
      if (data === '') return
      const metadata = params.metadata
      this.#emit({
        type: 'frame',
        tabId: tab.tabId,
        data,
        viewport: {
          width: Math.round(metadata?.deviceWidth ?? 0),
          height: Math.round(metadata?.deviceHeight ?? 0),
        },
      })
      void session
        .send('Page.screencastFrameAck', { sessionId: params.sessionId })
        .catch(() => undefined)
    })
    session.on('Network.requestWillBeSent', (params) => {
      if (!tab.networkCdp) return
      const request = params.request
      if (!request) return
      tab.network.recordInitiator(request.url, request.method, {
        type: params.initiator?.type,
        frames: initiatorFrames(params.initiator),
      })
    })
    session.on('Debugger.scriptParsed', (params) => {
      tab.debugger.handle('Debugger.scriptParsed', params as Record<string, unknown>)
    })
    session.on('Debugger.paused', (params) => {
      tab.debugger.handle('Debugger.paused', params as Record<string, unknown>)
    })
    session.on('Debugger.resumed', () => {
      tab.debugger.handle('Debugger.resumed', {})
    })
    session.on('Debugger.breakpointResolved', (params) => {
      tab.debugger.handle('Debugger.breakpointResolved', params as Record<string, unknown>)
    })
  }

  #rememberBody(tab: Tab, id: number, request: Request): void {
    tab.bodies.set(id, { request })
    while (tab.bodies.size > MAX_BODY_ENTRIES) {
      const oldest = tab.bodies.keys().next().value
      if (oldest === undefined) break
      tab.bodies.delete(oldest)
    }
  }

  /* ---------------- 命令分发 ---------------- */

  async #dispatch(method: string, command: Command): Promise<CommandResult> {
    switch (method) {
      case 'shutdownBrowser':
        return { value: { released: await this.shutdown(), running: false } }
      case 'list':
        return { value: { running: this.running }, tabs: await this.#tabInfos() }
      case 'getState':
        await this.#ensureContext()
        return { state: await this.state() }
      case 'newTab':
        return this.#newTab(command)
      case 'activate':
        return this.#activate(command)
      case 'close':
        return this.#closeTab(command)
      case 'selectPage':
        return this.#selectPage(command)
      case 'frames':
        return this.#frames(command)
      case 'selectFrame':
        return this.#selectFrame(command)
      case 'navigate':
        return this.#navigate(command)
      case 'back':
      case 'forward':
      case 'reload':
        return this.#history(method, command)
      case 'viewportSet':
      case 'viewportReset':
        return this.#viewport(method, command)
      case 'screenshot':
        return this.#screenshot(command)
      case 'snapshot':
        return this.#snapshot(command)
      case 'click':
      case 'clickElement':
        return this.#click(method, command)
      case 'fill':
        return this.#fill(command)
      case 'type':
        return this.#type(command)
      case 'press':
        return this.#press(command)
      case 'scroll':
        return this.#scroll(command)
      case 'hover':
        return this.#hover(command)
      case 'select':
        return this.#select(command)
      case 'check':
        return this.#check(command)
      case 'drag':
        return this.#drag(command)
      case 'elementInfo':
        return this.#elementInfo(command)
      case 'evaluate':
        return this.#evaluate(command)
      case 'waitFor':
        return this.#waitFor(command)
      case 'getDialog':
        return this.#getDialog(command)
      case 'handleDialog':
        return this.#handleDialog(command)
      case 'startScreencast':
      case 'stopScreencast':
        return this.#screencast(method, command)
      case 'networkList':
        return this.#networkList(command)
      case 'networkDetail':
        return this.#networkDetail(command)
      case 'networkGetBody':
        return this.#networkBody(command)
      case 'getRequestInitiator':
        return this.#requestInitiator(command)
      case 'clearNetworkRequests':
        return this.#clearNetwork(command)
      case 'listConsoleMessages':
        return this.#consoleMessages(command)
      case 'websocketMessages':
        return this.#socketMessages(command)
      case 'listScripts':
        return this.#listScripts(command)
      case 'getScriptSource':
        return this.#scriptSource(command)
      case 'saveScriptSource':
        return this.#saveScriptSource(command)
      case 'searchInSources':
        return this.#searchSources(command)
      case 'setBreakpointOnText':
        return this.#setBreakpointOnText(command)
      case 'breakOnXhr':
        return this.#breakOnXhr(command)
      case 'removeBreakpoint':
        return this.#removeBreakpoint(command)
      case 'listBreakpoints':
        return this.#listBreakpoints(command)
      case 'getPausedInfo':
        return this.#pausedInfo(command)
      case 'pauseOrResume':
        return this.#pauseOrResume(command)
      case 'step':
        return this.#step(command)
      case 'clearSiteData':
        return this.#clearSiteData(command)
      case 'fingerprint':
        return this.#fingerprint(command)
      default:
        fail('invalid-argument', `未知浏览器命令:${method}`)
    }
  }

  /* ---------------- tab 定位 ---------------- */

  async #tabOf(command: Command, options: { require?: boolean } = {}): Promise<Tab> {
    await this.#ensureContext()
    const tabId = str(command, 'tabId')
    if (tabId !== undefined) {
      const tab = this.#tabs.get(tabId)
      if (!tab) fail('not-found', `标签页不存在:${tabId}(用 list 查看当前标签页)`)
      return tab
    }
    if (this.#activeTabId) {
      const tab = this.#tabs.get(this.#activeTabId)
      if (tab) return tab
    }
    const first = this.#order[0]
    const tab = first ? this.#tabs.get(first) : undefined
    if (tab) return tab
    if (options.require === false) fail('not-found', '当前没有打开的标签页')
    const page = await (await this.#requireContext()).newPage()
    await this.#registerPage(page)
    const created = this.#order.at(-1)
    const createdTab = created ? this.#tabs.get(created) : undefined
    if (!createdTab) fail('failed', '创建标签页失败')
    this.#activeTabId = createdTab.tabId
    return createdTab
  }

  async #requireContext(): Promise<BrowserContext> {
    return this.#ensureContext()
  }

  async #tabInfos(): Promise<TabInfo[]> {
    const out: TabInfo[] = []
    for (const tabId of this.#order) {
      const tab = this.#tabs.get(tabId)
      if (!tab) continue
      let title = ''
      try {
        title = await tab.page.title()
      } catch {
        /* 页面已关闭 */
      }
      out.push({
        tabId: tab.tabId,
        url: tab.page.url(),
        title,
        active: tab.tabId === this.#activeTabId,
      })
    }
    return out
  }

  /* ---------------- 标签页与导航 ---------------- */

  async #newTab(command: Command): Promise<CommandResult> {
    const context = await this.#ensureContext()
    const url = str(command, 'url')
    if (url !== undefined && url !== '') this.#assertHttp(url)
    let page: Page | undefined
    if (url) {
      page = context.pages().find((candidate) => candidate.url() === 'about:blank')
    }
    page = page ?? (await context.newPage())
    await this.#registerPage(page)
    const tab = [...this.#tabs.values()].find((candidate) => candidate.page === page)
    if (!tab) fail('failed', '创建标签页失败')
    await tab.page.bringToFront()
    this.#activeTabId = tab.tabId
    if (url) await tab.page.goto(url, { waitUntil: 'domcontentloaded', timeout: DEFAULT_NAV_TIMEOUT })
    this.#emit({ type: 'tabs-changed' })
    return { value: { tabId: tab.tabId, url: tab.page.url() }, tabs: await this.#tabInfos() }
  }

  async #activate(command: Command): Promise<CommandResult> {
    const tabId = str(command, 'tabId')
    if (!tabId) fail('invalid-argument', 'activate 需要 tabId')
    const tab = this.#tabs.get(tabId)
    if (!tab) fail('not-found', `标签页不存在:${tabId}`)
    await tab.page.bringToFront()
    this.#activeTabId = tab.tabId
    this.#emit({ type: 'tabs-changed' })
    return { value: { tabId: tab.tabId, url: tab.page.url() }, tabs: await this.#tabInfos() }
  }

  async #closeTab(command: Command): Promise<CommandResult> {
    const tabId = str(command, 'tabId')
    if (!this.running) {
      return { value: { closed: tabId ?? null, running: false, note: '浏览器没有运行' } }
    }
    if (!tabId) {
      const active = this.#activeTabId ? this.#tabs.get(this.#activeTabId) : undefined
      if (!active) return { value: { closed: null, running: false } }
      await active.page.close().catch(() => undefined)
      return { value: { closed: active.tabId, running: this.running }, tabs: await this.#tabInfos() }
    }
    const tab = this.#tabs.get(tabId)
    if (!tab) fail('not-found', `标签页不存在:${tabId}`)
    await tab.page.close().catch(() => undefined)
    return { value: { closed: tabId, running: this.running }, tabs: await this.#tabInfos() }
  }

  async #selectPage(command: Command): Promise<CommandResult> {
    const index = num(command, 'pageIdx')
    if (index === undefined) return { tabs: await this.#tabInfos() }
    const tabId = this.#order[index]
    if (!tabId) fail('not-found', `没有第 ${index} 个标签页(共 ${this.#order.length} 个)`)
    const tab = this.#tabs.get(tabId)
    if (!tab) fail('not-found', `标签页不存在:${tabId}`)
    await tab.page.bringToFront()
    this.#activeTabId = tab.tabId
    this.#emit({ type: 'tabs-changed' })
    return { value: { pageIdx: index, tabId: tab.tabId, url: tab.page.url() }, tabs: await this.#tabInfos() }
  }

  async #frames(command: Command): Promise<CommandResult> {
    const tab = await this.#tabOf(command)
    const frames = tab.page.frames()
    const selected = this.#selectedFrame(tab)
    return {
      value: {
        frames: frames.map((frame, index) => ({
          frameIdx: index,
          url: frame.url(),
          name: frame.name(),
          depth: this.#frameDepth(frame),
          selected: frame === selected,
        })),
      },
    }
  }

  async #selectFrame(command: Command): Promise<CommandResult> {
    const tab = await this.#tabOf(command)
    const index = num(command, 'frameIdx')
    if (index === undefined) fail('invalid-argument', 'selectFrame 需要 frameIdx(0 = 主文档)')
    const frames = tab.page.frames()
    if (index < 0 || index >= frames.length) fail('invalid-argument', `frameIdx 越界:${index}(共 ${frames.length} 个 frame)`)
    tab.frame = index === 0 ? null : (frames[index] ?? null)
    const frame = this.#selectedFrame(tab)
    return { value: { frameIdx: index, url: frame.url(), name: frame.name() } }
  }

  #frameDepth(frame: Frame): number {
    let depth = 0
    let current = frame.parentFrame()
    while (current) {
      depth += 1
      current = current.parentFrame()
    }
    return depth
  }

  #selectedFrame(tab: Tab): Frame {
    if (tab.frame && !tab.frame.isDetached()) return tab.frame
    tab.frame = null
    return tab.page.mainFrame()
  }

  #assertHttp(url: string): void {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      fail('invalid-argument', `不是合法 URL:${url}`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      fail('invalid-argument', '只允许 http/https 地址')
    }
  }

  async #navigate(command: Command): Promise<CommandResult> {
    const url = str(command, 'url')
    if (!url) fail('invalid-argument', 'navigate 需要 url')
    this.#assertHttp(url)
    const tab = await this.#tabOf(command)
    const timeout = num(command, 'timeoutMs') ?? DEFAULT_NAV_TIMEOUT
    try {
      await tab.page.goto(url, { waitUntil: 'domcontentloaded', timeout })
    } catch (error) {
      const message = error instanceof Error ? error.message.split('\n')[0] ?? error.message : String(error)
      fail('navigation-failed', `导航失败:${message}`)
    }
    tab.debugger.clearScripts()
    tab.refs.clear()
    this.#emit({ type: 'navigated', tabId: tab.tabId, url: tab.page.url(), title: await tab.page.title().catch(() => '') })
    return { value: { url: tab.page.url(), title: await tab.page.title().catch(() => '') }, tabs: await this.#tabInfos() }
  }

  async #history(method: 'back' | 'forward' | 'reload', command: Command): Promise<CommandResult> {
    const tab = await this.#tabOf(command)
    const timeout = num(command, 'timeoutMs') ?? DEFAULT_NAV_TIMEOUT
    try {
      if (method === 'reload') {
        await tab.page.reload({ waitUntil: 'domcontentloaded', timeout })
      } else {
        const response = method === 'back'
          ? await tab.page.goBack({ waitUntil: 'domcontentloaded', timeout })
          : await tab.page.goForward({ waitUntil: 'domcontentloaded', timeout })
        if (response === null) {
          fail('precondition-failed', method === 'back' ? '没有可回退的历史' : '没有可前进的历史')
        }
      }
    } catch (error) {
      if (error instanceof CommandFailure) throw error
      fail('navigation-failed', `导航失败:${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
    }
    tab.debugger.clearScripts()
    tab.refs.clear()
    return { value: { url: tab.page.url(), title: await tab.page.title().catch(() => '') }, tabs: await this.#tabInfos() }
  }

  async #viewport(method: string, command: Command): Promise<CommandResult> {
    const tab = await this.#tabOf(command)
    const spec = this.#spec()
    if (method === 'viewportReset') {
      await tab.page.setViewportSize(spec.viewport)
      return { value: { width: spec.viewport.width, height: spec.viewport.height } }
    }
    const width = Math.round(num(command, 'width') ?? spec.viewport.width)
    const height = Math.round(num(command, 'height') ?? spec.viewport.height)
    if (width < 100 || height < 100 || width > 10000 || height > 10000) {
      fail('invalid-argument', '视口尺寸超出范围(100-10000)')
    }
    await tab.page.setViewportSize({ width, height })
    return { value: { width, height } }
  }

  /* ---------------- 读取 ---------------- */

  async #screenshot(command: Command): Promise<CommandResult> {
    const tab = await this.#tabOf(command)
    const fullPage = bool(command, 'fullPage') === true
    const type = str(command, 'format') === 'jpeg' ? 'jpeg' : 'png'
    const quality = num(command, 'quality')
    const rawClip = command.clip
    let clip: { x: number; y: number; width: number; height: number } | undefined
    if (typeof rawClip === 'object' && rawClip !== null) {
      const record = rawClip as Record<string, unknown>
      const x = num(record, 'x')
      const y = num(record, 'y')
      const width = num(record, 'width')
      const height = num(record, 'height')
      if (x === undefined || y === undefined || width === undefined || height === undefined) {
        fail('invalid-argument', 'clip 需要 x/y/width/height')
      }
      clip = { x, y, width, height }
    }
    const buffer = await tab.page.screenshot({
      type,
      fullPage,
      ...(clip ? { clip } : {}),
      ...(type === 'jpeg' && quality !== undefined ? { quality: Math.max(0, Math.min(100, Math.round(quality))) } : {}),
    })
    return {
      image: { base64: buffer.toString('base64'), mimeType: type === 'jpeg' ? 'image/jpeg' : 'image/png' },
      value: { bytes: buffer.length, fullPage, format: type },
    }
  }

  async #snapshot(command: Command): Promise<CommandResult> {
    const tab = await this.#tabOf(command)
    const maxElements = num(command, 'maxElements')
    const result = await ax.snapshotAccessibility(tab.session, {
      maxElements: maxElements === undefined ? 0 : Math.max(1, Math.round(maxElements)),
    })
    tab.refs = result.refs
    return {
      value: {
        url: tab.page.url(),
        title: await tab.page.title().catch(() => ''),
        text: result.text,
        truncated: result.truncated,
        elements: result.count,
      },
    }
  }

  /* ---------------- 交互 ---------------- */

  async #click(method: string, command: Command): Promise<CommandResult> {
    const tab = await this.#tabOf(command)
    const button = str(command, 'button') === 'right' ? 'right' : str(command, 'button') === 'middle' ? 'middle' : 'left'
    const doubleClick = bool(command, 'doubleClick') === true
    const humanize = this.#humanizeFor(command)
    if (method === 'clickElement') {
      if (bool(command, 'confirm') !== true) {
        fail('confirmation-required', 'clickElement 需要 confirm=true:点击可能提交数据、触发导航或外部副作用')
      }
      const selector = str(command, 'selector')?.trim()
      if (!selector) fail('invalid-argument', 'clickElement 需要 selector')
      const frame = this.#selectedFrame(tab)
      const handles = await frame.locator(`css=${selector}`).elementHandles()
      if (handles.length === 0) fail('not-found', `没有匹配选择器的元素:${selector}`)
      const index = num(command, 'index') ?? 0
      if (command.index === undefined && handles.length > 1) {
        fail('conflict', `选择器匹配 ${handles.length} 个元素;传 index 明确指定一个`)
      }
      if (index < 0 || index >= handles.length) fail('invalid-argument', `index 越界:${index}`)
      const handle = handles[index]
      if (!handle) fail('not-found', `index ${index} 没有元素`)
      if (!(await handle.isVisible())) fail('precondition-failed', `匹配元素不可见(index=${index})`)
      const metadata = await handle.evaluate((node) => {
        const element = node as unknown as { tagName: string; id: string; textContent: string | null; getAttribute(name: string): string | null }
        return {
          tagName: element.tagName.toLowerCase(),
          id: element.id || null,
          role: element.getAttribute('role'),
          text: (element.textContent ?? '').trim().slice(0, 200),
          ariaLabel: element.getAttribute('aria-label'),
        }
      })
      try {
        if (humanize) {
          // 走坐标点击而不是 handle.click:后者是一次到位,页面只会看到
          // 一对 mousedown/mouseup,没有移动过程。
          const box = await handle.boundingBox()
          if (box) {
            await ax.clickPoint(tab.session, box.x + box.width / 2, box.y + box.height / 2, {
              button,
              clickCount: doubleClick ? 2 : 1,
            })
          } else {
            await handle.click({ button, clickCount: doubleClick ? 2 : 1, timeout: DEFAULT_ACTION_TIMEOUT })
          }
        } else {
          await handle.click({ button, clickCount: doubleClick ? 2 : 1, timeout: DEFAULT_ACTION_TIMEOUT })
        }
      } finally {
        await Promise.allSettled(handles.map((entry) => entry.dispose()))
      }
      return { value: { action: 'click', selector, index, matchedCount: handles.length, element: metadata } }
    }
    const ref = str(command, 'ref')
    if (ref) {
      const backend = tab.refs.get(ax.normalizeRef(ref))
      if (backend === undefined) fail('not-found', `元素引用 ${ref} 不存在或已失效(页面导航后需重新 snapshot)`)
      await ax.clickBackend(tab.session, backend, { button, clickCount: doubleClick ? 2 : 1, humanize })
      return { value: { clicked: ref } }
    }
    const x = num(command, 'x')
    const y = num(command, 'y')
    if (x === undefined || y === undefined) fail('invalid-argument', 'click 需要 ref 或 x/y')
    if (humanize) {
      await ax.clickPoint(tab.session, x, y, { button, clickCount: doubleClick ? 2 : 1 })
    } else {
      await tab.page.mouse.click(x, y, { button, clickCount: doubleClick ? 2 : 1 })
    }
    return { value: { clicked: { x, y } } }
  }

  /** 单次命令可覆盖全局开关,只影响这一次调用。 */
  #humanizeFor(command: Command): boolean {
    return bool(command, 'humanize') ?? this.#humanize
  }

  async #resolveBackend(tab: Tab, command: Command): Promise<number | undefined> {
    const ref = str(command, 'ref')
    if (!ref) return undefined
    const backend = tab.refs.get(ax.normalizeRef(ref))
    if (backend === undefined) fail('not-found', `元素引用 ${ref} 不存在或已失效(页面导航后需重新 snapshot)`)
    return backend
  }

  async #fill(command: Command): Promise<CommandResult> {
    const tab = await this.#tabOf(command)
    const value = str(command, 'value') ?? ''
    const backend = await this.#resolveBackend(tab, command)
    if (backend !== undefined) {
      await ax.fillBackend(tab.session, backend, value)
      return { value: { filled: str(command, 'ref') } }
    }
    const selector = str(command, 'selector')?.trim()
    if (!selector) fail('invalid-argument', 'fill 需要 ref 或 selector')
    await this.#selectedFrame(tab).locator(`css=${selector}`).fill(value, { timeout: DEFAULT_ACTION_TIMEOUT })
    return { value: { filled: selector } }
  }

  async #type(command: Command): Promise<CommandResult> {
    const tab = await this.#tabOf(command)
    const text = str(command, 'text') ?? ''
    const backend = await this.#resolveBackend(tab, command)
    if (backend !== undefined) await ax.focusBackend(tab.session, backend)
    const selector = str(command, 'selector')?.trim()
    if (selector) await this.#selectedFrame(tab).locator(`css=${selector}`).focus({ timeout: DEFAULT_ACTION_TIMEOUT })
    if (this.#humanizeFor(command) === false) {
      await tab.page.keyboard.type(text)
      return { value: { typed: text.length } }
    }
    // 逐字符键入:每次按键有自己的按住时长,字符之间按内容决定间隔,
    // 一次性 insertText 会让 keydown/keyup 缺失,是最明显的合成痕迹。
    for (const char of text) {
      await tab.page.keyboard.type(char)
      await new Promise((resolve) => setTimeout(resolve, keyGap(char)))
    }
    return { value: { typed: text.length } }
  }

  async #press(command: Command): Promise<CommandResult> {
    const tab = await this.#tabOf(command)
    const key = str(command, 'key')
    if (!key) fail('invalid-argument', 'press 需要 key')
    const backend = await this.#resolveBackend(tab, command)
    if (backend !== undefined) await ax.focusBackend(tab.session, backend)
    await tab.page.keyboard.press(key)
    return { value: { key } }
  }

  async #scroll(command: Command): Promise<CommandResult> {
    const tab = await this.#tabOf(command)
    const deltaX = num(command, 'deltaX') ?? 0
    const deltaY = num(command, 'deltaY') ?? 360
    const backend = await this.#resolveBackend(tab, command)
    let x = num(command, 'x')
    let y = num(command, 'y')
    if (backend !== undefined) {
      const center = await ax.elementCenter(tab.session, backend)
      x = center.x
      y = center.y
    }
    const viewport = tab.page.viewportSize() ?? this.#spec().viewport
    const at = { x: x ?? viewport.width / 2, y: y ?? viewport.height / 2 }
    const humanize = this.#humanizeFor(command)
    await ax.hoverPoint(tab.session, at.x, at.y, { humanize })
    if (humanize === false) {
      await tab.page.mouse.wheel(deltaX, deltaY)
      return { value: { scrolled: { deltaX, deltaY } } }
    }
    // 滚动拆成若干衰减增量:一次 wheel 到位没有惯性,是脚本最容易被量化的特征。
    for (const step of scrollSteps(deltaY)) {
      await tab.page.mouse.wheel(deltaX === 0 ? 0 : Math.round(deltaX / 4), step)
      await new Promise((resolve) => setTimeout(resolve, scrollStepDelay()))
    }
    return { value: { scrolled: { deltaX, deltaY } } }
  }

  async #hover(command: Command): Promise<CommandResult> {
    const tab = await this.#tabOf(command)
    const backend = await this.#resolveBackend(tab, command)
    if (backend !== undefined) {
      const center = await ax.elementCenter(tab.session, backend)
      await ax.hoverPoint(tab.session, center.x, center.y, { humanize: this.#humanizeFor(command) })
      return { value: { hovered: str(command, 'ref') } }
    }
    const x = num(command, 'x')
    const y = num(command, 'y')
    if (x === undefined || y === undefined) fail('invalid-argument', 'hover 需要 ref 或 x/y')
    await ax.hoverPoint(tab.session, x, y, { humanize: this.#humanizeFor(command) })
    return { value: { hovered: { x, y } } }
  }

  async #select(command: Command): Promise<CommandResult> {
    const tab = await this.#tabOf(command)
    const values = strList(command, 'values') ?? []
    if (values.length === 0) fail('invalid-argument', 'select 需要 values')
    const backend = await this.#resolveBackend(tab, command)
    if (backend !== undefined) {
      await ax.selectBackend(tab.session, backend, values)
      return { value: { selected: values } }
    }
    const selector = str(command, 'selector')?.trim()
    if (!selector) fail('invalid-argument', 'select 需要 ref 或 selector')
    await this.#selectedFrame(tab).locator(`css=${selector}`).selectOption(values, { timeout: DEFAULT_ACTION_TIMEOUT })
    return { value: { selected: values } }
  }

  async #check(command: Command): Promise<CommandResult> {
    const tab = await this.#tabOf(command)
    const checked = bool(command, 'checked')
    const backend = await this.#resolveBackend(tab, command)
    if (backend !== undefined) {
      await ax.checkBackend(tab.session, backend, checked)
      return { value: { checked: checked ?? 'toggled' } }
    }
    const selector = str(command, 'selector')?.trim()
    if (!selector) fail('invalid-argument', 'check 需要 ref 或 selector')
    const locator = this.#selectedFrame(tab).locator(`css=${selector}`)
    // 缺省取反,与 ref 路径保持一致。
    const target = checked ?? !(await locator.isChecked().catch(() => false))
    await locator.setChecked(target, { timeout: DEFAULT_ACTION_TIMEOUT })
    return { value: { checked: target } }
  }

  async #drag(command: Command): Promise<CommandResult> {
    const tab = await this.#tabOf(command)
    const fromRef = str(command, 'fromRef')
    const toRef = str(command, 'toRef')
    let from = { x: num(command, 'fromX') ?? 0, y: num(command, 'fromY') ?? 0 }
    let to = { x: num(command, 'toX') ?? 0, y: num(command, 'toY') ?? 0 }
    if (fromRef) {
      const backend = tab.refs.get(ax.normalizeRef(fromRef))
      if (backend === undefined) fail('not-found', `元素引用 ${fromRef} 不存在或已失效`)
      from = await ax.elementCenter(tab.session, backend)
    }
    if (toRef) {
      const backend = tab.refs.get(ax.normalizeRef(toRef))
      if (backend === undefined) fail('not-found', `元素引用 ${toRef} 不存在或已失效`)
      to = await ax.elementCenter(tab.session, backend)
    }
    const humanize = this.#humanizeFor(command)
    await ax.hoverPoint(tab.session, from.x, from.y, { humanize })
    await tab.page.mouse.down()
    if (humanize === false) {
      await tab.page.mouse.move(to.x, to.y, { steps: 10 })
    } else {
      // 拖拽期间保持按键按下,轨迹要连续且不能有瞬移。
      await ax.movePointerTo(tab.session, to)
    }
    await tab.page.mouse.up()
    return { value: { from, to } }
  }

  async #elementInfo(command: Command): Promise<CommandResult> {
    const tab = await this.#tabOf(command)
    const x = num(command, 'x')
    const y = num(command, 'y')
    if (x === undefined || y === undefined) fail('invalid-argument', 'elementInfo 需要 x/y')
    const info = await ax.elementInfoAt(tab.session, x, y)
    return { value: info }
  }

  async #evaluate(command: Command): Promise<CommandResult> {
    const tab = await this.#tabOf(command)
    const expression = str(command, 'expression')
    if (!expression) fail('invalid-argument', 'evaluate 需要 expression')
    const callFrameId = str(command, 'callFrameId')
    if (callFrameId) {
      const value = await tab.debugger.evaluateOnCallFrame(callFrameId, expression)
      return { value }
    }
    const frameIndex = num(command, 'frameIdx')
    if (bool(command, 'mainWorld') === true) {
      if (frameIndex !== undefined && frameIndex !== 0) {
        fail('invalid-argument', 'mainWorld 只支持主文档(frameIdx=0);iframe 请用默认的隔离世界')
      }
      const result = (await tab.session.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      })) as {
        result?: { value?: unknown; description?: string }
        exceptionDetails?: { text?: string; exception?: { description?: string } }
      }
      if (result.exceptionDetails) {
        const details = result.exceptionDetails
        fail('evaluate-failed', details.exception?.description ?? details.text ?? '页面脚本执行失败')
      }
      return { value: 'value' in (result.result ?? {}) ? result.result?.value : result.result?.description }
    }
    let frame = this.#selectedFrame(tab)
    if (frameIndex !== undefined) {
      const frames = tab.page.frames()
      if (frameIndex < 0 || frameIndex >= frames.length) fail('invalid-argument', `frameIdx 越界:${frameIndex}`)
      frame = frames[frameIndex] ?? frame
    }
    try {
      const value = await frame.evaluate(expression)
      return { value }
    } catch (error) {
      fail('evaluate-failed', error instanceof Error ? error.message.split('\n')[0] ?? error.message : String(error))
    }
  }

  async #waitFor(command: Command): Promise<CommandResult> {
    const tab = await this.#tabOf(command)
    const timeout = num(command, 'timeoutMs') ?? DEFAULT_ACTION_TIMEOUT
    const selector = str(command, 'selector')?.trim()
    const text = str(command, 'text')
    const textGone = str(command, 'textGone')
    if (!selector && !text && !textGone) fail('invalid-argument', 'waitFor 需要 selector / text / textGone 之一')
    if (selector) {
      await this.#selectedFrame(tab).locator(`css=${selector}`).waitFor({ state: 'visible', timeout })
      return { value: { waited: { selector } } }
    }
    const needle = text ?? textGone ?? ''
    const negate = textGone !== undefined
    const expression = `(() => { const present = Boolean(document.body && document.body.innerText.includes(${JSON.stringify(needle)})); return ${negate ? '!present' : 'present'}; })()`
    await tab.page.waitForFunction(expression, undefined, { timeout })
    return { value: { waited: negate ? { textGone: needle } : { text: needle } } }
  }

  async #getDialog(command: Command): Promise<CommandResult> {
    const tab = await this.#tabOf(command)
    if (!tab.dialog) return { dialog: null, value: { dialog: null } }
    return {
      dialog: { type: tab.dialog.type(), message: tab.dialog.message() },
      value: { dialog: { type: tab.dialog.type(), message: tab.dialog.message() } },
    }
  }

  async #handleDialog(command: Command): Promise<CommandResult> {
    const tab = await this.#tabOf(command)
    const dialog = tab.dialog
    if (!dialog) fail('not-found', '当前没有待处理的弹窗')
    const accept = bool(command, 'accept') !== false
    try {
      if (accept) await dialog.accept(str(command, 'promptText'))
      else await dialog.dismiss()
    } finally {
      tab.dialog = null
      this.#emit({ type: 'dialog-closed', tabId: tab.tabId })
    }
    return { value: { accepted: accept } }
  }

  async #screencast(method: string, command: Command): Promise<CommandResult> {
    // A screencast request must never resurrect a closed browser: the console
    // panel re-requests it on every SSE reconnect.
    if (!this.running) return { value: { screencast: false, running: false } }
    const requested = str(command, 'tabId')
    const tab = requested
      ? this.#tabs.get(requested)
      : this.#activeTabId
        ? this.#tabs.get(this.#activeTabId)
        : undefined
    if (!tab) return { value: { screencast: false, running: this.running } }
    if (method === 'startScreencast') {
      if (!tab.screencast) {
        await tab.session.send('Page.startScreencast', {
          format: 'jpeg',
          quality: 70,
          maxWidth: 1280,
          maxHeight: 800,
          everyNthFrame: 1,
        })
        tab.screencast = true
      }
      this.#emit({ type: 'tabs-changed' })
      return { value: { screencast: true } }
    }
    if (tab.screencast) {
      await tab.session.send('Page.stopScreencast').catch(() => undefined)
      tab.screencast = false
    }
    return { value: { screencast: false } }
  }

  /* ---------------- 网络 ---------------- */

  async #networkList(command: Command): Promise<CommandResult> {
    const tab = await this.#tabOf(command)
    const max = Math.max(1, Math.min(num(command, 'max') ?? 50, 200))
    const entries = tab.network.list(str(command, 'urlFilter'), max)
    return {
      value: {
        requests: entries.map((entry) => ({
          requestId: entry.id,
          url: entry.url,
          method: entry.method,
          status: entry.status,
          resourceType: entry.resourceType,
          pending: entry.pending,
          failed: entry.failed,
          initiatorType: entry.initiator?.type,
        })),
        pending: tab.network.pendingCount(),
        note:
          tab.network.pendingCount() > 0
            ? '存在未完成的请求:若页面正停在断点,先 resume 再等 response'
            : undefined,
      },
    }
  }

  async #networkDetail(command: Command): Promise<CommandResult> {
    const tab = await this.#tabOf(command)
    const requestId = num(command, 'requestId')
    if (requestId === undefined) fail('invalid-argument', 'networkDetail 需要 requestId')
    const entry = tab.network.get(Math.round(requestId))
    if (!entry) fail('not-found', `请求不在缓冲中:${requestId}(只保留最近 200 条)`)
    const info = tab.bodies.get(entry.id)
    let requestHeaders: Record<string, string> | undefined
    let responseHeaders: Record<string, string> | undefined
    if (info) {
      requestHeaders = await info.request.allHeaders().catch(() => undefined)
      responseHeaders = await info.response?.allHeaders().catch(() => undefined)
    }
    return {
      value: {
        ...entry,
        requestHeaders,
        responseHeaders,
      },
    }
  }

  async #networkBody(command: Command): Promise<CommandResult> {
    const tab = await this.#tabOf(command)
    const requestId = num(command, 'requestId')
    if (requestId === undefined) fail('invalid-argument', 'networkGetBody 需要 requestId')
    const id = Math.round(requestId)
    const entry = tab.network.get(id)
    if (!entry) fail('not-found', `请求不在缓冲中:${id}`)
    const info = tab.bodies.get(id)
    if (!info) fail('not-found', '该请求的 body 已不在缓冲中(只保留最近 300 条)')
    const bodyKind = str(command, 'bodyKind') ?? 'response'
    if (bodyKind === 'request') {
      const postData = info.request.postData()
      return { value: { requestId: id, bodyKind, body: postData ?? '', empty: postData === null } }
    }
    const response = info.response
    if (!response) fail('precondition-failed', '响应尚未到达;若页面停在断点,先 resume')
    let buffer: Buffer
    try {
      buffer = await response.body()
    } catch (error) {
      fail('failed', `读取响应体失败:${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
    }
    const mime = entry.mimeType ?? ''
    const textual = mime.startsWith('text/') || /json|xml|javascript|ecmascript|css|html/.test(mime)
    if (!textual) {
      return { value: { requestId: id, bodyKind, encoding: 'base64', body: buffer.toString('base64'), bytes: buffer.length } }
    }
    const text = buffer.toString('utf8')
    return {
      value: { requestId: id, bodyKind, encoding: 'utf8', body: tab.network.truncateBody(text), chars: text.length },
    }
  }

  async #ensureNetworkCdp(tab: Tab): Promise<void> {
    if (tab.networkCdp) return
    tab.networkCdp = true
    await tab.session.send('Network.enable', {}).catch(() => undefined)
  }

  async #requestInitiator(command: Command): Promise<CommandResult> {
    const tab = await this.#tabOf(command)
    const requestId = num(command, 'requestId')
    if (requestId === undefined) fail('invalid-argument', 'getRequestInitiator 需要 requestId')
    await this.#ensureNetworkCdp(tab)
    const id = Math.round(requestId)
    const entry = tab.network.get(id)
    if (!entry) fail('not-found', `请求不在缓冲中:${id}`)
    const initiator = tab.network.initiatorFor(entry) ?? (await this.#waitInitiator(tab, entry))
    if (!initiator) {
      return {
        value: {
          requestId: id,
          initiator: null,
          note: '没有记录到 initiator:它依赖 CDP Network 域,首次调用此命令时才启用;请重新触发该请求后再查',
        },
      }
    }
    return { value: { requestId: id, url: entry.url, initiator } }
  }

  async #waitInitiator(tab: Tab, entry: NetworkEntry): Promise<NetworkEntry['initiator']> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const found = tab.network.initiatorFor(entry)
      if (found) return found
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return undefined
  }

  async #clearNetwork(command: Command): Promise<CommandResult> {
    const tab = await this.#tabOf(command)
    const cleared = tab.network.clear()
    tab.bodies.clear()
    return { value: { cleared } }
  }

  async #consoleMessages(command: Command): Promise<CommandResult> {
    const tab = await this.#tabOf(command)
    const id = num(command, 'msgId')
    if (id !== undefined) {
      const entry = tab.console.get(Math.round(id))
      if (!entry) fail('not-found', `没有第 ${id} 条 console 消息`)
      return { value: entry }
    }
    const max = Math.max(1, Math.min(num(command, 'max') ?? 50, 200))
    return { value: { messages: tab.console.list(max, str(command, 'type')) } }
  }

  async #socketMessages(command: Command): Promise<CommandResult> {
    const tab = await this.#tabOf(command)
    const wsId = num(command, 'wsId')
    if (wsId !== undefined) {
      const socket = tab.sockets.get(Math.round(wsId))
      if (!socket) fail('not-found', `没有 WebSocket 连接:${wsId}`)
      return { value: socket }
    }
    const max = Math.max(1, Math.min(num(command, 'max') ?? 20, 50))
    const sockets = tab.sockets.list()
    return {
      value: {
        sockets: sockets.slice(-max).map((socket) => ({
          wsId: socket.id,
          url: socket.url,
          frames: socket.frames.length,
          truncatedFrames: socket.truncatedFrames,
          closedAt: socket.closedAt,
        })),
        total: sockets.length,
      },
    }
  }

  /* ---------------- 脚本与断点 ---------------- */

  async #ensureDebugger(tab: Tab): Promise<void> {
    if (tab.debugger.enabled) return
    await tab.debugger.enable()
  }

  async #listScripts(command: Command): Promise<CommandResult> {
    const tab = await this.#tabOf(command)
    await this.#ensureDebugger(tab)
    const scripts = tab.debugger.filterScripts(str(command, 'filter'))
    const pageSize = Math.max(1, num(command, 'pageSize') ?? 20)
    const pageIdx = Math.max(0, num(command, 'pageIdx') ?? 0)
    const start = pageIdx * pageSize
    const slice = scripts.slice(start, start + pageSize)
    return {
      value: {
        scripts: slice.map((script) => ({
          scriptId: script.scriptId,
          url: script.url.length > 200 ? `${script.url.slice(0, 200)}…` : script.url,
          sourceMapURL: script.sourceMapURL,
        })),
        total: scripts.length,
        pageIdx,
        pageSize,
      },
    }
  }

  async #scriptOf(tab: Tab, command: Command): Promise<{ scriptId: string; url: string }> {
    const scriptId = str(command, 'scriptId')
    if (scriptId) {
      const script = tab.debugger.scripts.get(scriptId)
      if (!script) fail('not-found', `scriptId 不存在:${scriptId}`)
      return { scriptId: script.scriptId, url: script.url }
    }
    const url = str(command, 'url')
    if (!url) fail('invalid-argument', '需要 url 或 scriptId')
    const script = tab.debugger.scriptByUrl(url)
    if (!script) fail('not-found', `没有加载该 URL 的脚本:${url}`)
    return { scriptId: script.scriptId, url: script.url }
  }

  async #scriptSource(command: Command): Promise<CommandResult> {
    const tab = await this.#tabOf(command)
    await this.#ensureDebugger(tab)
    const { scriptId, url } = await this.#scriptOf(tab, command)
    const source = await tab.debugger.source(scriptId)
    const lines = source.split('\n')
    const startLine = Math.max(1, Math.round(num(command, 'startLine') ?? 1))
    const endLine = Math.min(lines.length, Math.round(num(command, 'endLine') ?? startLine + 199))
    const offset = num(command, 'offset')
    const length = Math.max(1, Math.round(num(command, 'length') ?? 1000))
    if (offset !== undefined) {
      const start = Math.max(0, Math.round(offset))
      const chunk = source.slice(start, start + length)
      return {
        value: {
          scriptId,
          url,
          startOffset: start,
          endOffset: start + chunk.length,
          totalChars: source.length,
          source: chunk,
        },
      }
    }
    if (startLine > lines.length) fail('invalid-argument', `startLine 超出范围(共 ${lines.length} 行)`)
    const slice = lines.slice(startLine - 1, endLine)
    return {
      value: {
        scriptId,
        url,
        startLine,
        endLine: startLine + slice.length - 1,
        totalLines: lines.length,
        source: slice.map((line, index) => `${startLine + index}: ${line}`).join('\n'),
      },
    }
  }

  async #saveScriptSource(command: Command): Promise<CommandResult> {
    const tab = await this.#tabOf(command)
    await this.#ensureDebugger(tab)
    const { scriptId, url } = await this.#scriptOf(tab, command)
    const source = await tab.debugger.source(scriptId)
    const raw = str(command, 'path')
    if (!raw) fail('invalid-argument', 'saveScriptSource 需要 path')
    const spec = this.#spec()
    const target = path.isAbsolute(raw) ? raw : path.join(spec.artifactsDir, raw)
    if (fs.existsSync(target) && bool(command, 'confirmOverwrite') !== true) {
      fail('confirmation-required', `文件已存在:${target}(传 confirmOverwrite=true 覆盖)`)
    }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, source, 'utf8')
    return { value: { path: target, bytes: Buffer.byteLength(source, 'utf8'), url, scriptId } }
  }

  async #searchSources(command: Command): Promise<CommandResult> {
    const tab = await this.#tabOf(command)
    await this.#ensureDebugger(tab)
    const query = str(command, 'query')
    if (!query) fail('invalid-argument', 'searchInSources 需要 query')
    const result = await tab.debugger.search(query, {
      isRegex: bool(command, 'isRegex') === true,
      caseSensitive: bool(command, 'caseSensitive') === true,
      urlFilter: str(command, 'urlFilter'),
      max: num(command, 'max'),
    })
    return {
      value: {
        matches: result.matches,
        scannedScripts: result.scanned,
        failedScripts: result.failed,
        note: result.matches.length === 0 ? '未命中;可去掉 urlFilter 或改用更短的字面量' : undefined,
      },
    }
  }

  async #setBreakpointOnText(command: Command): Promise<CommandResult> {
    const tab = await this.#tabOf(command)
    await this.#ensureDebugger(tab)
    const text = str(command, 'text')
    if (!text) fail('invalid-argument', 'setBreakpointOnText 需要 text')
    const result = await tab.debugger.setBreakpointOnText(text, {
      urlFilter: str(command, 'urlFilter'),
      occurrence: num(command, 'occurrence'),
    })
    return { value: result }
  }

  async #breakOnXhr(command: Command): Promise<CommandResult> {
    const tab = await this.#tabOf(command)
    await this.#ensureDebugger(tab)
    const urlPattern = str(command, 'urlPattern')
    if (!urlPattern) fail('invalid-argument', 'breakOnXhr 需要 urlPattern')
    await tab.debugger.setXhrBreakpoint(urlPattern)
    return { value: { xhrBreakpoint: urlPattern } }
  }

  async #removeBreakpoint(command: Command): Promise<CommandResult> {
    const tab = await this.#tabOf(command)
    await this.#ensureDebugger(tab)
    if (bool(command, 'all') === true) {
      const removed = await tab.debugger.removeAllBreakpoints()
      return { value: { removed } }
    }
    const breakpointId = str(command, 'breakpointId')
    const url = str(command, 'url')
    if (breakpointId) {
      await tab.debugger.removeBreakpoint(breakpointId)
      return { value: { removed: 1, breakpointId } }
    }
    if (url) {
      const matched = [...tab.debugger.breakpoints.values()].filter((entry) => entry.url === url)
      for (const entry of matched) await tab.debugger.removeBreakpoint(entry.breakpointId)
      if (tab.debugger.xhrBreakpoints.has(url)) await tab.debugger.removeXhrBreakpoint(url)
      return { value: { removed: matched.length, url } }
    }
    fail('invalid-argument', '需要 breakpointId / url / all=true')
  }

  async #listBreakpoints(command: Command): Promise<CommandResult> {
    const tab = await this.#tabOf(command)
    return {
      value: {
        breakpoints: [...tab.debugger.breakpoints.values()],
        xhrBreakpoints: [...tab.debugger.xhrBreakpoints],
        paused: tab.debugger.paused !== null,
      },
    }
  }

  async #pausedInfo(command: Command): Promise<CommandResult> {
    const tab = await this.#tabOf(command)
    await this.#ensureDebugger(tab)
    const paused = tab.debugger.paused
    if (!paused) return { value: { paused: false, note: '当前没有暂停中的执行;先 setBreakpointOnText 或 pauseOrResume' } }
    const includeScope = bool(command, 'includeScope') !== false
    const scope = includeScope ? await tab.debugger.scopeVariables(num(command, 'frameIndex') ?? 0) : []
    return {
      value: {
        paused: true,
        reason: paused.reason,
        hitBreakpoints: paused.hitBreakpoints,
        callFrames: paused.callFrames,
        text: tab.debugger.formatPaused(paused),
        scope,
      },
    }
  }

  async #pauseOrResume(command: Command): Promise<CommandResult> {
    const tab = await this.#tabOf(command)
    await this.#ensureDebugger(tab)
    const action = str(command, 'action') ?? 'resume'
    if (action === 'pause') {
      const paused = await tab.debugger.pause()
      return { value: { paused: paused !== null, reason: paused?.reason } }
    }
    await tab.debugger.resume()
    return { value: { paused: false } }
  }

  async #step(command: Command): Promise<CommandResult> {
    const tab = await this.#tabOf(command)
    await this.#ensureDebugger(tab)
    if (!tab.debugger.paused) fail('precondition-failed', '当前没有暂停中的执行,无法单步')
    const kind = str(command, 'kind')
    const mode = kind === 'into' || kind === 'out' ? kind : 'over'
    const paused = await tab.debugger.step(mode)
    if (!paused) fail('failed', '单步后没有等到暂停事件(可能已恢复执行)')
    return { value: { paused: true, text: tab.debugger.formatPaused(paused), callFrames: paused.callFrames } }
  }

  /* ---------------- 指纹自检 ---------------- */

  /**
   * 在主世界采一份指纹,并逐项对照当前伪装档位。
   *
   * 必须走 `Runtime.evaluate`:Playwright 的 `page.evaluate` 跑在隔离世界,
   * 读到的 `window.chrome` 是副本,会把正常浏览器误报成缺 `app`。
   * 输出只否定「明显异常」,不做“像不像人”的玄学评分。
   */
  async #fingerprint(command: Command): Promise<CommandResult> {
    const tab = await this.#tabOf(command)
    const subject = (await tab.session.send('Runtime.evaluate', {
      expression: `${COLLECT_FINGERPRINT}`,
      returnByValue: true,
      // 采集脚本要等 Worker 回消息才返回,不开 awaitPromise 会拿到未决的 Promise。
      awaitPromise: true,
    })) as { result?: { value?: unknown; description?: string }; exceptionDetails?: { text?: string } }
    if (subject.exceptionDetails) {
      fail('evaluate-failed', subject.exceptionDetails.text ?? '指纹采集失败')
    }
    const raw = subject.result?.value
    if (typeof raw !== 'string') fail('evaluate-failed', '指纹采集返回了非字符串结果')
    const facts = JSON.parse(raw) as Record<string, unknown>
    return { value: { subject: facts, checks: auditFingerprint(facts, this.#stealth, this.#humanize) } }
  }

  /* ---------------- 站点数据 ---------------- */

  async #clearSiteData(command: Command): Promise<CommandResult> {
    const tab = await this.#tabOf(command)
    let origin = str(command, 'origin')
    if (!origin) {
      try {
        origin = new URL(tab.page.url()).origin
      } catch {
        fail('precondition-failed', '当前页面没有可用的 origin;请先导航到 http(s) 页面')
      }
    }
    const storageTypes = str(command, 'storageTypes') ?? 'cookies,local_storage,session_storage,indexeddb,cache_storage'
    await tab.session.send('Storage.clearDataForOrigin', { origin, storageTypes })
    let cacheCleared = false
    if (bool(command, 'cache') !== false) {
      await tab.session.send('Network.clearBrowserCache').catch(() => undefined)
      cacheCleared = true
    }
    return { value: { origin, storageTypes, cacheCleared } }
  }
}