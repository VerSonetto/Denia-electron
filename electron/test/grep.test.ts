// Grep fast path: order, prefilter correctness, case folding, batching and
// binary/size guards.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

import { closeGrepPool } from '../src/tools/grep-pool.ts'
import { GrepTool } from '../src/tools/search.ts'
import type { ToolContext } from '../src/tools/types.ts'

after(() => closeGrepPool())

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function write(root: string, relative: string, content: string | Buffer): void {
  const absolute = path.join(root, relative)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, content)
}

function context(cwd: string, roots: string[] = [cwd], cancel?: AbortSignal): ToolContext {
  return {
    sessionId: 'grep-test',
    callId: 'call-1',
    cwd,
    roots,
    confined: true,
    cancel: cancel ?? new AbortController().signal,
    emit: () => {},
  }
}

test('plain literals keep walk order, one hit per line and paging', async () => {
  const root = tempDir('denia-grep-order-')
  write(root, 'a/one.txt', 'needle one\nneedle needle two\nclean\n')
  write(root, 'a/two.txt', 'clean\nneedle two\n')
  write(root, 'b/three.md', 'needle three\n')
  write(root, 'c.txt', 'needle c\n')
  const ctx = context(root)

  const all = await GrepTool.execute({ pattern: 'needle' }, ctx)
  assert.equal(all.isError, false)
  assert.equal(
    all.content,
    [
      'a/one.txt:1:needle one',
      'a/one.txt:2:needle needle two',
      'a/two.txt:2:needle two',
      'b/three.md:1:needle three',
      'c.txt:1:needle c',
    ].join('\n'),
    'duplicate occurrences on one line are still one hit',
  )

  const page = await GrepTool.execute({ pattern: 'needle', max_matches: 2 }, ctx)
  assert.equal(page.content, 'a/one.txt:1:needle one\na/one.txt:2:needle needle two')
  const offset = await GrepTool.execute({ pattern: 'needle', offset: 1, max_matches: 2 }, ctx)
  assert.equal(offset.content, 'a/one.txt:2:needle needle two\na/two.txt:2:needle two')
})

test('a mandatory literal prefilters without changing regex semantics', async () => {
  const root = tempDir('denia-grep-regex-')
  write(root, 'src/a.ts', 'value foo12\nvalue foo3\nvalue bar\n')
  write(root, 'src/b.md', 'foo99\n')
  const ctx = context(root)

  const prefixed = await GrepTool.execute({ pattern: 'foo\\d+' }, ctx)
  assert.equal(
    prefixed.content,
    ['src/a.ts:1:value foo12', 'src/a.ts:2:value foo3', 'src/b.md:1:foo99'].join('\n'),
  )

  const lookahead = await GrepTool.execute({ pattern: 'foo(?=12)' }, ctx)
  assert.equal(lookahead.content, 'src/a.ts:1:value foo12')

  const noLiteral = await GrepTool.execute({ pattern: '\\d+' }, ctx)
  assert.equal(
    noLiteral.content,
    ['src/a.ts:1:value foo12', 'src/a.ts:2:value foo3', 'src/b.md:1:foo99'].join('\n'),
  )

  const alternation = await GrepTool.execute({ pattern: 'foo|bar' }, ctx)
  assert.equal(
    alternation.content,
    [
      'src/a.ts:1:value foo12',
      'src/a.ts:2:value foo3',
      'src/a.ts:3:value bar',
      'src/b.md:1:foo99',
    ].join('\n'),
  )
})

test('case-insensitive search folds ASCII and leaves the regex to verify', async () => {
  const root = tempDir('denia-grep-case-')
  write(root, 'case.txt', 'Needle\nneedle\nNEEDLE\n')
  write(root, 'other.ts', 'FOO12\nfoo3\n')
  const ctx = context(root)

  const folded = await GrepTool.execute({ pattern: 'needle', ignore_case: true }, ctx)
  assert.equal(
    folded.content,
    ['case.txt:1:Needle', 'case.txt:2:needle', 'case.txt:3:NEEDLE'].join('\n'),
  )
  const exact = await GrepTool.execute({ pattern: 'NEEDLE' }, ctx)
  assert.equal(exact.content, 'case.txt:3:NEEDLE')

  const regex = await GrepTool.execute({ pattern: 'foo\\d+', ignore_case: true }, ctx)
  assert.equal(regex.content, ['other.ts:1:FOO12', 'other.ts:2:foo3'].join('\n'))
})

test('include filters files before they are read', async () => {
  const root = tempDir('denia-grep-include-')
  write(root, 'a.ts', 'needle\n')
  write(root, 'b.md', 'needle\n')
  const ctx = context(root)

  const ts = await GrepTool.execute({ pattern: 'needle', include: '*.ts' }, ctx)
  assert.equal(ts.content, 'a.ts:1:needle')
  const md = await GrepTool.execute({ pattern: 'needle', include: '**/*.md' }, ctx)
  assert.equal(md.content, 'b.md:1:needle')
})

test('binary and oversized files stay out of the result', async () => {
  const root = tempDir('denia-grep-binary-')
  write(root, 'bin.dat', Buffer.concat([Buffer.from([0]), Buffer.from('needle\n')]))
  write(root, 'big.txt', `needle\n${'x'.repeat(2 * 1024 * 1024)}`)
  write(root, 'ok.txt', 'needle\n')
  const ctx = context(root)

  const result = await GrepTool.execute({ pattern: 'needle' }, ctx)
  assert.equal(result.content, 'ok.txt:1:needle')
})

test('more than one batch goes through the worker pipeline in order', async () => {
  const root = tempDir('denia-grep-batches-')
  for (let dir = 0; dir < 10; dir += 1) {
    for (let file = 0; file < 15; file += 1) {
      const content = dir === 0 && file === 0
        ? 'needle early\n'
        : dir === 9 && file === 14
          ? 'needle late\n'
          : `padding ${dir}/${file}\n`
      write(root, `d${String(dir).padStart(2, '0')}/z${String(file).padStart(2, '0')}.txt`, content)
    }
  }
  const ctx = context(root)

  const result = await GrepTool.execute({ pattern: 'needle' }, ctx)
  assert.equal(result.content, 'd00/z00.txt:1:needle early\nd09/z14.txt:1:needle late')
})

test('multi-root hits keep the root label prefix', async () => {
  const first = tempDir('denia-grep-root-a-')
  const second = tempDir('denia-grep-root-b-')
  write(first, 'a.txt', 'needle\n')
  write(second, 'a.txt', 'needle\n')
  const ctx = context(first, [first, second])

  const result = await GrepTool.execute({ pattern: 'needle' }, ctx)
  assert.equal(
    result.content,
    [
      `${path.basename(first)}/a.txt:1:needle`,
      `${path.basename(second)}/a.txt:1:needle`,
    ].join('\n'),
  )
})

test('an aborted signal wins over collected hits', async () => {
  const root = tempDir('denia-grep-abort-')
  write(root, 'a.txt', 'needle\n')
  const result = await GrepTool.execute({ pattern: 'needle' }, context(root, [root], AbortSignal.abort()))
  assert.equal(result.isError, true)
  assert.match(result.content, /命令被用户中断/)
})
