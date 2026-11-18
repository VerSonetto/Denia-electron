// 伪装效果对照:把「旧配置」与「仓库里真实实现的伪装」并排跑一遍。
//
// 所有探针在主世界取值(页面解析期写入 document.title),因为 Playwright 的
// `evaluate` 跑在隔离世界,读到的 `window.chrome` 是副本,会给出假差异。
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(new URL('../electron/package.json', import.meta.url))
const patchright = await import(pathToFileURL(require.resolve('@zhizhuodemao/patchright')).href)
const chromium = patchright.chromium ?? patchright.default?.chromium

const { probeUserAgent } = await import(pathToFileURL(path.resolve('electron/src/browser/chrome.ts')).href)
const { buildProfile, stealthArgs, stealthScript } = await import(
  pathToFileURL(path.resolve('electron/src/browser/stealth.ts')).href
)

const EXE = process.env.EXE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'

/** 主世界探针:结果写进 title,不受隔离世界影响。 */
const PROBE = `(() => {
  const o = {}
  const n = navigator
  o.ua = n.userAgent
  o.uaBrands = JSON.stringify(n.userAgentData && n.userAgentData.brands)
  o.webdriver = n.webdriver
  o.languages = JSON.stringify(n.languages)
  o.outer = outerWidth + 'x' + outerHeight
  o.inner = innerWidth + 'x' + innerHeight
  o.outerMinusInner = (outerWidth - innerWidth) + 'x' + (outerHeight - innerHeight)
  o.dpr = devicePixelRatio
  o.screen = screen.width + 'x' + screen.height
  o.avail = screen.availWidth + 'x' + screen.availHeight
  o.chrome = Object.keys(window.chrome || {}).join(',')
  o.chromeApp = typeof (window.chrome && window.chrome.app)
  o.notification = typeof Notification === 'undefined' ? 'none' : Notification.permission
  o.plugins = n.plugins.length
  o.mimeTypes = n.mimeTypes.length
  o.hardwareConcurrency = n.hardwareConcurrency
  o.deviceMemory = n.deviceMemory
  o.maxTouchPoints = n.maxTouchPoints
  o.visibility = document.visibilityState
  o.hasFocus = document.hasFocus()
  try {
    const gl = document.createElement('canvas').getContext('webgl')
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    o.webgl = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'no-ext'
  } catch (error) { o.webgl = 'error' }
  return JSON.stringify(o)
})()`

const server = http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(`<!doctype html><meta charset="utf-8"><title>probe</title><body><script>document.title = ${PROBE}</script></body>`)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}/`

async function sample(label, launchOptions, inject) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-cmp-'))
  let context
  try {
    context = await chromium.launchPersistentContext(profile, { executablePath: EXE, ...launchOptions })
    const page = context.pages()[0] ?? (await context.newPage())
    if (inject) {
      const session = await context.newCDPSession(page)
      await session.send('Page.enable')
      await session.send('Page.addScriptToEvaluateOnNewDocument', { source: inject })
    }
    await page.goto(origin)
    const value = JSON.parse(await page.title())
    console.log(`\n### ${label}`)
    for (const [key, entry] of Object.entries(value)) {
      console.log(`  ${key.padEnd(20)} ${String(entry)}`)
    }
    return value
  } finally {
    await context?.close().catch(() => undefined)
    fs.rmSync(profile, { recursive: true, force: true })
  }
}

// —— 旧配置:Playwright 自己的 headless 开关。
const before = await sample('BEFORE  (playwright headless)', {
  headless: true,
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
})

// —— 新配置:与 manager 实际走的分支一致。
const realUserAgent = await probeUserAgent(EXE)
console.log('\nprobed UA:', realUserAgent)
const profile = buildProfile({ userAgent: realUserAgent ?? '', viewport: { width: 1440, height: 900 } })
const after = await sample(
  'AFTER   (stealth)',
  {
    headless: false,
    viewport: profile.viewport,
    deviceScaleFactor: profile.deviceScaleFactor,
    locale: profile.locale,
    userAgent: profile.userAgent,
    args: stealthArgs(profile),
  },
  stealthScript(profile),
)

server.close()

// —— 差异汇总:只列真正变化的项,避免噪声。
console.log('\n### diff')
for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
  if (String(before[key]) === String(after[key])) continue
  console.log(`  ${key}\n    before: ${before[key]}\n    after : ${after[key]}`)
}
