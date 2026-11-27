// Fetch the official cloudflared binary for the current build platform and put
// it in electron/resources/cloudflared so the packaged app starts public access
// without a runtime download. Optional: if the download fails, packaging still
// proceeds and the host falls back to its runtime download path.
//
// Set DENIA_CLOUDFLARED_MIRROR to a prefix that mirrors the GitHub release
// assets, e.g. https://gh-proxy.com/https://github.com/cloudflare/cloudflared/releases/latest/download

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const outputDir = path.resolve(here, '..', 'resources', 'cloudflared')
const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'ia32' ? '386' : 'amd64'
const name = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
const target = path.join(outputDir, name)

const asset = process.platform === 'win32'
  ? `cloudflared-windows-${arch}.exe`
  : process.platform === 'darwin'
    ? `cloudflared-darwin-${arch}.tgz`
    : `cloudflared-linux-${arch}`
const base = process.env.DENIA_CLOUDFLARED_MIRROR?.trim()
  || 'https://github.com/cloudflare/cloudflared/releases/latest/download'
const url = `${base.replace(/\/+$/, '')}/${asset}`

if (fs.existsSync(target)) {
  console.log(`[fetch-cloudflared] already present: ${target}`)
  process.exit(0)
}

await fsp.mkdir(outputDir, { recursive: true })
const temp = `${target}.download`

try {
  console.log(`[fetch-cloudflared] downloading ${url}`)
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'denia-build' },
    signal: AbortSignal.timeout(240_000),
  })
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
  const file = await fsp.open(temp, 'w', 0o600)
  try {
    for await (const chunk of Readable.fromWeb(response.body)) {
      await file.write(chunk)
    }
  } finally {
    await file.close()
  }
  const stat = await fsp.stat(temp)
  if (stat.size < 1_000_000) throw new Error(`downloaded file is too small (${stat.size} bytes)`)

  if (process.platform === 'darwin') {
    await new Promise((resolve, reject) => {
      const tar = spawn('tar', ['-xzf', temp, '-C', outputDir], { stdio: 'inherit' })
      tar.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))))
      tar.once('error', reject)
    })
    await fsp.rm(temp, { force: true })
  } else {
    await fsp.rename(temp, target)
  }
  await fsp.chmod(target, 0o755)
  console.log(`[fetch-cloudflared] saved ${target}`)
} catch (error) {
  await fsp.rm(temp, { force: true }).catch(() => {})
  console.warn(`[fetch-cloudflared] skipped: ${error instanceof Error ? error.message : String(error)}`)
  console.warn('[fetch-cloudflared] the app will try to download cloudflared at runtime')
}
