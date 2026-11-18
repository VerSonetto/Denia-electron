// Dev launcher: build the Electron host, start the Vite console with HMR, then
// point the window at Vite. `npm start`/packaged builds still serve web/dist;
// this script is the development path that gives instant frontend reloads.

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'

const require = createRequire(import.meta.url)
const electronRoot = path.resolve(import.meta.dirname, '..')
const webRoot = path.resolve(electronRoot, '..', 'web')
const API_PORT = Number(process.env.DENIA_PORT ?? 43655)
const VITE_PORT = Number(process.env.DENIA_VITE_PORT ?? 5173)
const apiUrl = process.env.DENIA_API_URL?.trim() || `http://127.0.0.1:${API_PORT}`
const externalWebUrl = process.env.DENIA_WEB_URL?.trim()
const viteUrl = `http://127.0.0.1:${VITE_PORT}`

let vite = null
let electronChild = null
let shuttingDown = false

function stop(child) {
  if (!child || child.exitCode !== null) return
  child.kill()
  // Vite/Electron normally exit on SIGTERM; force the direct child if not.
  setTimeout(() => {
    if (child.exitCode === null) child.kill('SIGKILL')
  }, 2000).unref()
}

function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  stop(vite)
  stop(electronChild)
  process.exit(code)
}

async function portAvailable(port) {
  return await new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
}

async function startVite() {
  const bin = path.join(webRoot, 'node_modules', 'vite', 'bin', 'vite.js')
  if (!existsSync(bin)) {
    throw new Error(`Vite 未安装:先在 web/ 执行 pnpm install(${bin})`)
  }
  const child = spawn(
    process.execPath,
    [bin, '--host', '127.0.0.1', '--port', String(VITE_PORT), '--strictPort'],
    {
      cwd: webRoot,
      stdio: 'inherit',
      env: { ...process.env, DENIA_API_URL: apiUrl },
    },
  )
  child.on('exit', (code, signal) => {
    if (shuttingDown) return
    console.error(`[dev] Vite 已退出 (${code ?? signal ?? 'unknown'})`)
    shutdown(code ?? 1)
  })
  return child
}

async function waitForVite(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (vite === null || vite.exitCode !== null) {
      throw new Error('Vite 启动失败;请检查端口占用或上方日志')
    }
    try {
      const response = await fetch(viteUrl, { signal: AbortSignal.timeout(1000) })
      // 任何 HTTP 响应都说明监听已就绪;404 也优于继续等。
      if (response.status > 0) return
    } catch {
      // 还没起来:继续轮询。
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`等待 Vite 超时:${viteUrl}`)
}

async function buildHost() {
  mkdirSync(path.join(electronRoot, 'dist'), { recursive: true })

  await build({
    entryPoints: [path.join(electronRoot, 'src/main.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: path.join(electronRoot, 'dist/main.js'),
    external: ['electron', '@zhizhuodemao/patchright'],
    sourcemap: true,
    logLevel: 'info',
    banner: {
      js: "import { createRequire as __deniaCreateRequire } from 'node:module'; const require = __deniaCreateRequire(import.meta.url);",
    },
  })

  await build({
    entryPoints: [path.join(electronRoot, 'src/preload.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile: path.join(electronRoot, 'dist/preload.cjs'),
    external: ['electron'],
    logLevel: 'info',
  })

  // 启动占位页与 main.js 同目录,由 file:// 直接加载。
  copyFileSync(
    path.join(electronRoot, 'src/splash.html'),
    path.join(electronRoot, 'dist/splash.html'),
  )
}

async function main() {
  if (!Number.isInteger(API_PORT) || API_PORT <= 0) {
    throw new Error(`DENIA_PORT 必须是固定端口,当前为 ${process.env.DENIA_PORT ?? API_PORT}`)
  }
  if (!Number.isInteger(VITE_PORT) || VITE_PORT <= 0) {
    throw new Error(`DENIA_VITE_PORT 必须是固定端口,当前为 ${process.env.DENIA_VITE_PORT ?? VITE_PORT}`)
  }
  if (!(await portAvailable(API_PORT))) {
    throw new Error(
      `端口 ${API_PORT} 已被占用(可能已有一个 Denia 在运行)。请先关闭它,或用 DENIA_PORT=其他端口 npm run dev。`,
    )
  }

  if (!externalWebUrl) {
    console.log(`[dev] Vite ${viteUrl}  →  /api ${apiUrl}`)
    vite = await startVite()
  } else {
    console.log(`[dev] 使用已有前端地址 ${externalWebUrl}`)
  }

  await buildHost()
  if (!externalWebUrl) await waitForVite()

  const electron = require('electron')
  const webUrl = externalWebUrl ?? viteUrl
  const userDataDir = process.env.DENIA_USER_DATA_DIR?.trim()
  electronChild = spawn(electron, userDataDir ? ['.', `--user-data-dir=${userDataDir}`] : ['.'], {
    cwd: electronRoot,
    stdio: 'inherit',
    env: { ...process.env, DENIA_WEB_URL: webUrl, DENIA_API_URL: apiUrl },
  })
  electronChild.on('exit', (code) => shutdown(code ?? 0))
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

main().catch((error) => {
  console.error(`[dev] 启动失败:${error instanceof Error ? error.message : String(error)}`)
  shutdown(1)
})