// 对照实验:找出让 Worker 与主世界语言一致的启动参数组合。
// 只用于诊断,不进构建产物。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from '@zhizhuodemao/patchright'

const EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

const PROBE = `(async () => {
  const body = {
    lang: navigator.language,
    langs: [...(navigator.languages || [])],
    mtp: navigator.maxTouchPoints,
    screen: [screen.width, screen.height],
  };
  const src = 'self.onmessage=function(){postMessage({lang:navigator.language,langs:[...(navigator.languages||[])],mtp:navigator.maxTouchPoints})}';
  const w = new Worker(URL.createObjectURL(new Blob([src], {type:'text/javascript'})));
  const worker = await new Promise(r => { w.onmessage = e => r(e.data); w.onerror = e => r({err:String(e.message)}); w.postMessage(1); });
  w.terminate();
  return { main: body, worker };
})()`

const variants = [
  { name: 'A 当前实现(lang + playwright locale)', args: ['--lang=zh-CN'], locale: 'zh-CN' },
  { name: 'B 加 accept-lang', args: ['--lang=zh-CN', '--accept-lang=zh-CN'], locale: 'zh-CN' },
  { name: 'C 只给 accept-lang,不给 locale', args: ['--lang=zh-CN', '--accept-lang=zh-CN'], locale: null },
]

for (const v of variants) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-lang-'))
  let ctx
  try {
    ctx = await chromium.launchPersistentContext(dir, {
      executablePath: EXE,
      headless: false,
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1.5,
      ...(v.locale ? { locale: v.locale } : {}),
      args: ['--headless=new', ...v.args, '--no-first-run', '--no-default-browser-check'],
    })
    const page = await ctx.newPage()
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded' })
    const r = await page.evaluate(PROBE)
    console.log(v.name)
    console.log('  main   :', JSON.stringify(r.main))
    console.log('  worker :', JSON.stringify(r.worker))
  } catch (e) {
    console.log(v.name, 'FAILED', e.message)
  } finally {
    await ctx?.close().catch(() => {})
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
}
