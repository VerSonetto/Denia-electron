// 浏览器中枢对外的数据形状:与 web 控制台(`web/src/types.ts`)和工具层共用。

export interface TabInfo {
  tabId: string
  url: string
  title: string
  active: boolean
}

export interface SnapshotElement {
  ref: string
  tag: string
  name?: string
  rect?: { x: number; y: number; width: number; height: number }
  inViewport?: boolean
  editable?: boolean
  href?: string
}

export interface SnapshotPayload {
  url?: string
  title?: string
  elements?: SnapshotElement[]
  truncated?: boolean
}

export interface OutcomeError {
  code: string
  message: string
}

export interface CommandOutcome {
  ok: boolean
  error?: OutcomeError
  value?: unknown
  state?: Record<string, unknown>
  snapshot?: SnapshotPayload
  image?: { base64: string; mimeType: string }
  dialog?: { type?: string; message?: string } | null
  tabs?: TabInfo[]
  elapsedMs: number
}

export type BrowserEvent =
  | { type: 'tabs-changed' }
  | {
      type: 'frame'
      tabId: string
      data: string
      viewport?: { width: number; height: number }
    }
  | { type: 'dialog-opened'; tabId: string; kind: string; message: string }
  | { type: 'dialog-closed'; tabId: string }
  | { type: 'navigated'; tabId: string; url: string; title: string }
  | { type: 'visual-mode-requested' }
  | { type: 'exited' }

export function errorOutcome(code: string, message: string, elapsedMs: number): CommandOutcome {
  return { ok: false, error: { code, message }, elapsedMs }
}

export function valueOutcome(value: unknown, elapsedMs: number): CommandOutcome {
  return { ok: true, value, elapsedMs }
}

/** Unwrap one string field of a command payload. */
export function str(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key]
  return typeof value === 'string' ? value : undefined
}

export function num(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

export function bool(input: Record<string, unknown>, key: string): boolean | undefined {
  const value = input[key]
  return typeof value === 'boolean' ? value : undefined
}

export function strList(input: Record<string, unknown>, key: string): string[] | undefined {
  const value = input[key]
  if (!Array.isArray(value)) return undefined
  return value.filter((entry): entry is string => typeof entry === 'string')
}