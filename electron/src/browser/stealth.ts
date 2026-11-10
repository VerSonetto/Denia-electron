// 伪装层:让自动化浏览器在主世界暴露的特征与真实浏览器一致。
//
// 先用主世界通道测过一遍基线,得到的结论决定了这里的取舍:
// - `window.chrome.app`、`navigator.permissions`、WebGL、插件表在
//   `--headless=new` 下本来就与真机一致;Playwright 的 `evaluate` 之所以
//   看不到 `chrome.app`,是因为它在隔离世界跑,读到的是被剥过的副本。
//   所以这里不碰这些属性 —— 改得越多,伪造痕迹越明显。
// - 真正需要动的只有三处:
//   1. UA 里的 `HeadlessChrome`(启动参数级别,页面无从分辨);
//   2. `outerWidth/outerHeight === innerWidth/innerHeight`,真机上二者之间
//      隔着标题栏与边框,恒等是最稳的单点特征;
//   3. `screen` 退化到与视口同尺寸、以及 `devicePixelRatio` 固定为 1。
//
// 两条硬约束:
// - UA 只能改「无头标记」,不能改版本号。`userAgentData.brands` 由浏览器
//   内核直接给出,改了版本会让 UA 字符串与 UA-CH 互相矛盾,比不改还糟。
// - 注入走页级 CDP:Patchright 会丢弃 `context.addInitScript` 与页面的
//   新文档脚本,只有自己发出的 `Page.addScriptToEvaluateOnNewDocument`
//   才会在页面脚本之前执行。
//
// 语言必须走启动参数而不是页面覆盖:持久 profile 的 `intl.accept_languages`
// 会按 profile 首次创建时的系统语言写死(实测为 `en-US,en`),Worker 读的是
// 这份偏好,而 Playwright 的 `locale` 只改主世界。于是同一页面上主线程报
// `zh-CN`、Worker 报 `en-US`,这是最容易被交叉验证抓住的矛盾 —— 实测
// DeviceAndBrowserInfo 仅凭此项就判 `isBot: true`。`--accept-lang` 同时
// 决定 Worker 与 Accept-Language 头,是唯一能一次对齐两处的开关。

/** 一份伪装档位:数值应当与浏览器真实环境一致。 */
export interface StealthProfile {
  viewport: { width: number; height: number }
  screen: { width: number; height: number }
  deviceScaleFactor: number
  locale: string
  /** 去掉无头标记后的 UA;由浏览器自报的 UA 推导而来。 */
  userAgent: string
}

const HEADLESS_MARKER = /HeadlessChrome/g

/** 去掉无头标记;真机从不会这样报自己。 */
export function sanitizeUserAgent(userAgent: string): string {
  return userAgent.replace(HEADLESS_MARKER, 'Chrome')
}

export function isHeadlessUserAgent(userAgent: string): boolean {
  return /HeadlessChrome/i.test(userAgent)
}

/**
 * 窗口装饰:真机上 `outer - inner` 是标题栏 + 边框 + 标签栏的合值。
 * 取 Windows 上 Chrome/Edge 的常见值。
 */
export const WINDOW_CHROME = { x: 16, y: 134 }

export interface StealthOptions {
  /** 浏览器自报的 UA(`/json/version` 的 `User-Agent`)。 */
  userAgent: string
  locale?: string
  viewport?: { width: number; height: number }
  screen?: { width: number; height: number }
  deviceScaleFactor?: number
}

export function buildProfile(options: StealthOptions): StealthProfile {
  return {
    viewport: options.viewport ?? { width: 1440, height: 900 },
    // 真机屏幕总比视口大;取常见笔记本面板尺寸,`availHeight` 再去掉任务栏。
    screen: options.screen ?? { width: 1707, height: 1067 },
    deviceScaleFactor: options.deviceScaleFactor ?? 1.5,
    locale: options.locale?.trim() || 'zh-CN',
    userAgent: sanitizeUserAgent(options.userAgent),
  }
}

/**
 * 启动参数。UA 与语言只能在这里给:页面侧的覆盖会在 `navigator` 上留下
 * 可枚举属性,或让 UA-CH 变空,那比无头标记更容易被识别。
 */
export function stealthArgs(profile: StealthProfile): string[] {
  return [
    // 用 new headless 而不是 Playwright 的 headless 开关:后者会让窗口、
    // 屏幕信息整体退化,反而多出别的差异。
    '--headless=new',
    `--user-agent=${profile.userAgent}`,
    `--window-size=${profile.viewport.width + WINDOW_CHROME.x},${profile.viewport.height + WINDOW_CHROME.y}`,
    `--lang=${profile.locale}`,
    // 必须同时给 `--accept-lang`:只给 `--lang` 时 Worker 仍读 profile 里
    // 存的偏好语言,与主世界的 `navigator.language` 对不上。
    `--accept-lang=${profile.locale}`,
    '--force-color-profile=srgb',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-crash-restore-bubble',
  ]
}

/**
 * 注入到每个新文档的补丁。只处理实测有差异的三项,其余一律不碰;
 * 每项都先判断「当前值是否已经可信」,可信就不覆盖。
 */
export function stealthScript(profile: StealthProfile): string {
  const payload = JSON.stringify({
    windowX: WINDOW_CHROME.x,
    windowY: WINDOW_CHROME.y,
    screenWidth: profile.screen.width,
    screenHeight: profile.screen.height,
    deviceScaleFactor: profile.deviceScaleFactor,
  })
  return `(() => {
  'use strict'
  const cfg = ${payload}

  // outer 恒等于 inner 是无头环境最稳的单点特征:真机的窗口装饰总是占位。
  const decorate = (key, delta) => {
    try {
      Object.defineProperty(window, key, {
        configurable: true,
        enumerable: true,
        get() {
          const inner = key === 'outerWidth' ? window.innerWidth : window.innerHeight
          return inner + delta
        },
      })
    } catch {}
  }
  if (window.outerWidth === window.innerWidth) decorate('outerWidth', cfg.windowX)
  if (window.outerHeight === window.innerHeight) decorate('outerHeight', cfg.windowY)

  // screen 退化到与视口同尺寸时纠正;已经是真实值就不动。
  if (screen.width === window.innerWidth && screen.height === window.innerHeight) {
    try {
      const proto = Object.getPrototypeOf(screen)
      const values = {
        width: cfg.screenWidth,
        height: cfg.screenHeight,
        availWidth: cfg.screenWidth,
        availHeight: cfg.screenHeight - 48,
      }
      for (const [key, value] of Object.entries(values)) {
        Object.defineProperty(proto, key, { configurable: true, enumerable: true, get: () => value })
      }
    } catch {}
  }

  // 无头容器里 dpr 常被钉成 1;真机随系统缩放变化。
  if (window.devicePixelRatio === 1 && cfg.deviceScaleFactor !== 1) {
    try {
      Object.defineProperty(window, 'devicePixelRatio', {
        configurable: true,
        enumerable: true,
        get: () => cfg.deviceScaleFactor,
      })
    } catch {}
  }
})()`
}

/**
 * 主世界指纹采集脚本。结果以 JSON 字符串返回,避免返回值里出现不可序列化
 * 的对象。采集项只保留检测方最常交叉验证的那些。
 */
export const COLLECT_FINGERPRINT = `(async () => {
  const out = {}
  const n = navigator
  out.userAgent = n.userAgent
  out.appVersion = n.appVersion
  out.platform = n.platform
  out.vendor = n.vendor
  out.languages = n.languages
  out.webdriver = n.webdriver
  out.hardwareConcurrency = n.hardwareConcurrency
  out.deviceMemory = n.deviceMemory
  out.maxTouchPoints = n.maxTouchPoints
  out.plugins = n.plugins.length
  out.mimeTypes = n.mimeTypes.length
  out.pdfViewerEnabled = n.pdfViewerEnabled
  out.userAgentData = n.userAgentData ? n.userAgentData.toJSON() : null
  out.window = {
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    screenX: window.screenX,
    screenY: window.screenY,
  }
  out.screen = {
    width: screen.width,
    height: screen.height,
    availWidth: screen.availWidth,
    availHeight: screen.availHeight,
    colorDepth: screen.colorDepth,
  }
  out.chrome = window.chrome ? Object.keys(window.chrome) : null
  out.notification = typeof Notification === 'undefined' ? null : Notification.permission
  out.visibility = document.visibilityState
  out.hasFocus = document.hasFocus()
  // Worker 有自己的 navigator,读的是 profile 的语言偏好而不是主世界的覆盖值。
  // 检测方普遍用「主线程 vs Worker」交叉验证,所以这里必须一起采。
  // Worker 消息是异步的,整个采集因此返回 Promise,调用方需开 awaitPromise。
  const probeWorker = () => new Promise((resolve) => {
    let settled = false
    const done = (value) => { if (!settled) { settled = true; resolve(value) } }
    const timer = setTimeout(() => done({ error: 'timeout' }), 2000)
    try {
      const src = 'self.onmessage=function(){postMessage({language:navigator.language,languages:[].slice.call(navigator.languages||[])})}'
      const worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })))
      worker.onmessage = (event) => { clearTimeout(timer); worker.terminate(); done(event.data) }
      worker.onerror = (event) => { clearTimeout(timer); worker.terminate(); done({ error: String(event.message || 'worker-error') }) }
      worker.postMessage(0)
    } catch (error) {
      clearTimeout(timer)
      done({ error: String(error && error.message ? error.message : error) })
    }
  })
  try {
    const gl = document.createElement('canvas').getContext('webgl')
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    out.webgl = ext
      ? { vendor: gl.getParameter(ext.UNMASKED_VENDOR_WEBGL), renderer: gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) }
      : null
  } catch (error) {
    out.webgl = null
  }
  out.worker = await probeWorker()
  return JSON.stringify(out)
})()`

export interface FingerprintCheck {
  /** 检查项名;与指纹字段同名时便于对照。 */
  name: string
  ok: boolean
  detail: string
}

/**
 * 把采集结果对着一份预期档位检查一遍。
 *
 * 只查「必然矛盾」的项目:一类是真机不会出现的值(无头标记、outer 等于
 * inner),一类是与伪装档位自相矛盾的值(屏幕比视口还小)。
 */
export function auditFingerprint(
  facts: Record<string, unknown>,
  expected: StealthProfile | null,
  humanize: boolean,
): FingerprintCheck[] {
  const checks: FingerprintCheck[] = []
  const ua = typeof facts.userAgent === 'string' ? facts.userAgent : ''
  checks.push({
    name: 'userAgent',
    ok: !isHeadlessUserAgent(ua),
    detail: isHeadlessUserAgent(ua) ? 'UA 仍带 HeadlessChrome,这是最硬的无头特征' : 'UA 不含无头标记',
  })

  const windowFacts = isRecord(facts.window) ? facts.window : {}
  const outerWidth = numberOf(windowFacts.outerWidth)
  const outerHeight = numberOf(windowFacts.outerHeight)
  const innerWidth = numberOf(windowFacts.innerWidth)
  const innerHeight = numberOf(windowFacts.innerHeight)
  const sameWidth = outerWidth !== undefined && innerWidth !== undefined && outerWidth <= innerWidth
  const sameHeight = outerHeight !== undefined && innerHeight !== undefined && outerHeight <= innerHeight
  checks.push({
    name: 'windowFrame',
    ok: !sameWidth && !sameHeight,
    detail:
      sameWidth || sameHeight
        ? `outer(${outerWidth}x${outerHeight}) 未大于 inner(${innerWidth}x${innerHeight}):缺少窗口装饰`
        : `outer(${outerWidth}x${outerHeight}) > inner(${innerWidth}x${innerHeight})`,
  })

  const screenFacts = isRecord(facts.screen) ? facts.screen : {}
  const screenWidth = numberOf(screenFacts.width)
  const screenHeight = numberOf(screenFacts.height)
  // 屏幕恰好等于视口是无头的典型退化:真机的屏幕总是大于可绘制区域。
  const screenDegenerate =
    screenWidth !== undefined &&
    screenHeight !== undefined &&
    innerWidth !== undefined &&
    innerHeight !== undefined &&
    screenWidth === innerWidth &&
    screenHeight === innerHeight
  checks.push({
    name: 'screen',
    ok:
      screenWidth !== undefined &&
      screenHeight !== undefined &&
      innerWidth !== undefined &&
      innerHeight !== undefined &&
      screenWidth >= innerWidth &&
      screenHeight >= innerHeight &&
      !screenDegenerate,
    detail:
      screenWidth !== undefined && screenHeight !== undefined
        ? `screen ${screenWidth}x${screenHeight},视口 ${innerWidth}x${innerHeight}${screenDegenerate ? '(屏幕退化成视口尺寸)' : ''}`
        : '拿不到屏幕尺寸',
  })

  checks.push({
    name: 'webdriver',
    ok: facts.webdriver !== true,
    detail: facts.webdriver === true ? 'navigator.webdriver 为 true' : 'navigator.webdriver 为 false',
  })

  const chromeKeys = Array.isArray(facts.chrome) ? facts.chrome.map(String) : null
  checks.push({
    name: 'chromeObject',
    ok: chromeKeys === null || chromeKeys.includes('app'),
    detail: chromeKeys === null ? 'window.chrome 缺失' : `window.chrome 含 ${chromeKeys.join(',')}`,
  })

  const renderer = isRecord(facts.webgl) && typeof facts.webgl.renderer === 'string' ? facts.webgl.renderer : ''
  checks.push({
    name: 'webgl',
    ok: !/SwiftShader|llvmpipe|Software/i.test(renderer),
    detail: /SwiftShader|llvmpipe|Software/i.test(renderer) ? `软件渲染:${renderer}` : renderer || '拿不到 WebGL 渲染器',
  })

  // 主线程与 Worker 的语言必须一致。检测方普遍拿这两处交叉验证,而不一致
  // 几乎只可能来自自动化:真实浏览器的 Worker 与主线程读同一份 profile 偏好。
  const worker = isRecord(facts.worker) ? facts.worker : null
  const mainLanguages = Array.isArray(facts.languages) ? facts.languages.map(String) : []
  const workerLanguages = worker && Array.isArray(worker.languages) ? worker.languages.map(String) : null
  // 任一侧没采到就不能判「一致」:缺失不是吻合,放过去等于自检失效。
  const languagesMatch =
    workerLanguages !== null &&
    mainLanguages.length > 0 &&
    JSON.stringify(mainLanguages) === JSON.stringify(workerLanguages)
  checks.push({
    name: 'workerLanguages',
    ok: languagesMatch,
    detail:
      mainLanguages.length === 0
        ? '主线程语言未采到,无法与 Worker 对照'
        : workerLanguages === null
          ? `Worker 语言采样失败:${worker && typeof worker.error === 'string' ? worker.error : '无结果'}`
          : languagesMatch
            ? `Worker 与主线程一致:${mainLanguages.join(',')}`
            : `主线程 ${mainLanguages.join(',')} 但 Worker ${workerLanguages.join(',')}:Worker 读的是 profile 语言偏好,需要用 --accept-lang 对齐`,
  })

  if (expected) {
    const dpr = numberOf(windowFacts.devicePixelRatio)
    checks.push({
      name: 'devicePixelRatio',
      ok: dpr === expected.deviceScaleFactor,
      detail: `dpr=${dpr ?? 'unknown'},期望 ${expected.deviceScaleFactor}`,
    })
  }

  checks.push({
    name: 'humanize',
    ok: humanize,
    detail: humanize ? '鼠标/键入/滚动走人类化轨迹' : '人类化已关闭(事件为一次到位)',
  })
  return checks
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
