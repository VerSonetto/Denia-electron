// Git review backend: status, per-file diff and commit against real repos.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import test from 'node:test'

import { gitCommit, gitDiff, gitStatus } from '../src/host/git.ts'
import { startHost } from '../src/host/server.ts'

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' },
  })
}

function repo(): string {
  const dir = tempDir('denia-git-')
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.name', 'Test'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'initial'])
  return dir
}

test('status, diff and commit work for a real repository', async () => {
  const dir = repo()
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n')
  fs.writeFileSync(path.join(dir, 'new.txt'), 'brand new\n')

  const status = await gitStatus(dir)
  assert.equal(status.isRepository, true)
  assert.ok(status.branch && status.branch.length > 0)
  assert.deepEqual(status.entries.map((entry) => entry.path).sort(), ['a.txt', 'new.txt'])
  assert.equal(status.entries.find((entry) => entry.path === 'new.txt')?.untracked, true)

  const modified = await gitDiff(dir, 'a.txt', 'unstaged')
  assert.equal(modified.availability, 'patch')
  assert.match(modified.patch ?? '', /\+two/)

  const added = await gitDiff(dir, 'new.txt', 'unstaged')
  assert.equal(added.availability, 'patch')
  assert.match(added.afterContent ?? '', /brand new/)

  const committed = await gitCommit(dir, 'feat(review): multi-directory test')
  assert.equal(committed.ok, true)
  assert.equal(committed.head.length > 0, true)
  const clean = await gitStatus(dir)
  assert.equal(clean.entries.length, 0)
})

test('a non-repository directory is reported, not thrown', async () => {
  const dir = tempDir('denia-not-git-')
  const status = await gitStatus(dir)
  assert.deepEqual(status, { isRepository: false, entries: [] })
})

test('the HTTP review surface exposes status and diff per project directory', async () => {
  const home = tempDir('denia-git-home-')
  const webDir = tempDir('denia-git-web-')
  const dir = repo()
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n')
  const host = await startHost({ home, webDir, port: 0 })
  try {
    const status = await fetch(`${host.baseUrl}/api/git/status?path=${encodeURIComponent(dir)}`)
    assert.equal(status.status, 200)
    const body = (await status.json()) as { isRepository: boolean; entries: { path: string }[] }
    assert.equal(body.isRepository, true)
    assert.ok(body.entries.some((entry) => entry.path === 'a.txt'))

    const diff = await fetch(
      `${host.baseUrl}/api/git/diff?path=${encodeURIComponent(dir)}&file=a.txt&source=unstaged`,
    )
    assert.equal(diff.status, 200)
    const diffBody = (await diff.json()) as { patch: string | null }
    assert.match(diffBody.patch ?? '', /\+two/)
  } finally {
    await host.close()
  }
})
