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
  external: ['electron', '@zhizhuodemao/patchright'],
  sourcemap: true,
  logLevel: 'info',
  // `import.meta.dirname` is provided by Node 20.11+ / Electron's Node.
  banner: {
    js: "import { createRequire as __deniaCreateRequire } from 'node:module'; const require = __deniaCreateRequire(import.meta.url);",
  },
})

// The frameless window's preload must be CommonJS: sandboxed preloads do not
// support ESM, and package.json sets "type": "module", hence the .cjs suffix.
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