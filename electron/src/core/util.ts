// Small shared helpers: ids, clock, truncation, JSON parsing.

import { randomBytes } from 'node:crypto'

export function nowMillis(): number {
  return Date.now()
}

export function newSessionId(): string {
  const stamp = Date.now().toString(36)
  const random = randomBytes(4).toString('hex')
  return `s_${stamp}_${random}`
}

export function newRequestId(): string {
  return `req_${randomBytes(8).toString('hex')}`
}

/** Truncate by Unicode code points (never splits a surrogate pair). */
export function truncateChars(text: string, max: number, marker: string): [string, boolean] {
  if (text.length <= max) return [text, false]
  const points = Array.from(text)
  if (points.length <= max) return [text, false]
  return [points.slice(0, max).join('') + marker, true]
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}