import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
const directory = mkdtempSync(join(tmpdir(), 'denia-extensions-'))
try {
  const output = join(directory, 'route.mjs')
  await build({ entryPoints: [join(root, 'src/extensionsRoute.ts')], outfile: output, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const { extensionTabFromHash } = await import(pathToFileURL(output).href)
  assert.equal(extensionTabFromHash('#extensions'), 'skills')
  assert.equal(extensionTabFromHash('#extensions/skills'), 'skills')
  assert.equal(extensionTabFromHash('#extensions/mcp'), 'mcp')
  for (const hash of ['', '#s=123', '#extensions/unknown', '#extensions/mcp/extra']) assert.equal(extensionTabFromHash(hash), null)
  const app = readFileSync(join(root, 'src/App.tsx'), 'utf8')
  assert.ok(app.indexOf('sidebar-extensions-btn') > app.indexOf("{t('newSession')}"), '拓展管理入口必须在新建会话下方')
  const settings = readFileSync(join(root, 'src/pages/SettingsPage.tsx'), 'utf8')
  assert.ok(!settings.includes("'mcp'") && !settings.includes('onOpenExtensions'), '设置中不再保留 MCP 或拓展管理入口')
  assert.ok(app.includes('!isMobile && !extensionTab'), '管理页面不应被会话侧面板挤占')
  assert.ok(app.includes('if (tab) return'), '拓展路由不应清除当前会话')
  const page = readFileSync(join(root, 'src/pages/ExtensionsPage.tsx'), 'utf8')
  assert.ok(page.includes('role="tablist"') && page.includes('role="tabpanel"'))
  assert.ok(page.includes("event.key === 'ArrowRight'"), '标签支持键盘切换')
  console.log('ok extensions routes, navigation placement, session isolation and accessible tabs')
} finally {
  rmSync(directory, { recursive: true, force: true })
}
