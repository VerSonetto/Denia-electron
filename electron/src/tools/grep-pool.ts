// Small worker pool for grep batches.
//
// Repositories change between searches, so there is no persistent index; the
// pool only parallelizes one query. Workers read and scan synchronously, which
// sidesteps the main process's default libuv threadpool and keeps the UI
// responsive. A failed or unavailable pool degrades to main-thread scanning.

import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

import type { GrepPlan } from './grep-pattern.ts'
import type { GrepFileResult } from './grep-scan.ts'
import type { GrepWorkerReply, GrepWorkerRequest } from './grep-worker.ts'

const MAX_WORKERS = Math.max(
  2,
  Math.min(8, os.availableParallelism?.() ?? os.cpus().length ?? 4),
)
const IDLE_MS = 60_000

interface Slot {
  worker: Worker
  busy: boolean
  idle: NodeJS.Timeout | null
}

interface Job {
  files: string[]
  plan: GrepPlan
  maxHits: number
  resolve: (results: GrepFileResult[] | null) => void
}

interface Pending {
  slot: Slot
  job: Job
}

function workerUrl(): URL {
  const built = new URL('./grep-worker.js', import.meta.url)
  if (fs.existsSync(fileURLToPath(built))) return built
  // Source-mode tests and `scripts/serve.ts` run the TS worker directly.
  return new URL(import.meta.url.endsWith('.ts') ? './grep-worker.ts' : './grep-worker.js', import.meta.url)
}

export class GrepPool {
  private readonly slots: Slot[] = []
  private readonly queue: Job[] = []
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private failed = false

  /** How many batches the query scheduler may keep in flight. */
  get size(): number {
    return MAX_WORKERS
  }

  scan(files: string[], plan: GrepPlan, maxHits: number): Promise<GrepFileResult[] | null> {
    if (this.failed || files.length === 0) return Promise.resolve(files.length === 0 ? [] : null)
    return new Promise((resolve) => {
      this.queue.push({ files, plan, maxHits, resolve })
      this.pump()
    })
  }

  private pump(): void {
    while (this.queue.length > 0) {
      const slot = this.acquire()
      if (slot === null) return
      this.run(slot, this.queue.shift()!)
    }
  }

  private acquire(): Slot | null {
    const idle = this.slots.find((slot) => !slot.busy)
    if (idle !== undefined) {
      if (idle.idle !== null) {
        clearTimeout(idle.idle)
        idle.idle = null
      }
      return idle
    }
    if (this.slots.length >= MAX_WORKERS) return null
    let worker: Worker
    try {
      // The nearest package.json is `type: module`, so both the built .js
      // worker and the TS source worker load as ES modules. Do not inherit
      // execArgv: `--test` / `--input-type` would be interpreted by the worker
      // itself and make it exit before running a single batch.
      worker = new Worker(workerUrl(), { execArgv: [] })
    } catch {
      this.fail()
      return null
    }
    const slot: Slot = { worker, busy: false, idle: null }
    worker.unref()
    worker.on('message', (reply: GrepWorkerReply) => this.finish(slot, reply))
    worker.on('error', () => this.fail())
    worker.on('exit', (code) => {
      // Idle termination removes the slot first; only an unexpected exit of a
      // live worker should disable the pool.
      if (code !== 0 && !this.failed && this.slots.includes(slot)) this.fail()
    })
    this.slots.push(slot)
    return slot
  }

  private run(slot: Slot, job: Job): void {
    slot.busy = true
    const id = this.nextId
    this.nextId += 1
    this.pending.set(id, { slot, job })
    const request: GrepWorkerRequest = { id, files: job.files, plan: job.plan, maxHits: job.maxHits }
    try {
      slot.worker.postMessage(request)
    } catch {
      this.pending.delete(id)
      slot.busy = false
      job.resolve(null)
      this.fail()
    }
  }

  private finish(slot: Slot, reply: GrepWorkerReply): void {
    const pending = this.pending.get(reply.id)
    if (pending === undefined) return
    this.pending.delete(reply.id)
    slot.busy = false
    pending.job.resolve(reply.files)
    this.scheduleIdle(slot)
    this.pump()
  }

  private scheduleIdle(slot: Slot): void {
    if (slot.idle !== null) clearTimeout(slot.idle)
    slot.idle = setTimeout(() => {
      slot.idle = null
      if (slot.busy) return
      const index = this.slots.indexOf(slot)
      if (index >= 0) this.slots.splice(index, 1)
      void slot.worker.terminate()
    }, IDLE_MS)
    slot.idle.unref?.()
  }

  /** Terminate every worker and release the pool (tests, shutdown). */
  close(): void {
    for (const slot of this.slots) {
      if (slot.idle !== null) clearTimeout(slot.idle)
      void slot.worker.terminate()
    }
    this.slots.length = 0
    for (const [, pending] of this.pending) pending.job.resolve(null)
    this.pending.clear()
    for (const job of this.queue) job.resolve(null)
    this.queue.length = 0
    this.failed = true
  }

  /** Stop using workers for this process; callers fall back to the main thread. */
  private fail(): void {
    if (this.failed) return
    this.failed = true
    for (const [, pending] of this.pending) pending.job.resolve(null)
    this.pending.clear()
    for (const job of this.queue) job.resolve(null)
    this.queue.length = 0
    for (const slot of this.slots) {
      if (slot.idle !== null) clearTimeout(slot.idle)
      void slot.worker.terminate()
    }
    this.slots.length = 0
  }
}

let shared: GrepPool | null = null

export function getGrepPool(): GrepPool {
  shared ??= new GrepPool()
  return shared
}

export function closeGrepPool(): void {
  shared?.close()
  shared = null
}
