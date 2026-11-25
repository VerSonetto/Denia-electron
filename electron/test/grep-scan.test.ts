// Differential oracle: the prefilter/scan path must produce exactly the same
// lines as a plain decode + per-line regex scan, for every pattern shape.

import assert from 'node:assert/strict'
import test from 'node:test'

import { planGrep } from '../src/tools/grep-pattern.ts'
import { scanGrepBuffer } from '../src/tools/grep-scan.ts'

const TEXT = [
  '',
  'foo',
  'FOO',
  'Needle',
  'needle',
  'NEEDLE',
  'foobar',
  'barfoo',
  'foo bar',
  'value foo12',
  'value foo3',
  'value bar',
  '123',
  'a.b',
  'axb',
  'ſ',
  'İstanbul',
  'kotlin',
  'foo\tbar',
  'prefix foo suffix',
].join('\n')

const PATTERNS = [
  'foo',
  'FOO',
  'needle',
  'foo\\.bar',
  '(foo|bar)',
  '(foo|foobar)',
  'foo(bar)?',
  'foo(?:bar)?baz',
  'foo\\s+bar',
  'foo.*bar',
  'foo[0-9]+bar',
  '\\d+',
  '^foo$',
  '^foo',
  'foo$',
  '(?=foo)bar',
  '(?<!foo)bar',
  'fooba?',
  '(?:foo)+bar',
  'foo|foobar',
  'a.b',
  '\\bfoo\\b',
  '[a-z]{3}',
  'ſ',
  'İstanbul',
  'foo(?=bar)',
  'foo\\d+',
  'needle|NEEDLE',
  '',
  'x*',
]

function reference(pattern: string, ignoreCase: boolean): string[] {
  const regex = new RegExp(pattern, ignoreCase ? 'i' : '')
  const hits: string[] = []
  const lines = TEXT.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    if (regex.test(line)) hits.push(`${index + 1}:${line.slice(0, 400)}`)
  }
  return hits
}

for (const pattern of PATTERNS) {
  for (const ignoreCase of [false, true]) {
    test(`differential ${JSON.stringify(pattern)} ignore_case=${ignoreCase}`, () => {
      const regex = new RegExp(pattern, ignoreCase ? 'i' : '')
      const plan = planGrep(pattern, ignoreCase)
      const result = scanGrepBuffer(Buffer.from(TEXT), plan, regex, 1_000)
      assert.deepEqual(
        result.hits.map((hit) => `${hit.line}:${hit.text}`),
        reference(pattern, ignoreCase),
      )
    })
  }
}
