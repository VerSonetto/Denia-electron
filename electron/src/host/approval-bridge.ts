// The host side of the approval channel: it parks each request until the HTTP
// client answers (or the turn is cancelled), and it is the only place that
// settles those promises.

import type { ApprovalAnswer, ApprovalBridge, ApprovalRequest } from '../agent/gate.ts'

interface PendingEntry {
  sessionId: string
  resolve(answer: ApprovalAnswer): void
}

export class ServerApprovalBridge implements ApprovalBridge {
  private readonly pending = new Map<string, PendingEntry>()

  request(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalAnswer> {
    if (signal.aborted) return Promise.resolve({ choice: 'cancel' })
    return new Promise<ApprovalAnswer>((resolve) => {
      const entry: PendingEntry = { sessionId: request.sessionId, resolve }
      this.pending.set(request.requestId, entry)
      const onAbort = (): void => {
        if (this.pending.delete(request.requestId)) resolve({ choice: 'cancel' })
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** Settle one parked request. Returns false when it is unknown or already settled. */
  answer(requestId: string, answer: ApprovalAnswer): boolean {
    const entry = this.pending.get(requestId)
    if (!entry) return false
    this.pending.delete(requestId)
    entry.resolve(answer)
    return true
  }

  /** Settle every request of one session as cancelled (call when a turn stops). */
  cancelSession(sessionId: string): void {
    for (const [requestId, entry] of this.pending) {
      if (entry.sessionId !== sessionId) continue
      this.pending.delete(requestId)
      entry.resolve({ choice: 'cancel' })
    }
  }

  pendingCount(sessionId?: string): number {
    if (sessionId === undefined) return this.pending.size
    let count = 0
    for (const entry of this.pending.values()) {
      if (entry.sessionId === sessionId) count += 1
    }
    return count
  }
}