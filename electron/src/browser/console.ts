// Console 采集:Playwright 的 console/pageerror 事件,逐 tab 环形缓冲。

export interface ConsoleEntry {
  id: number
  type: string
  text: string
  location?: string
  time: number
}

const MAX_ENTRIES = 200

export class ConsoleLog {
  readonly #entries: ConsoleEntry[] = []
  #nextId = 1

  push(input: { type: string; text: string; location?: string }): number {
    const id = this.#nextId++
    this.#entries.push({ id, ...input, time: Date.now() })
    while (this.#entries.length > MAX_ENTRIES) this.#entries.shift()
    return id
  }

  list(max = 50, type?: string): ConsoleEntry[] {
    const filtered = type ? this.#entries.filter((entry) => entry.type === type) : this.#entries
    return filtered.slice(-max)
  }

  get(id: number): ConsoleEntry | undefined {
    return this.#entries.find((entry) => entry.id === id)
  }

  clear(): number {
    const count = this.#entries.length
    this.#entries.length = 0
    return count
  }
}