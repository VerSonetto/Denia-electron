// Command-policy rule engine.
//
// Rules are prefix matches over the normalized command tokens, each carrying a
// decision. Multiple matches combine "strictest wins" (allow < prompt <
// prompt-user < forbidden).
//
// Rules live in `<home>/execpolicy.json`; `accept-with-rule` approvals append
// an allow rule and persist it, so the same command stops prompting in later
// sessions.

import fs from 'node:fs'
import path from 'node:path'

import type { Decision } from './permission.ts'
import { ALLOW, forbid, promptDecision } from './permission.ts'

export type RuleDecision = 'allow' | 'prompt' | 'prompt-user' | 'forbidden'

export interface ExecRule {
  /** Normalized command prefix, e.g. `["git", "status"]`. */
  prefix: string[]
  decision: RuleDecision
  /** Optional rationale surfaced in the approval prompt / rejection text. */
  justification?: string
}

export interface ExecRuleMatch {
  rule: ExecRule
  decision: Decision
}

const RANK: Record<RuleDecision, number> = {
  allow: 0,
  prompt: 1,
  'prompt-user': 2,
  forbidden: 3,
}

function decisionOf(rule: ExecRule): Decision {
  switch (rule.decision) {
    case 'allow':
      return ALLOW
    case 'prompt':
      return promptDecision(rule.justification)
    case 'prompt-user':
      return { kind: 'prompt-user', reason: rule.justification }
    case 'forbidden':
      return forbid(rule.justification ?? '该命令被 execpolicy 规则禁止')
  }
}

function rankOf(decision: Decision): number {
  switch (decision.kind) {
    case 'allow':
      return 0
    case 'prompt':
      return 1
    case 'prompt-user':
      return 2
    case 'forbid':
      return 3
  }
}

/**
 * Split a shell command into tokens for prefix matching.
 *
 * Deliberately simple: quotes are stripped, pipes/semicolons/`&&` end a logical
 * command, and each segment is matched separately. A command we cannot split
 * cleanly simply fails to match a rule, which is the fail-safe direction.
 */
export function commandTokens(command: string): string[][] {
  const segments: string[][] = []
  for (const raw of command.split(/\|\||&&|[|;\n]/)) {
    const tokens: string[] = []
    for (const match of raw.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
      const token = match[1] ?? match[2] ?? match[3] ?? ''
      if (token !== '') tokens.push(token)
    }
    if (tokens.length > 0) segments.push(tokens)
  }
  return segments
}

/** Local program name: last path segment, `.exe` stripped, ASCII lowercased. */
export function normalizeProgram(token: string): string {
  const parts = token.split(/[/\\]/)
  const last = parts[parts.length - 1] ?? token
  const lower = last.replace(/[A-Z]/g, (char) => char.toLowerCase())
  return lower.endsWith('.exe') ? lower.slice(0, -4) : lower
}

function normalizePrefix(prefix: readonly string[]): string[] {
  return prefix.map((token, index) => (index === 0 ? normalizeProgram(token) : token))
}

function prefixMatches(prefix: readonly string[], tokens: readonly string[]): boolean {
  if (tokens.length < prefix.length) return false
  for (let index = 0; index < prefix.length; index += 1) {
    const expected = index === 0 ? normalizeProgram(prefix[0]!) : prefix[index]
    const actual = index === 0 ? normalizeProgram(tokens[0]!) : tokens[index]
    if (expected !== actual) return false
  }
  return true
}

export class ExecPolicy {
  private readonly rules: ExecRule[]
  private readonly file: string | undefined

  constructor(rules: ExecRule[] = [], file?: string) {
    this.rules = rules
    this.file = file
  }

  /** Load `<home>/execpolicy.json`; a missing or malformed file means no rules. */
  static load(file: string): ExecPolicy {
    try {
      const raw = fs.readFileSync(file, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      const rules = isRuleList(parsed) ? parsed.rules : []
      return new ExecPolicy(rules, file)
    } catch {
      return new ExecPolicy([], file)
    }
  }

  get path(): string | undefined {
    return this.file
  }

  get size(): number {
    return this.rules.length
  }

  /** Strictest matching decision, or undefined when no rule matches. */
  evaluate(command: string): Decision | undefined {
    const segments = commandTokens(command)
    if (segments.length === 0) return undefined
    let worst: Decision | undefined
    for (const tokens of segments) {
      for (const rule of this.rules) {
        if (!prefixMatches(rule.prefix, tokens)) continue
        const decision = decisionOf(rule)
        if (worst === undefined || rankOf(decision) > rankOf(worst)) worst = decision
      }
    }
    return worst
  }

  /** Matching rule (the strictest one) — used to explain a prompt. */
  match(command: string): ExecRuleMatch | undefined {
    const segments = commandTokens(command)
    let best: ExecRuleMatch | undefined
    for (const tokens of segments) {
      for (const rule of this.rules) {
        if (!prefixMatches(rule.prefix, tokens)) continue
        const decision = decisionOf(rule)
        if (!best || rankOf(decision) > rankOf(best.decision)) best = { rule, decision }
      }
    }
    return best
  }

  /**
   * Persist an `allow` rule for `prefix` (execpolicy amendment). Returns the
   * effective rule list; a policy without a backing file stays in memory only.
   */
  async appendAllow(prefix: string[], justification?: string): Promise<void> {
    const normalized = normalizePrefix(prefix)
    const existing = this.rules.find(
      (rule) => rule.decision === 'allow' && rule.prefix.join('\u0000') === normalized.join('\u0000'),
    )
    if (!existing) {
      this.rules.push({ prefix: normalized, decision: 'allow', ...(justification ? { justification } : {}) })
    }
    if (!this.file) return
    const payload = { rules: this.rules }
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, this.file)
  }
}

function isRuleList(value: unknown): value is { rules: ExecRule[] } {
  if (typeof value !== 'object' || value === null) return false
  const rules = (value as { rules?: unknown }).rules
  if (!Array.isArray(rules)) return false
  return rules.every((rule) => {
    if (typeof rule !== 'object' || rule === null) return false
    const record = rule as Record<string, unknown>
    return (
      Array.isArray(record.prefix) &&
      record.prefix.every((token) => typeof token === 'string') &&
      typeof record.decision === 'string' &&
      record.decision in RANK
    )
  })
}