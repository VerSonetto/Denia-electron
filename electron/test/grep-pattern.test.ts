// Conservative regex analysis: a prefilter literal must be mandatory.

import assert from 'node:assert/strict'
import test from 'node:test'

import { planGrep } from '../src/tools/grep-pattern.ts'

test('plain literals keep the pure fast path', () => {
  assert.equal(planGrep('needle', false).pure, 'needle')
  assert.equal(planGrep('needle', false).literal, 'needle')
  assert.equal(planGrep('foo\\.bar', false).pure, 'foo.bar')
  assert.equal(planGrep('(?:foobar)', false).pure, 'foobar')
  assert.equal(planGrep('你好世界', false).pure, '你好世界')
})

test('optional and alternated text is never treated as mandatory', () => {
  assert.equal(planGrep('foo(bar)?', false).literal, 'foo')
  assert.equal(planGrep('foo(?:bar)?baz', false).literal, 'foo')
  assert.equal(planGrep('(foo|bar)', false).literal, null)
  assert.equal(planGrep('foo|foobar', false).literal, null)
  assert.equal(planGrep('foo|bar', false).literal, null)
  assert.equal(planGrep('(foo|bar)baz', false).literal, 'baz')
})

test('quantifiers only keep their literal when they require one repetition', () => {
  assert.equal(planGrep('fooba?', false).literal, 'foob')
  assert.equal(planGrep('(?:foo)+bar', false).literal, 'foo')
  assert.equal(planGrep('a{3}', false).literal, null)
  assert.equal(planGrep('\\d+', false).literal, null)
})

test('opaque atoms stop the current literal run', () => {
  assert.equal(planGrep('foo\\s+bar', false).literal, 'foo')
  assert.equal(planGrep('foo.*bar', false).literal, 'foo')
  assert.equal(planGrep('foo[0-9]+bar', false).literal, 'foo')
  assert.equal(planGrep('foo$', false).pure, null)
  assert.equal(planGrep('foo$', false).literal, 'foo')
  assert.equal(planGrep('', false).literal, null)
})

test('lookarounds never contribute, surrounding literals still do', () => {
  assert.equal(planGrep('(?=foo)bar', false).literal, 'bar')
  assert.equal(planGrep('(?<!foo)bar', false).literal, 'bar')
  assert.equal(planGrep('foo(?=bar)', false).literal, 'foo')
})

test('case-insensitive non-ASCII falls back instead of guessing', () => {
  assert.equal(planGrep('你好', true).literal, null)
  assert.equal(planGrep('你好', true).pure, null)
  assert.equal(planGrep('İstanbul', true).literal, null)
  assert.equal(planGrep('needle', true).pure, 'needle')
})
