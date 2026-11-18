// 端到端:self-check 走真实的 BrowserManager,验证 fingerprint 命令能打通
// 「启动 → 注入 → 主世界采集 → 对照报告」整条链路。
//
// 用法:node scripts/browser-selfcheck.mjs [有头]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-selfcheck-'))
process.env.DENIA_BROWSER_IDLE_SECS = '0'

const { BrowserManager } = await import(pathToFileURL(path.resolve('electron/src/browser/manager.ts')).href)

const manager = new BrowserManager({ home })
const run = async (command) => {
  const outcome = await manager.execute(command)
  if (!outcome.ok) throw new Error(`${command.method} failed: ${outcome.error?.code} ${outcome.error?.message}`)
  return outcome
}

const server = (await import('node:http')).createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end('<!doctype html><meta charset="utf-8"><title>selfcheck</title><body>ok</body>')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}/`

try {
  await run({ method: 'getState' })
  await run({ method: 'navigate', url: origin })
  const fingerprint = await run({ method: 'fingerprint' })
  const value = fingerprint.value
  console.log('\n— subject —')
  for (const [key, entry] of Object.entries(value.subject)) {
    if (key === 'appVersion' || key === 'userAgentData') continue
    console.log(`  ${key.padEnd(20)} ${JSON.stringify(entry)}`)
  }
  console.log('\n— checks —')
  for (const check of value.checks) {
    console.log(`  ${check.ok ? 'PASS' : 'FAIL'}  ${check.name.padEnd(20)} ${check.detail}`)
  }
  const failed = value.checks.filter((check) => !check.ok)
  console.log(`\n${failed.length === 0 ? 'all checks passed' : `${failed.length} check(s) failed`}`)
} finally {
  await manager.execute({ method: 'shutdownBrowser' })
  server.close()
  fs.rmSync(home, { recursive: true, force: true })
}
