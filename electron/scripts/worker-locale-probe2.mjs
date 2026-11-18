// 对照实验:持久 profile 已存 intl.accept_languages=en-US,en 时,
// 哪种手段能让 Worker 与主世界语言一致。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from '@zhizhuodemao/patchright'

const EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

const PROBE = `(async () => {
  const src = 'self.onmessage=function(){postMessage({lang:navigator.language,langs:[...(navigator.languages||[])]})}';
  const w = new Worker(URL.createObjectURL(new Blob([src], {type:'text/javascript'})));
  const worker = await new Promise(r => { w.onmessage = e => r(e.data); w.onerror = e => r({err:String(e.message)}); w.postMessage(1); });
  w.terminate();
  return { mainLang: navigator.language, mainLangs: [...(navigator.languages||[])], worker };
})()`

/** 造一个「已存 en-US」的 profile,模拟真实持久 profile。 */
function makeProfileWithEnglish() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-pref-'))
  fs.mkdirSync(path.join(dir, 'Default'), { recursive: true })
  const prefs = { intl: { accept_languages: 'en-US,en', selected_languages: 'en-US,en' } }
  fs.writeFileSync(path.join(dir, 'Default', 'Preferences'), JSON.stringify(prefs))
  return dir
}

const variants = [
  { name: 'A 仅 --lang + playwright locale(当前实现)', args: ['--lang=zh-CN'], locale: 'zh-CN' },
  { name: 'B 加 --accept-lang', args: ['--lang=zh-CN', '--accept-lang=zh-CN'], locale: 'zh-CN' },
  { name: 'C 加 --accept-lang 且不给 locale', args: ['--lang=zh-CN', '--accept-lang=zh-CN'], locale: null },
]

for (const v of variants) {
  const dir = makeProfileWithEnglish()
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
    const match = JSON.stringify(r.mainLangs) === JSON.stringify(r.worker.langs)
    console.log(v.name)
    console.log('  main   :', r.mainLang, JSON.stringify(r.mainLangs))
    console.log('  worker :', r.worker.lang, JSON.stringify(r.worker.langs))
    console.log('  一致   :', match ? 'YES' : 'NO')
  } catch (e) {
    console.log(v.name, 'FAILED', e.message)
  } finally {
    await ctx?.close().catch(() => {})
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
}
