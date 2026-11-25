// Background jobs: registry semantics (ownership, output, notices) plus the
// `bash run_in_background` and HTTP surfaces the web runtime panel speaks.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { mock } from 'node:test'

import { JobManager } from '../src/jobs/manager.ts'
import { presetState } from '../src/core/permission.ts'
import { BashTool, commandEnv, DEFAULT_TIMEOUT_MS } from '../src/tools/bash.ts'
import { createJobTools } from '../src/tools/jobs.ts'
import { startHost } from '../src/host/server.ts'
import type { OutputStore } from '../src/agent/tool-output.ts'
import type { ToolContext } from '../src/tools/types.ts'

function toolContext(manager: JobManager, sessionId = 's1'): ToolContext {
  return {
    sessionId,
    callId: 'call-1',
    cwd: process.cwd(),
    roots: [process.cwd()],
    confined: true,
    cancel: new AbortController().signal,
    permission: presetState('project-write'),
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
      return true
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

test('a rejected completion stays claimable through job_output', async () => {
  const manager = new JobManager({ onDone: () => false })
  const job = manager.start({
    owner: 's1',
    cwd: process.cwd(),
    command: 'node -e "console.log(\'still-readable\')"',
  })
  await waitSettled(manager, job.id, 's1')
  assert.equal(manager.list('s1')[0]?.reported, false)
  const read = manager.read(job.id, 's1')
  assert.match(read.output, /still-readable/)
  assert.equal(read.job.reported, true)
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
  // Give the child a moment to flush its first line before killing it: under
  // a loaded test runner the kill can otherwise land before stdout arrives.
  const started = Date.now()
  while (!manager.read(job.id, 's1').output.includes('started') && Date.now() - started < 5000) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
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
  const plan = presetState('project-write', 'plan')
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

test('bash runs a quoted foreground command through the selected shell', async () => {
  const output = await BashTool.execute(
    { command: 'node -e "console.log(\'foreground-ok\')"' },
    toolContext(new JobManager()),
  )
  assert.equal(output.isError, false)
  assert.match(output.content, /foreground-ok/)
})

function memoryOutputStore(): OutputStore & { saved: Map<string, string> } {
  const saved = new Map<string, string>()
  let next = 1
  return {
    saved,
    save(_sessionId, _callId, content) {
      const id = `out-${next}`
      next += 1
      saved.set(id, content)
      return id
    },
    read(_sessionId, id) {
      return saved.get(id) ?? null
    },
  }
}

test('commandEnv carries project facts and non-interactive defaults', () => {
  const env = commandEnv('/work/main', ['/work/a', '/work/b'])
  assert.equal(env.DENIA_PROJECT_ROOT, '/work/main')
  assert.equal(env.DENIA_PROJECT_DIRS, process.platform === 'win32' ? '/work/a;/work/b' : '/work/a:/work/b')
  assert.equal(env.GIT_PAGER, 'cat')
  assert.equal(env.PAGER, 'cat')
  assert.equal(env.GIT_TERMINAL_PROMPT, '0')
  assert.equal(env.NO_COLOR, '1')
  assert.equal(env.TERM, 'dumb')
})

test('bash closes stdin so a reader sees EOF instead of waiting', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-bash-stdin-'))
  const script = path.join(cwd, 'stdin.js')
  fs.writeFileSync(
    script,
    [
      "process.stdin.setEncoding('utf8')",
      "process.stdin.on('data', () => {})",
      "process.stdin.on('end', () => { console.log('EOF'); process.exit(0) })",
      "setTimeout(() => { console.log('WAITED'); process.exit(3) }, 3000)",
    ].join('\n'),
  )
  const ctx: ToolContext = { ...toolContext(new JobManager()), cwd, roots: [cwd] }
  const started = Date.now()
  const output = await BashTool.execute({ command: `node ${JSON.stringify(script)}` }, ctx)
  assert.equal(output.isError, false)
  assert.match(output.content, /EOF/)
  assert.doesNotMatch(output.content, /WAITED/)
  assert.ok(Date.now() - started < 3000, 'stdin was closed instead of hanging')
})

test('background jobs receive the same project environment', async () => {
  const manager = new JobManager()
  const ctx = toolContext(manager)
  const output = await BashTool.execute(
    { command: 'node -e "console.log(process.env.DENIA_PROJECT_ROOT)"', run_in_background: true },
    ctx,
  )
  const snapshot = JSON.parse(output.content) as { id: string }
  await waitSettled(manager, snapshot.id, 's1')
  assert.ok(manager.read(snapshot.id, 's1').output.includes(ctx.cwd))
})

test('adopt takes over a live child and keeps capturing its output', async () => {
  const manager = new JobManager()
  const child = spawn(
    process.execPath,
    ['-e', "setTimeout(() => { console.log('late'); process.exit(0) }, 150)"],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const job = manager.adopt({
    owner: 's1',
    cwd: process.cwd(),
    command: 'node late.js',
    child,
    output: 'early\n',
  })
  assert.equal(job.status, 'running')
  await waitSettled(manager, job.id, 's1')
  const read = manager.read(job.id, 's1')
  assert.equal(read.job.status, 'completed')
  // The foreground result already contained 'early'; the job read is the part
  // that arrived after the handoff.
  assert.doesNotMatch(read.output, /early/)
  assert.match(read.output, /late/)
  assert.match(manager.peek(job.id, 's1').output, /early/)
})

test('readOrWait wakes on new output instead of polling', async () => {
  const manager = new JobManager()
  const job = manager.start({
    owner: 's1',
    cwd: process.cwd(),
    command: 'node -e "setTimeout(() => console.log(\'delayed\'), 150)"',
  })
  const started = Date.now()
  const result = await manager.readOrWait(job.id, 's1', 4000)
  const elapsed = Date.now() - started
  assert.match(result.output, /delayed/)
  assert.ok(elapsed < 3500, `readOrWait returned in ${elapsed}ms`)
  await waitSettled(manager, job.id, 's1')
})

test('job_output waits for new output and keeps large JSON valid', async () => {
  const manager = new JobManager()
  const store = memoryOutputStore()
  const tools = createJobTools(manager)
  const jobOutput = tools.find((tool) => tool.schema.name === 'job_output')!
  const ctx: ToolContext = { ...toolContext(manager), outputStore: store }

  const delayed = manager.start({
    owner: 's1',
    cwd: process.cwd(),
    command: 'node -e "setTimeout(() => console.log(\'delayed-output\'), 120)"',
  })
  const waited = await jobOutput.execute({ id: delayed.id, wait_ms: 4000 }, ctx)
  const waitedPayload = JSON.parse(waited.content) as { output: string }
  assert.match(waitedPayload.output, /delayed-output/)
  await waitSettled(manager, delayed.id, 's1')

  const chatty = manager.start({
    owner: 's1',
    cwd: process.cwd(),
    command: 'node -e "for (let i = 0; i < 1500; i += 1) console.log(\'line-\' + i)"',
  })
  await waitSettled(manager, chatty.id, 's1')
  const large = await jobOutput.execute({ id: chatty.id }, ctx)
  assert.equal(large.isError, false)
  const payload = JSON.parse(large.content) as {
    output: string
    output_truncated?: boolean
    outputArtifact?: { output_id: string; chars: number }
  }
  assert.equal(payload.output_truncated, true)
  assert.ok(payload.outputArtifact)
  assert.ok(payload.output.length < 14_000)
  assert.ok(store.read('s1', payload.outputArtifact.output_id)?.includes('line-0'))
  assert.ok(store.read('s1', payload.outputArtifact.output_id)?.includes('line-1499'))
})

test('a job timeout of 0 disables the timer', async () => {
  const manager = new JobManager()
  const short = manager.start({
    owner: 's1',
    cwd: process.cwd(),
    command: 'node -e "setTimeout(() => console.log(\'done\'), 400)"',
    timeoutMs: 50,
  })
  await waitSettled(manager, short.id, 's1')
  assert.equal(manager.peek(short.id, 's1').job.status, 'failed')

  const unbounded = manager.start({
    owner: 's1',
    cwd: process.cwd(),
    command: 'node -e "setTimeout(() => console.log(\'done\'), 400)"',
    timeoutMs: 0,
  })
  await waitSettled(manager, unbounded.id, 's1')
  assert.equal(manager.peek(unbounded.id, 's1').job.status, 'completed')
})

test('the default timeout hands a live foreground command to a job', async () => {
  const manager = new JobManager()
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-bash-adopt-timeout-'))
  const script = path.join(cwd, 'slow.js')
  fs.writeFileSync(
    script,
    "console.log('early'); setTimeout(() => { console.log('late'); process.exit(0) }, 300)",
  )
  const ctx: ToolContext = { ...toolContext(manager), cwd, roots: [cwd] }
  let output: Awaited<ReturnType<typeof BashTool.execute>>
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const pending = BashTool.execute({ command: `node ${JSON.stringify(script)}` }, ctx)
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    mock.timers.tick(DEFAULT_TIMEOUT_MS + 1)
    output = await pending
  } finally {
    mock.timers.reset()
  }
  assert.equal(output.isError, false, output.content)
  const meta = output.meta as { end_reason?: string; job_id?: string }
  assert.equal(meta.end_reason, 'backgrounded')
  assert.match(meta.job_id ?? '', /^bash-/)
  await waitSettled(manager, meta.job_id!, 's1', 15_000)
  const read = manager.read(meta.job_id!, 's1')
  assert.equal(read.job.status, 'completed')
  assert.match(read.output, /late/)
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
