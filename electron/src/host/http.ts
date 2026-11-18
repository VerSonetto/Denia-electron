import fs from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'

import type { ApprovalAnswer } from '../agent/gate.ts'
import type { ImageData } from '../core/wire.ts'
import { isRecord } from '../core/util.ts'

export function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

export function apiError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  json(res, status, { error: { code, message } })
}

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > 64 * 1024 * 1024) throw new Error('请求体超过 64MB 上限')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  const parsed = JSON.parse(text) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('请求体必须是 JSON 对象')
  }
  return parsed as Record<string, unknown>
}

export function queryNumber(url: URL, key: string): number | undefined {
  const raw = url.searchParams.get(key)
  if (raw === null || raw === '') return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

export function sseHeaders(): Record<string, string> {
  return {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  }
}

export function writeSse(res: ServerResponse, payload: unknown): void {
  if (res.writableEnded || res.destroyed) return
  try {
    res.write(`data: ${JSON.stringify(payload)}\n\n`)
  } catch {
    /* client went away; close handler cleans up */
  }
}

export function mimeOf(file: string): string {
  const ext = path.extname(file).toLowerCase()
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8'
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8'
    case '.css':
      return 'text/css; charset=utf-8'
    case '.json':
    case '.map':
      return 'application/json; charset=utf-8'
    case '.svg':
      return 'image/svg+xml'
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    case '.ico':
      return 'image/x-icon'
    case '.woff':
      return 'font/woff'
    case '.woff2':
      return 'font/woff2'
    case '.ttf':
      return 'font/ttf'
    case '.wasm':
      return 'application/wasm'
    case '.txt':
    case '.md':
      return 'text/plain; charset=utf-8'
    case '.gz':
      return 'application/gzip'
    case '.br':
      return 'application/octet-stream'
    default:
      return 'application/octet-stream'
  }
}

export function notImplemented(res: ServerResponse, pathname: string): void {
  apiError(res, 501, 'not-implemented', `${pathname} 尚未迁移到 TypeScript 宿主`)
}

export function jsonOrError(res: ServerResponse, build: () => unknown): void {
  try {
    json(res, 200, build())
  } catch (error) {
    apiError(res, 400, 'fs/bad-request', errorMessage(error))
  }
}

export function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
}

export function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

export function parseImages(value: unknown): ImageData[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .filter((entry) => typeof entry.mime === 'string' && typeof entry.data === 'string')
    .map((entry) => ({ mime: entry.mime as string, data: entry.data as string }))
}

export function approvalAnswerOf(body: Record<string, unknown>): ApprovalAnswer | null {
  const decision = body.decision
  let choice: ApprovalAnswer['choice']
  switch (decision) {
    // Legacy web UI values and the preset values are both accepted.
    case 'allow-once':
    case 'accept':
      choice = 'accept'
      break
    case 'allow-session':
    case 'accept-for-session':
      choice = 'accept-for-session'
      break
    case 'accept-with-rule':
      choice = 'accept-with-rule'
      break
    case 'reject':
    case 'decline':
      choice = 'decline'
      break
    case 'cancel':
      choice = 'cancel'
      break
    default:
      return null
  }
  const hasPlan =
    body.executeMode !== undefined || body.selection !== undefined || body.feedback !== undefined
  if (!hasPlan) return { choice }
  const selection =
    isRecord(body.selection) &&
    typeof body.selection.provider === 'string' &&
    typeof body.selection.model === 'string'
      ? {
          provider: body.selection.provider,
          model: body.selection.model,
          ...(typeof body.selection.reasoningEffort === 'string'
            ? { reasoningEffort: body.selection.reasoningEffort }
            : {}),
        }
      : undefined
  return {
    choice,
    plan: {
      outcome:
        choice === 'decline' ? 'rejected' : choice === 'cancel' ? 'cancelled' : 'allowed-once',
      ...(body.executeMode === 'full' || body.executeMode === 'auto-edit'
        ? { executeMode: body.executeMode }
        : {}),
      ...(selection ? { selection } : {}),
      ...(typeof body.feedback === 'string' ? { feedback: body.feedback } : {}),
    },
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
