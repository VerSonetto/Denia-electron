// Tool-result budgets and the artifact store behind `read_tool_output`.
//
// One character cap for every tool does two bad things: a command dump loses
// the part that matters (the tail), and a small search result is padded out to
// the same ceiling. Each tool therefore has its own budget and preview
// direction, and anything over budget keeps its full text in a session
// artifact the model can page through instead of asking for a re-run.

import type { SessionStore } from '../session/store.ts'

export interface ToolOutputBudget {
  /** Characters kept in the model-visible preview. */
  max: number
  /** Characters kept from the head of the output. */
  head: number
  /** Characters kept from the tail of the output. */
  tail: number
}

/** Default for tools whose output is prose or a short list. */
const DEFAULT_BUDGET: ToolOutputBudget = { max: 32_000, head: 32_000, tail: 0 }

/**
 * Per-tool budgets. Command-like tools keep their tail (errors and summaries
 * land there); search-like tools keep their head (hits are ordered).
 */
const BUDGETS: Record<string, ToolOutputBudget> = {
  bash: { max: 30_000, head: 4_000, tail: 26_000 },
  run_checks: { max: 30_000, head: 4_000, tail: 26_000 },
  job_output: { max: 30_000, head: 4_000, tail: 26_000 },
  grep: { max: 20_000, head: 20_000, tail: 0 },
  glob: { max: 20_000, head: 20_000, tail: 0 },
  ls: { max: 20_000, head: 20_000, tail: 0 },
  read_file: { max: 32_000, head: 32_000, tail: 0 },
  web_fetch: { max: 32_000, head: 32_000, tail: 0 },
}

export function budgetFor(tool: string): ToolOutputBudget {
  return BUDGETS[tool] ?? DEFAULT_BUDGET
}

export interface OutputStore {
  /** Persist the full text; returns the artifact id the model pages through. */
  save(sessionId: string, callId: string, content: string): string | null
  /** Read a whole artifact back; null when it does not exist. */
  read(sessionId: string, id: string): string | null
}

const ARTIFACT_ID = /^[A-Za-z0-9_-]{1,120}$/

function artifactName(id: string): string {
  return `tool-output-${id}.txt`
}

/** Session-scoped artifact store: `<home>/sessions/<id>/tool-output-<call>.txt`. */
export class SessionOutputStore implements OutputStore {
  private readonly store: SessionStore

  constructor(store: SessionStore) {
    this.store = store
  }

  save(sessionId: string, callId: string, content: string): string | null {
    const base = callId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100)
    if (base === '') return null
    try {
      // Call ids repeat across turns (models like `call_0`); never let a new
      // artifact shadow an older pointer the model may still be paging.
      let id = base
      for (let suffix = 2; this.store.readAuxiliary(sessionId, artifactName(id)) !== null; suffix += 1) {
        id = `${base}-${suffix}`
        if (suffix > 1_000) return null
      }
      this.store.writeAuxiliary(sessionId, artifactName(id), content)
      return id
    } catch {
      // Losing the artifact must not lose the result: the caller falls back to
      // a plain truncation notice.
      return null
    }
  }

  read(sessionId: string, id: string): string | null {
    if (!ARTIFACT_ID.test(id)) return null
    return this.store.readAuxiliary(sessionId, artifactName(id))
  }
}

/** Merge an artifact pointer into a result's existing meta. */
export function withOutputArtifact(
  meta: unknown,
  artifact: { output_id: string; chars: number },
): unknown {
  if (typeof meta === 'object' && meta !== null && !Array.isArray(meta)) {
    return { ...(meta as Record<string, unknown>), outputArtifact: artifact }
  }
  return { outputArtifact: artifact }
}

export interface RenderedPreview {
  content: string
  shownChars: number
}

/**
 * Cut an oversized result down to its budget and point at the artifact.
 *
 * The notice is built first so the preview never pushes the result back over
 * the budget it was trimmed to.
 */
export function renderPreview(
  content: string,
  budget: ToolOutputBudget,
  artifactId: string | null,
): RenderedPreview {
  const chars = Array.from(content)
  const total = chars.length
  if (total <= budget.max) return { content, shownChars: total }
  const noticeFor = (shown: number): string =>
    artifactId === null
      ? `\n\n…[输出已截断:共 ${total} 字符,仅显示 ${shown} 字符。请缩小范围(更精确的 pattern/path),或用 offset/limit 分页获取剩余内容]`
      : `\n\n…[输出已截断:共 ${total} 字符,已显示 ${shown} 字符。完整内容保存为产物 ${artifactId},用 read_tool_output(output_id="${artifactId}", offset=1) 分页回读]`

  // Reserve the notice's own length so the preview never pushes the result
  // back over the budget it was trimmed to.
  const room = Math.max(1, budget.max - Array.from(noticeFor(total)).length)
  const headChars = Math.min(budget.head, room)
  const tailChars = Math.min(budget.tail, Math.max(0, room - headChars))

  const head = headChars > 0 ? chars.slice(0, headChars).join('') : ''
  const tail = tailChars > 0 ? chars.slice(Math.max(headChars, total - tailChars)).join('') : ''
  const marker = head !== '' && tail !== '' ? '\n…[中间部分省略]…\n' : ''
  let body = `${head}${marker}${tail}`
  let notice = noticeFor(Array.from(body).length)
  if (Array.from(body).length + Array.from(notice).length > budget.max) {
    body = Array.from(body)
      .slice(0, Math.max(0, budget.max - Array.from(notice).length))
      .join('')
    // A shorter count only makes the notice shorter, so this is a hard cap.
    notice = noticeFor(Array.from(body).length)
  }
  const shownChars = Array.from(body).length
  return { content: `${body}${notice}`, shownChars }
}