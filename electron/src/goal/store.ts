// Goal persistence: `<home>/sessions/<id>/goal.json`.
//
// The goal is mutable state, so it lives beside the append-only session log
// instead of inside it. The log only receives `goal` change events, which the
// UI uses to refresh its authoritative view.

import fs from 'node:fs'
import path from 'node:path'

import type { SessionGoal } from './types.ts'

export class GoalStore {
  private readonly sessionsDir: string

  constructor(home: string) {
    this.sessionsDir = path.join(home, 'sessions')
  }

  private file(sessionId: string): string {
    return path.join(this.sessionsDir, sessionId, 'goal.json')
  }

  read(sessionId: string): SessionGoal | null {
    const file = this.file(sessionId)
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
      return normalizeGoal(parsed)
    } catch {
      return null
    }
  }

  write(sessionId: string, goal: SessionGoal): void {
    const file = this.file(sessionId)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temp, JSON.stringify(goal, null, 2) + '\n', 'utf8')
    fs.renameSync(temp, file)
  }

  remove(sessionId: string): void {
    try {
      fs.rmSync(this.file(sessionId), { force: true })
    } catch {
      /* a missing or locked file has no goal state left to clear */
    }
  }
}

/** Tolerate hand-edited or older files: missing counters fall back to zero. */
function normalizeGoal(value: unknown): SessionGoal | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.targetId !== 'string' || record.targetId === '') return null
  if (typeof record.objective !== 'string' || record.objective.trim() === '') return null
  const status = record.status
  if (status !== 'active' && status !== 'paused' && status !== 'budget-limited' && status !== 'complete') {
    return null
  }
  const time = typeof record.time === 'object' && record.time !== null
    ? (record.time as Record<string, unknown>)
    : {}
  const created = typeof time.created === 'number' ? time.created : Date.now()
  const updated = typeof time.updated === 'number' ? time.updated : created
  return {
    targetId: record.targetId,
    objective: record.objective,
    summaryTitle: typeof record.summaryTitle === 'string' ? record.summaryTitle : null,
    status,
    tokenBudget:
      typeof record.tokenBudget === 'number' && Number.isFinite(record.tokenBudget)
        ? Math.max(0, Math.floor(record.tokenBudget))
        : null,
    tokensUsed: typeof record.tokensUsed === 'number' ? Math.max(0, record.tokensUsed) : 0,
    timeUsedSeconds:
      typeof record.timeUsedSeconds === 'number' ? Math.max(0, Math.floor(record.timeUsedSeconds)) : 0,
    activeRunStartedAtMs:
      typeof record.activeRunStartedAtMs === 'number' ? record.activeRunStartedAtMs : null,
    iteration:
      typeof record.iteration === 'number' && record.iteration > 0
        ? Math.floor(record.iteration)
        : 1,
    verifications: Array.isArray(record.verifications)
      ? record.verifications.filter(isVerification)
      : [],
    time: { created, updated },
  }
}

function isVerification(value: unknown): value is SessionGoal['verifications'][number] {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.iteration === 'number' &&
    (record.outcome === 'pass' || record.outcome === 'not-satisfied' || record.outcome === 'failed') &&
    typeof record.at === 'number'
  )
}
