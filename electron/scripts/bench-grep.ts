// Grep benchmark: generates a large synthetic source tree once, then measures
// the real GrepTool on the paths that matter (no hit, rare hit, many hits,
// include filter, case-insensitive).
//
// Usage: node electron/scripts/bench-grep.ts [fileCount] [root]

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

import { GrepTool } from '../src/tools/search.ts'
import type { ToolContext } from '../src/tools/types.ts'

const fileCount = Math.max(1_000, Number(process.argv[2] ?? 20_000))
const root = path.resolve(process.argv[3] ?? path.join(os.tmpdir(), `denia-grep-bench-${fileCount}`))
const ready = path.join(root, '.bench-ready')
const SKIP = new Set(['.git', '.hg', '.svn', 'node_modules', '.denia'])

/**
 * The old algorithm, reproduced for a same-moment comparison: statSync per
 * entry, serial reads, whole-file decode and split, stop at max hits.
 */
async function legacyGrep(pattern: string, maxHits = 200): Promise<number> {
  const regex = new RegExp(pattern)
  let hits = 0
  const visit = async (absolute: string): Promise<void> => {
    if (hits >= maxHits) return
    let stat: fs.Stats
    try {
      stat = fs.statSync(absolute)
    } catch {
      return
    }
    if (stat.isDirectory()) {
      if (SKIP.has(path.basename(absolute))) return
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(absolute, { withFileTypes: true })
      } catch {
        return
      }
      entries.sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        await visit(path.join(absolute, entry.name))
        if (hits >= maxHits) return
      }
      return
    }
    if (stat.size > 2 * 1024 * 1024) return
    let text: string
    try {
      text = await fs.promises.readFile(absolute, 'utf8')
    } catch {
      return
    }
    if (text.includes('\u0000')) return
    for (const line of text.split('\n')) {
      if (!regex.test(line)) continue
      hits += 1
      if (hits >= maxHits) return
    }
  }
  await visit(root)
  return hits
}

function generate(): void {
  if (fs.existsSync(ready)) return
  fs.rmSync(root, { recursive: true, force: true })
  const dirs = 100
  const subdirs = 10
  const perDir = Math.max(1, Math.ceil(fileCount / (dirs * subdirs)))
  const base = [
    "import { helper } from './helper'",
    '',
    'export interface Record {',
    '  id: string',
    '  value: number',
    '}',
    '',
    '// generated fixture for search benchmarks',
    'export function handle(input: string): number {',
    '  const trimmed = input.trim()',
    '  let total = 0',
    '  for (const char of trimmed) {',
    '    total += char.charCodeAt(0)',
    '  }',
    '  return total',
    '}',
    '',
  ].join('\n')
  const filler = Array.from({ length: 60 }, (_, index) =>
    `const value_${index} = helper(${index}, 'padding token ${index} with some length')`,
  ).join('\n')
  let written = 0
  for (let dir = 0; dir < dirs && written < fileCount; dir += 1) {
    for (let sub = 0; sub < subdirs && written < fileCount; sub += 1) {
      const parent = path.join(root, `pkg${dir}`, `mod${sub}`)
      fs.mkdirSync(parent, { recursive: true })
      for (let file = 0; file < perDir && written < fileCount; file += 1) {
        const index = written
        const ext = index % 5 === 0 ? 'json' : index % 7 === 0 ? 'md' : 'ts'
        const rare = index % 997 === 0
        const mixed = index % 1499 === 0
        const body = ext === 'json'
          ? JSON.stringify({ index, value: index * 7, nested: { note: 'fixture' } }, null, 2)
          : ext === 'md'
            ? `# fixture ${index}\n\n${filler}\n`
            : `${base}\n// file ${index}\nexport const marker_${index} = ${index}\n${filler}\n`
        const content = [
          body,
          rare ? '// unique_needle_5f3a appears here\n' : '',
          mixed ? '// Unique_Needle_5f3a mixed case\n' : '',
        ].join('')
        fs.writeFileSync(path.join(parent, `file_${file}.${ext}`), content)
        written += 1
      }
    }
  }
  fs.writeFileSync(ready, String(Date.now()))
  console.log(`generated ${written} files under ${root}`)
}

async function main(): Promise<void> {
  generate()
  const controller = new AbortController()
  const ctx: ToolContext = {
    sessionId: 'bench',
    callId: 'bench',
    cwd: root,
    roots: [root],
    confined: true,
    cancel: controller.signal,
    emit: () => {},
  }
  const scenarios = [
    { name: 'no-hit', args: { pattern: 'zzzz_no_such_token_9k2' } },
    { name: 'rare-hit', args: { pattern: 'unique_needle_5f3a' } },
    { name: 'rare-hit(include *.ts)', args: { pattern: 'unique_needle_5f3a', include: '*.ts' } },
    { name: 'many-hit(return)', args: { pattern: 'return' } },
    { name: 'case-insensitive', args: { pattern: 'UNIQUE_NEEDLE_5F3A', ignore_case: true } },
    { name: 'no-hit(include *.ts)', args: { pattern: 'zzzz_no_such_token_9k2', include: '*.ts' } },
  ] as const

  console.log(`root=${root}`)
  const medians = new Map<string, number>()
  for (const scenario of scenarios) {
    // One discard run so the measurement reflects a warm process, then median.
    await GrepTool.execute(scenario.args, ctx)
    const times: number[] = []
    let output = ''
    for (let run = 0; run < 3; run += 1) {
      const start = performance.now()
      const result = await GrepTool.execute(scenario.args, ctx)
      times.push(performance.now() - start)
      output = result.content
    }
    times.sort((a, b) => a - b)
    const median = times[1]!
    medians.set(scenario.name, median)
    console.log(
      `${scenario.name.padEnd(26)} median ${median.toFixed(0).padStart(6)}ms  ` +
      `runs ${times.map((time) => time.toFixed(0)).join('/')}ms  ` +
      `output ${output.length}b`,
    )
  }

  for (const [name, pattern] of [
    ['no-hit', 'zzzz_no_such_token_9k2'],
    ['rare-hit', 'unique_needle_5f3a'],
  ] as const) {
    await legacyGrep(pattern)
    const times: number[] = []
    for (let run = 0; run < 3; run += 1) {
      const start = performance.now()
      await legacyGrep(pattern)
      times.push(performance.now() - start)
    }
    times.sort((a, b) => a - b)
    const median = times[1]!
    const current = medians.get(name)
    const ratio = current === undefined ? '' : `  speedup ${(median / current).toFixed(1)}x`
    console.log(
      `${`legacy ${name}`.padEnd(26)} median ${median.toFixed(0).padStart(6)}ms  ` +
      `runs ${times.map((time) => time.toFixed(0)).join('/')}ms${ratio}`,
    )
  }
}

await main()
