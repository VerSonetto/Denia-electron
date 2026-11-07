// Background jobs: registry semantics (ownership, output, notices) plus the
// `bash run_in_background` and HTTP surfaces the web runtime panel speaks.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { JobManager } from '../src/jobs/manager.ts'
import { presetState } from '../src/core/permission.ts'
import { BashTool } from '../src/tools/bash.ts'
import { startHost } from '../src/host/server.ts'
import type { ToolContext } from '../src/tools/types.ts'

function toolContext(manager: JobManager, sessionId = 's1'): ToolContext {
  return {
    sessionId,
    callId: 'call-1',
    cwd: process.cwd(),
    confined: true,
    cancel: new AbortController().signal,
    permission: presetState('workspace-write'),
    jobs: manager,
    emit: () => {},
  }
}

async function waitSettled(
  manager: JobManager,
  id: string,
  owner: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (manager.peek(id, owner).job.finishedAt !== undefined) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`job did not settle: ${id}`)
}

test('a background job settles once and reports its completion', async () => {
  const notices: string[] = []
  let resolveNotice: () => void = () => {}
  const noticed = new Promise<void>((resolve) => {
    resolveNotice = resolve
  })
  const manager = new JobManager({
    onDone: (job) => {
      notices.push(job.id)
      resolveNotice()
    },
  })
  const job = manager.start({
    owner: 's1',
    cwd: process.cwd(),
    command: 'node -e "console.log(\'job-ok\')"',
  })
  assert.equal(job.status, 'running')
  await noticed
  await waitSettled(manager, job.id, 's1')

  const read = manager.read(job.id, 's1')
  assert.match(read.output, /job-ok/)
  assert.equal(read.job.status, 'completed')
  assert.equal(read.job.exitCode, 0)
  assert.equal(read.job.reported, true)
  assert.deepEqual(notices, [job.id])
  // Reading again returns the retained output without a second notice.
  assert.equal(manager.read(job.id, 's1').job.reported, true)
  assert.equal(notices.length, 1)
})

test('jobs are scoped to their owning session', async () => {
  const manager = new JobManager()
  const job = manager.start({
    owner: 's1',
    cwd: process.cwd(),
    command: 'node -e "console.log(\'scoped\')"',
  })
  assert.throws(() => manager.read(job.id, 's2'), /任务不存在/)
  assert.throws(() => manager.kill(job.id, 's2'), /任务不存在/)
  assert.equal(manager.list('s2').length, 0)
  await waitSettled(manager, job.id, 's1')
})

test('kill stops a long-running job and keeps its partial output', async () => {
  const manager = new JobManager()
  const job = manager.start({
    owner: 's1',
    cwd: process.cwd(),
    command: 'node -e "console.log(\'started\'); setTimeout(()=>{}, 60000)"',
  })
  manager.kill(job.id, 's1')
  assert.equal(manager.peek(job.id, 's1').job.status, 'stopping')
  await waitSettled(manager, job.id, 's1')
  const read = manager.read(job.id, 's1')
  assert.equal(read.job.status, 'killed')
  assert.match(read.output, /started/)
  assert.match(read.output, /已停止/)
})

test('plan and read-only modes refuse background commands with write effects', () => {
  const manager = new JobManager()
  const plan = presetState('workspace-write', 'plan')
  const readOnly = presetState('read-only')
  assert.throws(
    () =>
      manager.start({
        owner: 's1',
        cwd: process.cwd(),
        command: 'echo hi > out.txt',
        permission: plan,
      }),
    /计划模式/,
  )
  assert.throws(
    () =>
      manager.start({
        owner: 's1',
        cwd: process.cwd(),
        command: 'echo hi > out.txt',
        permission: readOnly,
      }),
    /只读/,
  )
  // A provably read-only command is still allowed in read-only mode.
  const allowed = manager.start({
    owner: 's1',
    cwd: process.cwd(),
    command: 'node -e "console.log(\'read-only-ok\')"',
    permission: readOnly,
  })
  assert.equal(allowed.status, 'running')
  manager.kill(allowed.id, 's1')
})

test('bash run_in_background hands the command to the job manager', async () => {
  const manager = new JobManager()
  const output = await BashTool.execute(
    { command: 'node -e "console.log(\'bg-ok\')"', run_in_background: true },
    toolContext(manager),
  )
  assert.equal(output.isError, false)
  const snapshot = JSON.parse(output.content) as { id: string; status: string }
  assert.match(snapshot.id, /^bash-/)
  assert.equal(snapshot.status, 'running')
  await waitSettled(manager, snapshot.id, 's1')
  assert.match(manager.read(snapshot.id, 's1').output, /bg-ok/)
})

test('the jobs HTTP surface lists, reads and kills by session', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-jobs-home-'))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-jobs-cwd-'))
  const webDir = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-jobs-web-'))
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({ providers: [], default: undefined }),
  )
  const host = await startHost({ home, webDir, port: 0 })
  try {
    const created = await fetch(`${host.baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd }),
    })
    assert.equal(created.status, 201)
    const { session } = (await created.json()) as { session: { id: string } }

    const listed = (await (
      await fetch(`${host.baseUrl}/api/sessions/${session.id}/jobs`)
    ).json()) as { jobs: unknown[] }
    assert.deepEqual(listed.jobs, [])

    const missing = await fetch(`${host.baseUrl}/api/sessions/${session.id}/jobs/nope/output`)
    assert.equal(missing.status, 400)
    const missingKill = await fetch(`${host.baseUrl}/api/sessions/${session.id}/jobs/nope/kill`, {
      method: 'POST',
    })
    assert.equal(missingKill.status, 400)
  } finally {
    await host.close()
  }
})