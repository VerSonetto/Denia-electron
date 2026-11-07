// Standalone host for browser-side verification:
//   node scripts/serve.ts
// Prints the bound URL, then serves the web UI and API until Ctrl+C.

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { startHost } from '../src/host/server.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const host = await startHost({
  ...(process.env.DENIA_HOME ? { home: process.env.DENIA_HOME } : {}),
  webDir: process.env.DENIA_WEB_DIR ?? path.resolve(here, '..', '..', 'web', 'dist'),
  port: Number(process.env.DENIA_PORT ?? 43655),
})
console.log(`[serve] ${host.baseUrl} (home: ${host.home})`)

const shutdown = () => {
  void host.close().then(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)