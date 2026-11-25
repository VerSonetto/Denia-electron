// One file's scan, shared by the main thread and grep workers.
//
// The fast path never decodes files that cannot match: a mandatory literal is
// searched in the raw bytes first, and a plain-literal pattern extracts hit
// lines straight from the buffer. Regex verification only runs on files that
// survive the prefilter.

import fs from 'node:fs'

import type { GrepPlan } from './grep-pattern.ts'

export const GREP_MAX_FILE_BYTES = 2 * 1024 * 1024

export interface GrepHit {
  line: number
  text: string
}

export interface GrepFileResult {
  scanned: boolean
  hits: GrepHit[]
}

const EMPTY: GrepFileResult = { scanned: false, hits: [] }

function containsLiteral(buffer: Buffer, literal: string, ignoreCase: boolean): boolean {
  if (!ignoreCase) return buffer.indexOf(Buffer.from(literal, 'utf8')) >= 0
  // Latin-1 maps one byte to one code unit, so lowercasing cannot move byte
  // offsets. The planner only allows ASCII literals here, and JS's non-`u`
  // case folding never maps non-ASCII text to an ASCII letter (confirmed by
  // the differential tests), making this an exact prefilter.
  return buffer.toString('latin1').toLowerCase().includes(literal.toLowerCase())
}

/**
 * Plain literal: find occurrences in the raw buffer, expand each to its line,
 * and decode only those lines. Multiple occurrences on one line are one hit,
 * matching the per-line regex contract.
 */
function scanPureLiteral(
  buffer: Buffer,
  literal: string,
  ignoreCase: boolean,
  maxHits: number,
): GrepHit[] {
  // For ignore_case the haystack is latin1+lowercase (one char per byte), so
  // the offset is still the exact byte offset used by the line walk below.
  const haystack = ignoreCase ? buffer.toString('latin1').toLowerCase() : null
  const needle = ignoreCase ? literal.toLowerCase() : Buffer.from(literal, 'utf8')
  if (needle.length === 0) return []
  const hits: GrepHit[] = []
  let from = 0
  let lineStart = 0
  let line = 1
  let countedTo = 0
  while (true) {
    const found =
      typeof needle === 'string' ? haystack!.indexOf(needle, from) : buffer.indexOf(needle, from)
    if (found < 0) break
    // Occurrences are visited in order, so newline tracking is linear overall.
    for (let index = countedTo; index < found; index += 1) {
      if (buffer[index] === 10) {
        line += 1
        lineStart = index + 1
      }
    }
    countedTo = found
    let lineEnd = buffer.indexOf(10, found)
    if (lineEnd < 0) lineEnd = buffer.length
    const text = buffer.toString('utf8', lineStart, lineEnd)
    hits.push({ line, text: text.length > 400 ? text.slice(0, 400) : text })
    if (hits.length >= maxHits) break
    if (lineEnd >= buffer.length) break
    from = lineEnd + 1
  }
  return hits
}

export function scanGrepBuffer(
  buffer: Buffer,
  plan: GrepPlan,
  regex: RegExp | null,
  maxHits: number,
): GrepFileResult {
  if (plan.pure !== null) {
    const hits = scanPureLiteral(buffer, plan.pure, plan.ignoreCase, maxHits)
    // A binary file that happens to contain the literal must still be skipped.
    // No-hit files need no NUL scan at all; this is the common case.
    if (hits.length > 0 && buffer.includes(0)) return EMPTY
    return { scanned: true, hits }
  }
  if (plan.literal !== null) {
    if (!containsLiteral(buffer, plan.literal, plan.ignoreCase)) {
      return { scanned: true, hits: [] }
    }
    if (buffer.includes(0)) return EMPTY
  } else if (buffer.includes(0)) {
    // Matches the old text-level NUL check: binary files never produce hits
    // and are not counted as scanned.
    return EMPTY
  }
  const pattern = regex ?? buildRegex(plan)
  if (pattern === null) return { scanned: true, hits: [] }
  const text = buffer.toString('utf8')
  const lines = text.split('\n')
  const hits: GrepHit[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    if (!pattern.test(line)) continue
    hits.push({ line: index + 1, text: line.length > 400 ? line.slice(0, 400) : line })
    if (hits.length >= maxHits) break
  }
  return { scanned: true, hits }
}

export function buildRegex(plan: GrepPlan): RegExp | null {
  if (plan.pure !== null) return null
  try {
    return new RegExp(plan.source, plan.flags)
  } catch {
    return null
  }
}

/**
 * Synchronous read used by workers (one open + fstat + read per file).
 * `scratch` lets a worker reuse one buffer across files; scanGrepBuffer never
 * retains it, so this is safe and removes thousands of allocations per query.
 */
export function scanGrepFileSync(
  absolute: string,
  plan: GrepPlan,
  regex: RegExp | null,
  maxHits: number,
  scratch?: Buffer,
): GrepFileResult {
  let fd: number | null = null
  try {
    fd = fs.openSync(absolute, 'r')
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size > GREP_MAX_FILE_BYTES) return EMPTY
    const buffer =
      scratch !== undefined && scratch.length >= stat.size
        ? scratch.subarray(0, stat.size)
        : Buffer.allocUnsafe(stat.size)
    let offset = 0
    while (offset < stat.size) {
      const read = fs.readSync(fd, buffer, offset, stat.size - offset, offset)
      if (read <= 0) break
      offset += read
    }
    return scanGrepBuffer(
      offset === buffer.length ? buffer : buffer.subarray(0, offset),
      plan,
      regex,
      maxHits,
    )
  } catch {
    return EMPTY
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        /* already closed by a failed open path */
      }
    }
  }
}

/** Small main-thread batches and the worker-failure fallback. */
export async function scanGrepFilesAsync(
  files: readonly string[],
  plan: GrepPlan,
  maxHits: number,
  concurrency: number,
): Promise<GrepFileResult[]> {
  const results = new Array<GrepFileResult>(files.length)
  const regex = buildRegex(plan)
  let next = 0
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, files.length)) },
    async () => {
      while (true) {
        const index = next
        next += 1
        if (index >= files.length) return
        try {
          const stat = await fs.promises.stat(files[index]!)
          if (!stat.isFile() || stat.size > GREP_MAX_FILE_BYTES) {
            results[index] = EMPTY
            continue
          }
          const buffer = await fs.promises.readFile(files[index]!)
          results[index] = scanGrepBuffer(buffer, plan, regex, maxHits)
        } catch {
          results[index] = EMPTY
        }
      }
    },
  )
  await Promise.all(workers)
  return results
}
