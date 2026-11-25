// Grep worker: synchronous reads and scanning off the main thread. The pool
// sends one batch at a time; results are returned in input order.

import { parentPort } from 'node:worker_threads'

import type { GrepPlan } from './grep-pattern.ts'
import { buildRegex, GREP_MAX_FILE_BYTES, scanGrepFileSync } from './grep-scan.ts'
import type { GrepFileResult } from './grep-scan.ts'

export interface GrepWorkerRequest {
  id: number
  files: string[]
  plan: GrepPlan
  maxHits: number
}

export interface GrepWorkerReply {
  id: number
  files: GrepFileResult[]
}

// One scratch buffer per worker; files above the grep size cap are skipped
// before they are read, so this covers every eligible file.
const scratch = Buffer.allocUnsafe(GREP_MAX_FILE_BYTES)

parentPort?.on('message', (request: GrepWorkerRequest) => {
  const regex = buildRegex(request.plan)
  const files = request.files.map((file) =>
    scanGrepFileSync(file, request.plan, regex, request.maxHits, scratch),
  )
  const reply: GrepWorkerReply = { id: request.id, files }
  parentPort?.postMessage(reply)
})
