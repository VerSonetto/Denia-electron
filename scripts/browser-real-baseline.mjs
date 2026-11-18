// 真机指纹基线:正常启动一个浏览器(不接 CDP、不加任何自动化参数),
// 让它自己把探测结果 POST 回来。
//
// 这份基线是补丁的目标值:自动化环境里的每个属性都应该与它一致。
//
// 用法:node scripts/browser-real-baseline.mjs [有头|headless-new]
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const EXE = process.env.EXE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const mode = process.argv[2] ?? 'headed'

const PROBE = `(() => {
  const out = {}
  const nav = navigator
  const put = (k, v) => { out[k] = String(v) }
  put('navigator.webdriver', nav.webdriver)
  put('navigator.userAgent', nav.userAgent)
  put('navigator.appVersion', nav.appVersion)
  put('navigator.platform', nav.platform)
  put('navigator.vendor', nav.vendor)
  put('navigator.language', nav.language)
  put('navigator.languages', JSON.stringify(nav.languages))
  put('navigator.hardwareConcurrency', nav.hardwareConcurrency)
  put('navigator.deviceMemory', nav.deviceMemory)
  put('navigator.maxTouchPoints', nav.maxTouchPoints)
  put('navigator.plugins.length', nav.plugins.length)
  put('navigator.plugins[0].name', nav.plugins[0] && nav.plugins[0].name)
  put('navigator.mimeTypes.length', nav.mimeTypes.length)
  put('navigator.pdfViewerEnabled', nav.pdfViewerEnabled)
  put('navigator.userAgentData.brands', JSON.stringify(nav.userAgentData && nav.userAgentData.brands))
  put('navigator.userAgentData.mobile', nav.userAgentData && nav.userAgentData.mobile)
  put('navigator.userAgentData.platform', nav.userAgentData && nav.userAgentData.platform)
  put('window.chrome', typeof window.chrome)
  put('window.chrome.runtime', typeof (window.chrome && window.chrome.runtime))
  put('window.chrome.app', typeof (window.chrome && window.chrome.app))
  put('chrome.runtime.id', (() => { try { return window.chrome.runtime.id } catch (e) { return '(throws) ' + e.name } })())
  put('outer-inner', (window.outerWidth - window.innerWidth) + 'x' + (window.outerHeight - window.innerHeight))
  put('outer', window.outerWidth + 'x' + window.outerHeight)
  put('inner', window.innerWidth + 'x' + window.innerHeight)
  put('screen', screen.width + 'x' + screen.height + ' @' + screen.availWidth + 'x' + screen.availHeight)
  put('screen.colorDepth', screen.colorDepth)
  put('devicePixelRatio', window.devicePixelRatio)
  put('Notification.permission', typeof Notification === 'undefined' ? '(none)' : Notification.permission)
  put('permissions.query.constructor', (() => { try { return nav.permissions.query({ name: 'notifications' }).constructor.name } catch (e) { return '(throws)' } })())
  put('visibilityState', document.visibilityState)
  put('hasFocus', document.hasFocus())
  put('Function.toString patched', /\\[native code\\]/.test(Function.prototype.toString.call(nav.permissions.query)) ? 'no' : 'yes')
  try {
    const gl = document.createElement('canvas').getContext('webgl')
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    put('webgl.vendor', ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : '(no ext)')
    put('webgl.renderer', ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '(no ext)')
  } catch (e) { put('webgl.vendor', '(throws)') }
  out.__probe = 'v1'
  return out
})()`

const server = http.createServer((req, res) => {
  if (req.method === 'POST') {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      res.writeHead(204).end()
      finish(JSON.parse(body))
    })
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><meta charset="utf-8"><title>baseline</title><body>probing…<script>
    const result = ${PROBE};
    void fetch('/report', { method: 'POST', body: JSON.stringify(result) });
  </script>`)
})

let child
let done = false
function finish(result) {
  if (done) return
  done = true
  const width = Math.max(...Object.keys(result).map((k) => k.length))
  for (const [key, value] of Object.entries(result)) console.log(`${key.padEnd(width)} = ${value}`)
  child?.kill()
  server.close()
  setTimeout(() => process.exit(0), 200).unref()
}

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port
  const profile = path.join(os.tmpdir(), `denia-real-baseline-${mode}-${Date.now()}`)
  fs.mkdirSync(profile, { recursive: true })
  const args = [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check']
  if (mode === 'headless-new') args.push('--headless=new', '--window-size=1440,900')
  args.push(`http://127.0.0.1:${port}/`)
  console.log(`# mode=${mode} exe=${EXE}`)
  child = spawn(EXE, args, { stdio: 'ignore', detached: false })
  setTimeout(() => finish({ error: '超时:浏览器没有回传结果' }), 60_000).unref()
})
