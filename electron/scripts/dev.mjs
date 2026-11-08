import { spawn } from 'node:child_process'
import { build } from 'esbuild'
import { copyFileSync, mkdirSync } from 'node:fs'

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

const electron = process.platform === 'win32' ? 'node_modules/.bin/electron.cmd' : 'node_modules/.bin/electron'
const child = spawn(electron, ['.'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: process.env,
})
child.on('exit', (code) => process.exit(code ?? 0))