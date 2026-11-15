// Git review backend for the side pane.
//
// The panel intentionally shells out to the user's `git` binary instead of
// embedding a Git library: the result matches what the user sees in a
// terminal, honors their configuration and needs no native build step.
// Status is one process per directory; diffs are lazy per file.

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const GIT_TIMEOUT_MS = 30_000
const DIFF_CHAR_LIMIT = 180_000
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024

export interface GitEntry {
  path: string
  indexStatus: string
  worktreeStatus: string
  staged: boolean
  unstaged: boolean
  untracked: boolean
  conflicted: boolean
  renamedFrom: string | null
}

export interface GitStatus {
  isRepository: boolean
  repoRoot?: string
  branch?: string | null
  head?: string | null
  detached?: boolean
  ahead?: number | null
  behind?: number | null
  entries: GitEntry[]
}

export type GitSource = 'unstaged' | 'staged' | 'branch'

export interface GitDiff {
  path: string
  availability: 'patch' | 'binary' | 'truncated' | 'unavailable'
  patch: string | null
  beforeContent: string | null
  afterContent: string | null
  summary: string | null
}

export class GitError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'GitError'
    this.code = code
    this.status = status
  }
}

interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
}

/** Run git in `cwd`; stdin is closed unless `input` is provided. */
function runGit(cwd: string, args: string[], input?: string): Promise<GitResult> {
  const { promise, resolve, reject } = Promise.withResolvers<GitResult>()
  const child = spawn('git', ['-c', 'core.quotepath=false', ...args], {
    cwd,
    windowsHide: true,
    env: {
      ...process.env,
      LC_ALL: 'C',
      GIT_PAGER: 'cat',
      GIT_TERMINAL_PROMPT: '0',
    },
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let bytes = 0
  let settled = false
  const finish = (result: GitResult | Error): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    if (result instanceof Error) reject(result)
    else resolve(result)
  }
  const timer = setTimeout(() => {
    child.kill('SIGKILL')
    finish(new GitError('git/timeout', 'git 命令超时', 504))
  }, GIT_TIMEOUT_MS)
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length
    if (bytes > MAX_OUTPUT_BYTES) {
      child.kill('SIGKILL')
      finish(new GitError('git/output-too-large', 'git 输出超过上限', 413))
      return
    }
    stdout.push(chunk)
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr.push(chunk)
  })
  child.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      finish(new GitError('git/not-installed', '未找到 git 可执行文件,请先安装 Git 并确保在 PATH 中', 500))
      return
    }
    finish(new GitError('git/spawn-failed', `执行 git 失败:${error.message}`, 500))
  })
  child.on('close', (code) => {
    finish({
      ok: code === 0,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    })
  })
  child.stdin.end(input ?? '')
  return promise
}

function assertDirectory(dir: string): string {
  if (!dir || dir.trim() === '') throw new GitError('git/bad-path', '缺少目录路径')
  const resolved = path.resolve(dir.trim())
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new GitError('git/bad-path', `目录不存在:${resolved}`)
  }
  return resolved
}

/** Parse `git status --porcelain=v1 -z`; rename records consume two NUL fields. */
function parseStatus(raw: string): GitEntry[] {
  const entries: GitEntry[] = []
  const fields = raw.split('\u0000')
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!
    if (field.length < 4) continue
    const indexStatus = field[0]!
    const worktreeStatus = field[1]!
    const file = field.slice(3)
    const renamedFrom =
      indexStatus === 'R' || indexStatus === 'C' ? (fields[++index] ?? null) : null
    const staged = indexStatus !== ' ' && indexStatus !== '?'
    const unstaged = worktreeStatus !== ' ' && worktreeStatus !== '?'
    const untracked = indexStatus === '?' && worktreeStatus === '?'
    const conflicted =
      indexStatus === 'U' ||
      worktreeStatus === 'U' ||
      (indexStatus === 'A' && worktreeStatus === 'A') ||
      (indexStatus === 'D' && worktreeStatus === 'D')
    entries.push({
      path: file,
      indexStatus,
      worktreeStatus,
      staged,
      unstaged,
      untracked,
      conflicted,
      renamedFrom,
    })
  }
  return entries
}

async function repoRootOf(dir: string): Promise<string | null> {
  const result = await runGit(dir, ['rev-parse', '--show-toplevel'])
  if (result.ok) return result.stdout.trim() || dir
  const stderr = result.stderr.toLowerCase()
  if (
    stderr.includes('not a git repository') ||
    stderr.includes('not a repository') ||
    stderr.includes('fatal:')
  ) {
    return null
  }
  throw new GitError('git/rev-parse-failed', `git rev-parse 失败:${result.stderr.trim()}`, 500)
}

export async function gitStatus(dir: string): Promise<GitStatus> {
  const cwd = assertDirectory(dir)
  const repoRoot = await repoRootOf(cwd)
  if (repoRoot === null) return { isRepository: false, entries: [] }

  const branchResult = await runGit(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'])
  const branch = branchResult.stdout.trim()
  const headResult = await runGit(cwd, ['rev-parse', '--short', 'HEAD'])
  const head = headResult.stdout.trim()
  const detached = branch === '' && head !== '' && headResult.ok

  let ahead: number | null = null
  let behind: number | null = null
  const counts = await runGit(cwd, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])
  if (counts.ok) {
    const parts = counts.stdout.trim().split(/\s+/)
    if (parts.length === 2) {
      ahead = Number(parts[0])
      behind = Number(parts[1])
    }
  }

  const statusResult = await runGit(cwd, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ])
  if (!statusResult.ok) {
    throw new GitError('git/status-failed', `git status 失败:${statusResult.stderr.trim()}`, 500)
  }

  return {
    isRepository: true,
    repoRoot,
    branch: branch === '' ? null : branch,
    head: head === '' ? null : head,
    detached,
    ahead,
    behind,
    entries: parseStatus(statusResult.stdout),
  }
}

async function isUntracked(cwd: string, repoRelative: string): Promise<boolean> {
  const result = await runGit(cwd, ['ls-files', '--others', '--exclude-standard', '--', repoRelative])
  return result.ok && result.stdout.trim() !== ''
}

export async function gitDiff(dir: string, file: string, source: GitSource): Promise<GitDiff> {
  const cwd = assertDirectory(dir)
  const repoRoot = await repoRootOf(cwd)
  if (repoRoot === null) {
    throw new GitError('git/not-a-repository', '当前目录不是 Git 仓库', 400)
  }
  const repoRelative = `:/${file.trim().replace(/^\/+/, '')}`
  const untracked = await isUntracked(cwd, repoRelative)

  const args =
    source === 'staged'
      ? ['diff', '--cached', '--no-color', '--', repoRelative]
      : source === 'branch'
        ? ['diff', '--no-color', '@{upstream}', '--', repoRelative]
        : ['diff', '--no-color', '--', repoRelative]
  const result = await runGit(cwd, args)
  if (!result.ok) {
    return {
      path: file,
      availability: 'unavailable',
      patch: null,
      beforeContent: null,
      afterContent: null,
      summary: result.stderr.trim(),
    }
  }
  const patch = result.stdout
  if (patch.includes('Binary files') || patch.includes('GIT binary patch')) {
    return {
      path: file,
      availability: 'binary',
      patch: null,
      beforeContent: null,
      afterContent: null,
      summary: null,
    }
  }

  const absolute = path.join(repoRoot, file.replace(/^\/+/, ''))
  if (patch.trim() === '' && (untracked || source === 'unstaged')) {
    try {
      const content = fs.readFileSync(absolute, 'utf8')
      if (content.includes('\u0000')) {
        return { path: file, availability: 'binary', patch: null, beforeContent: null, afterContent: null, summary: null }
      }
      if (Array.from(content).length > DIFF_CHAR_LIMIT) {
        return { path: file, availability: 'truncated', patch: null, beforeContent: null, afterContent: null, summary: null }
      }
      if (content !== '') {
        return { path: file, availability: 'patch', patch: null, beforeContent: null, afterContent: content, summary: null }
      }
    } catch {
      return { path: file, availability: 'binary', patch: null, beforeContent: null, afterContent: null, summary: null }
    }
  }

  if (Array.from(patch).length > DIFF_CHAR_LIMIT) {
    return { path: file, availability: 'truncated', patch: null, beforeContent: null, afterContent: null, summary: null }
  }

  const before = await runGit(cwd, ['show', `HEAD:${file.replace(/^\/+/, '')}`])
  const after =
    source === 'staged'
      ? await runGit(cwd, ['show', `:${file.replace(/^\/+/, '')}`])
      : (() => {
          try {
            return { ok: true, stdout: fs.readFileSync(absolute, 'utf8'), stderr: '' }
          } catch {
            return { ok: false, stdout: '', stderr: '' }
          }
        })()
  return {
    path: file,
    availability: 'patch',
    patch,
    beforeContent: before.ok ? before.stdout : null,
    afterContent: after.ok ? after.stdout : null,
    summary: null,
  }
}

export async function gitCommit(
  dir: string,
  message: string,
): Promise<{ ok: boolean; head: string; summary: string }> {
  const cwd = assertDirectory(dir)
  const trimmed = message.trim()
  if (trimmed === '') throw new GitError('git/empty-message', '提交信息不能为空')
  const status = await gitStatus(cwd)
  if (!status.isRepository) throw new GitError('git/not-a-repository', '当前目录不是 Git 仓库')
  if (status.entries.length === 0) {
    throw new GitError('git/nothing-to-commit', '没有可提交的改动')
  }
  const add = await runGit(cwd, ['add', '-A'])
  if (!add.ok) throw new GitError('git/add-failed', `git add 失败:${add.stderr.trim()}`, 500)
  const commit = await runGit(cwd, ['commit', '-F', '-', '--cleanup=whitespace'], trimmed)
  if (!commit.ok) {
    const detail = commit.stderr.trim()
    if (
      detail.includes('Please tell me who you are') ||
      detail.includes('unable to auto-detect email')
    ) {
      throw new GitError(
        'git/identity-missing',
        `提交需要先配置 Git 身份:git config user.name "你的名字" 与 git config user.email "you@example.com"\n${detail}`,
      )
    }
    throw new GitError('git/commit-failed', `git commit 失败:${detail}`, 500)
  }
  const head = await runGit(cwd, ['rev-parse', '--short', 'HEAD'])
  return {
    ok: true,
    head: head.stdout.trim(),
    summary: commit.stdout.trim(),
  }
}

export async function gitPush(
  dir: string,
): Promise<{ ok: boolean; upstream: string; summary: string }> {
  const cwd = assertDirectory(dir)
  const remotes = await runGit(cwd, ['remote'])
  if (!remotes.ok || remotes.stdout.trim() === '') {
    throw new GitError('git/no-remote', '这个仓库没有配置远程仓库,无法推送')
  }
  const upstreamResult = await runGit(cwd, [
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{upstream}',
  ])
  const upstream = upstreamResult.stdout.trim()
  if (!upstreamResult.ok) {
    const branch = (await runGit(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'])).stdout.trim()
    if (branch === '') {
      throw new GitError('git/detached-head', '当前处于游离 HEAD,无法推送;请先切换到分支')
    }
    throw new GitError(
      'git/no-upstream',
      `当前分支 '${branch}' 没有上游分支,无法推送。可在终端执行:git push -u origin ${branch}`,
    )
  }
  const pushed = await runGit(cwd, ['push'])
  if (!pushed.ok) {
    const detail = pushed.stderr.trim()
    const lower = detail.toLowerCase()
    if (lower.includes('non-fast-forward') || lower.includes('fetch first') || lower.includes('updates were rejected')) {
      throw new GitError('git/non-fast-forward', `远程有新提交,推送被拒绝。请先拉取合并(终端执行 git pull --rebase),再重试\n${detail}`)
    }
    if (
      lower.includes('authentication failed') ||
      lower.includes('could not read username') ||
      lower.includes('permission denied') ||
      lower.includes('invalid username or password') ||
      lower.includes('terminal prompts disabled')
    ) {
      throw new GitError('git/auth-failed', `凭据无效或缺失,无法推送到远程。请检查 SSH key 或 personal access token\n${detail}`)
    }
    if (lower.includes('could not resolve host') || lower.includes('unable to access') || lower.includes('connection')) {
      throw new GitError('git/network-failed', `无法连接远程仓库,请检查网络或代理设置\n${detail}`)
    }
    throw new GitError('git/push-failed', `推送失败\n${detail}`, 500)
  }
  return {
    ok: true,
    upstream,
    summary: pushed.stderr.trim() || pushed.stdout.trim(),
  }
}

/** Diff/log text used to generate a commit message. */
export async function gitCommitContext(dir: string): Promise<{ diff: string; log: string }> {
  const cwd = assertDirectory(dir)
  const repoRoot = (await repoRootOf(cwd)) ?? cwd
  const diff = await runGit(cwd, ['diff', '--no-color', 'HEAD'])
  const untracked = await runGit(cwd, ['ls-files', '--others', '--exclude-standard'])
  const log = await runGit(cwd, ['log', '--oneline', '-5'])
  const parts = [diff.stdout]
  for (const file of untracked.stdout.split('\n').filter(Boolean).slice(0, 40)) {
    try {
      parts.push(`--- ${file}\n${fs.readFileSync(path.join(repoRoot, file), 'utf8')}`)
    } catch {
      /* binary or unreadable */
    }
  }
  return {
    diff: parts.join('\n').slice(0, 24_000),
    log: log.stdout.trim(),
  }
}
