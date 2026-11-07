// Permission policy: the four Codex-style presets, the decision matrix, the
// command rule engine, and the legacy-UI projection.

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  decideAction,
  legacyModeOf,
  modeOf,
  presetState,
  stateFromLegacy,
} from '../src/core/permission.ts'
import { ExecPolicy, commandTokens } from '../src/core/exec-policy.ts'

test('the catalog exposes exactly the four requested presets', () => {
  assert.deepEqual(presetState('read-only'), {
    sandbox: 'read-only',
    approval: 'on-request',
    reviewer: 'user',
    collaboration: 'default',
  })
  assert.deepEqual(presetState('workspace-write'), {
    sandbox: 'workspace-write',
    approval: 'on-request',
    reviewer: 'user',
    collaboration: 'default',
  })
  assert.deepEqual(presetState('approve-for-me'), {
    sandbox: 'workspace-write',
    approval: 'on-request',
    reviewer: 'auto-review',
    collaboration: 'default',
  })
  assert.deepEqual(presetState('full-access'), {
    sandbox: 'danger-full-access',
    approval: 'never',
    reviewer: 'user',
    collaboration: 'default',
  })
  // Round-trip preset identity through the three fields.
  for (const mode of ['read-only', 'workspace-write', 'approve-for-me', 'full-access'] as const) {
    assert.equal(modeOf(presetState(mode)), mode)
  }
})

test('legacy permission levels project onto the new state', () => {
  assert.equal(legacyModeOf(presetState('read-only')), 'read-only')
  assert.equal(legacyModeOf(presetState('workspace-write')), 'auto-edit')
  assert.equal(legacyModeOf(presetState('approve-for-me')), 'auto-edit')
  assert.equal(legacyModeOf(presetState('full-access')), 'full')
  // Switching to auto-edit keeps an active automatic reviewer.
  const next = stateFromLegacy('auto-edit', presetState('approve-for-me'))
  assert.equal(next.reviewer, 'auto-review')
  assert.equal(next.sandbox, 'workspace-write')
  // Leaving full access restores prompts.
  const fromFull = stateFromLegacy('auto-edit', presetState('full-access'))
  assert.equal(fromFull.approval, 'on-request')
  assert.equal(fromFull.reviewer, 'user')
})

test('workspace-write: inside writes allow, outside writes and deletions prompt', () => {
  const state = presetState('workspace-write')
  assert.equal(decideAction({ state, action: 'read', insideWorkspace: true }).kind, 'allow')
  assert.equal(decideAction({ state, action: 'write', insideWorkspace: true }).kind, 'allow')
  assert.equal(decideAction({ state, action: 'write', insideWorkspace: false }).kind, 'prompt')
  assert.equal(decideAction({ state, action: 'delete', insideWorkspace: true }).kind, 'prompt')
  assert.equal(decideAction({ state, action: 'network', insideWorkspace: true }).kind, 'prompt')
})

test('read-only forbids writes and any command it cannot prove read-only', () => {
  const state = presetState('read-only')
  assert.equal(decideAction({ state, action: 'write', insideWorkspace: true }).kind, 'forbid')
  assert.equal(decideAction({ state, action: 'delete', insideWorkspace: true }).kind, 'forbid')
  const writeCommand = {
    command: 'echo hi > out.txt',
    certifiedReadonly: false,
    isDelete: false,
    mayWrite: true,
    mayNetwork: false,
  }
  assert.equal(
    decideAction({ state, action: 'read', insideWorkspace: true, shell: writeCommand }).kind,
    'forbid',
  )
  const readCommand = {
    command: 'git status --short',
    certifiedReadonly: true,
    isDelete: false,
    mayWrite: false,
    mayNetwork: false,
  }
  assert.equal(
    decideAction({ state, action: 'read', insideWorkspace: true, shell: readCommand }).kind,
    'allow',
  )
})

test('full access allows everything and never asks', () => {
  const state = presetState('full-access')
  assert.equal(decideAction({ state, action: 'delete', insideWorkspace: false }).kind, 'allow')
  assert.equal(decideAction({ state, action: 'network', insideWorkspace: false }).kind, 'allow')
  assert.equal(decideAction({ state, action: 'write', insideWorkspace: false }).kind, 'allow')
})

test('plan mode forbids writes and requires a human for exit_plan', () => {
  const state = presetState('workspace-write', 'plan')
  assert.equal(decideAction({ state, action: 'write', insideWorkspace: true }).kind, 'forbid')
  assert.equal(decideAction({ state, action: 'delete', insideWorkspace: true }).kind, 'forbid')
  assert.equal(decideAction({ state, action: 'plan-submit', insideWorkspace: true }).kind, 'prompt-user')
  // Outside plan mode the tool is a plain rejection.
  const outsidePlan = decideAction({
    state: presetState('workspace-write'),
    action: 'plan-submit',
    insideWorkspace: true,
  })
  assert.equal(outsidePlan.kind, 'forbid')
})

test('approval policy can turn a prompt into a hard rejection', () => {
  const state = { ...presetState('workspace-write'), approval: 'never' as const }
  assert.equal(decideAction({ state, action: 'write', insideWorkspace: false }).kind, 'forbid')
})

test('execpolicy matches prefixes and the strictest rule wins', () => {
  const policy = new ExecPolicy([
    { prefix: ['git', 'status'], decision: 'allow' },
    { prefix: ['npm'], decision: 'prompt' },
    { prefix: ['rm', '-rf'], decision: 'prompt-user' },
    { prefix: ['rm', 'cache.txt'], decision: 'forbidden' },
  ])
  assert.equal(policy.evaluate('git status --short')?.kind, 'allow')
  assert.equal(policy.evaluate('npm install')?.kind, 'prompt')
  assert.equal(policy.evaluate('rm -rf build')?.kind, 'prompt-user')
  assert.equal(policy.evaluate('rm cache.txt')?.kind, 'forbid')
  assert.equal(policy.evaluate('ls -la'), undefined)
  assert.equal(policy.evaluate('git push origin main'), undefined)
  // Pipes split the command: each segment is matched on its own.
  assert.deepEqual(commandTokens('git status | cat'), [
    ['git', 'status'],
    ['cat'],
  ])
  assert.equal(policy.evaluate('git status | rm cache.txt')?.kind, 'forbid')
})