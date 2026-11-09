// Read de-duplication state: a repeat read of the same view returns a stub.
//
// The model re-reads the same file view often (after an unrelated edit, or
// because it lost track). Re-sending identical content buys nothing and is
// paid again on every later step, so a second read of an unchanged view only
// gets a one-line answer pointing at the earlier result.
//
// The stamp is the file's (mtime, size): any write invalidates it on its own,
// and the driver additionally drops entries whose result no longer reaches the
// model — a cleared or summarized tool result must not be referenced by a stub
// that says "see above".

/** File identity at read time. */
export interface ReadStamp {
  mtimeMs: number
  size: number
}

interface Entry {
  callId: string
  /** Seq of the tool-result event, so summarization can drop covered entries. */
  seq: number
  stamp: ReadStamp
}

/** De-dup key: one view of one file (path + the requested page). */
export function readViewKey(file: string, offset: number, limit: number): string {
  return `${file}\u0000${offset}\u0000${limit}`
}

export class ReadStateStore {
  private readonly entries = new Map<string, Entry>()

  /** True when this view was already read with exactly this file identity. */
  isUnchanged(key: string, stamp: ReadStamp): boolean {
    const entry = this.entries.get(key)
    return entry !== undefined && entry.stamp.mtimeMs === stamp.mtimeMs && entry.stamp.size === stamp.size
  }

  remember(key: string, entry: Entry): void {
    this.entries.set(key, entry)
  }

  /** A cleared tool result can no longer be referenced. */
  forgetCalls(callIds: Iterable<string>): number {
    const wanted = new Set(callIds)
    if (wanted.size === 0) return 0
    let removed = 0
    for (const [key, entry] of this.entries) {
      if (!wanted.has(entry.callId)) continue
      this.entries.delete(key)
      removed += 1
    }
    return removed
  }

  /** A summary moved the covered range out of the model surface. */
  forgetSeqRange(from: number, to: number): number {
    let removed = 0
    for (const [key, entry] of this.entries) {
      if (entry.seq < from || entry.seq > to) continue
      this.entries.delete(key)
      removed += 1
    }
    return removed
  }

  /** A write changes bytes: every view of that path is stale. */
  forgetPath(file: string): number {
    const prefix = `${file}\u0000`
    let removed = 0
    for (const key of this.entries.keys()) {
      if (!key.startsWith(prefix)) continue
      this.entries.delete(key)
      removed += 1
    }
    return removed
  }

  get size(): number {
    return this.entries.size
  }
}