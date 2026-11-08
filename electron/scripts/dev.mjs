import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { copyFileSync, mkdirSync } from 'node:fs'

const require = createRequire(import.meta.url)

mkdirSync('dist', { recursive: true })

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist/main.js',
  external: ['electron'],
  sourcemap: true,
  logLevel: 'info',
  banner: {
    js: "import { createRequire as __deniaCreateRequire } from 'node:module'; const require = __deniaCreateRequire(import.meta.url);",
  },
})

await build({
  entryPoints: ['src/preload.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: 'dist/preload.cjs',
  external: ['electron'],
  logLevel: 'info',
})

// 启动占位页与 main.js 同目录,由 file:// 直接加载。
copyFileSync('src/splash.html', 'dist/splash.html')

// Resolve the real Electron binary instead of the `.bin` shell wrapper: with
// `shell: true` a forward-slash relative path is parsed as `node_modules` by
// cmd on Windows.
const electron = require('electron')
const child = spawn(electron, ['.'], {
  stdio: 'inherit',
  env: process.env,
})
child.on('exit', (code) => process.exit(code ?? 0))