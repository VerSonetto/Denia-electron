// The `bash` tool: one shell command per call.
//
// Windows runs commands through the shell configured as the default profile of
// Windows Terminal (`settings.json`), falling back to `ComSpec` when the
// default terminal is not Windows Terminal or no profile can be resolved.
// macOS/Linux use `bash -c`. DENIA_SHELL overrides the executable.
// Output is streamed as `tool-output-chunk` events for the live bash card and
// returned with the same `退出码 / --- stderr ---` layout the UI parses.

import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import type { ToolContext } from './types.ts'
import { expectString, optionalBoolean, optionalNumber, schema, textOutput, toolError } from './types.ts'

export const DEFAULT_TIMEOUT_MS = 120_000
export const MAX_TIMEOUT_MS = 600_000
/** Live output is batched so a fast command does not flood the session log. */
const STREAM_INTERVAL_MS = 60
const MAX_CAPTURE_CHARS = 500_000

export type ShellDialect = 'cmd' | 'powershell' | 'bash' | 'wsl'

export interface ShellChoice {
  file: string
  args: string[]
  label: string
  /** Syntax the model is told to write; wsl still speaks bash. */
  dialect: ShellDialect
  /**
   * Prepended to every command. Windows PowerShell 5.1 writes `>` output as
   * UTF-16 and decodes native output with the OEM codepage; pinning both to
   * UTF-8 keeps files and captured output readable.
   */
  commandPrefix: string
  /**
   * cmd.exe needs the command appended as raw text. Node's default Windows
   * quoting wraps the command in quotes and breaks commands that already
   * contain quoted arguments (for example `node -e "..."`).
   */
  verbatim: boolean
}

export interface ShellResolution {
  platform: string
  env: NodeJS.ProcessEnv
  /** Explicit override; defaults to `DENIA_SHELL`. */
  override?: string | undefined
  /** `HKCU\Console\%%Startup\DelegationConsole`; null when unknown. */
  delegationConsole?: string | null
  readText?: (file: string) => string | null
  exists?: (file: string) => boolean
  find?: (name: string) => string | null
}

const CMD_ARGS = ['/d', '/s', '/c'] as const
const POWERSHELL_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'] as const
const POWERSHELL_UTF8 =
  "$PSDefaultParameterValues['Out-File:Encoding']='utf8'; " +
  '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); '

/** Windows Terminal's package family names, in lookup order. */
const TERMINAL_PACKAGES = [
  'Microsoft.WindowsTerminal_8wekyb3d8bbwe',
  'Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe',
  'Microsoft.WindowsTerminalCanary_8wekyb3d8bbwe',
] as const

/** Delegation GUIDs that mean Windows Terminal owns the console. */
const TERMINAL_DELEGATIONS = new Set([
  '{2eaca947-7f5f-4cfa-ba87-8f7fbeefbe69}',
  '{e12cff52-a866-4c77-9a90-f570a7aa2c6b}',
])
/** `Let Windows decide`; Windows 11 resolves this to Windows Terminal. */
const LET_WINDOWS_DECIDE = '{00000000-0000-0000-0000-000000000000}'

/** Built-in Windows Terminal profile GUIDs that have no explicit commandline. */
const GUID_WINDOWS_POWERSHELL = '{61c54bbd-c2c6-5271-96e7-009a87ff44bf}'
const GUID_POWERSHELL_7 = '{574e775e-4f2a-5b96-ac1e-a2962a402336}'
const GUID_CMD = '{0caa0dad-35be-5f56-a8ff-afceeeaa6101}'
const GUID_WSL = '{2c4de342-38b7-51cf-b940-2309a097f518}'

let cachedShell: ShellChoice | null | undefined

function findOnPath(name: string): string | null {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (probe.status !== 0) return null
  const line = probe.stdout.split(/\r?\n/).find((entry) => entry.trim().length > 0)
  return line ? line.trim() : null
}

function readTextFile(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function expandEnv(text: string, env: NodeJS.ProcessEnv): string {
  return text.replace(/%([^%]+)%/g, (match, name: string) => {
    const value = env[name] ?? env[name.toUpperCase()] ?? env[name.toLowerCase()]
    return value ?? match
  })
}

/** Map an executable to the non-interactive invocation Denia uses. */
export function shellFromExecutable(
  file: string,
  options: { fixedArgs?: readonly string[]; login?: boolean } = {},
): ShellChoice {
  const base = file.replaceAll('\\', '/').split('/').pop()?.toLowerCase() ?? ''
  const fixed = options.fixedArgs ?? []
  switch (base) {
    case 'cmd':
    case 'cmd.exe':
      return { file, args: [...CMD_ARGS], label: 'cmd', dialect: 'cmd', commandPrefix: '', verbatim: true }
    case 'powershell':
    case 'powershell.exe':
    case 'pwsh':
    case 'pwsh.exe':
      return {
        file,
        args: [...POWERSHELL_ARGS],
        label: base.startsWith('pwsh') ? 'PowerShell' : 'Windows PowerShell',
        dialect: 'powershell',
        commandPrefix: POWERSHELL_UTF8,
        verbatim: false,
      }
    case 'wsl':
    case 'wsl.exe':
      // Keep leading profile args (for example `-d Ubuntu`) so the selected
      // distribution survives; then run the command through its bash.
      return {
        file,
        args: [...fixed, '-e', 'bash', '-lc'],
        label: 'WSL',
        dialect: 'wsl',
        commandPrefix: '',
        verbatim: false,
      }
    case 'git-bash.exe':
    case 'bash':
    case 'bash.exe':
    case 'sh':
    case 'sh.exe':
      return {
        file,
        args: options.login === false ? ['-c'] : ['-lc'],
        label: 'bash',
        dialect: 'bash',
        commandPrefix: '',
        verbatim: false,
      }
    default:
      // Unknown shells share the `-c` contract; the runtime note names the
      // executable so the model can adapt instead of assuming bash.
      return {
        file,
        args: ['-c'],
        label: base || file,
        dialect: 'bash',
        commandPrefix: '',
        verbatim: false,
      }
  }
}

/** Executable and argv for one command, including the shell's preamble. */
export function shellInvocation(choice: ShellChoice, command: string): { file: string; args: string[] } {
  return {
    file: choice.file,
    args: [...choice.args, choice.commandPrefix ? `${choice.commandPrefix}${command}` : command],
  }
}

function splitCommandLine(line: string): { file: string; args: string[] } {
  const trimmed = line.trim()
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1)
    if (end > 0) return { file: trimmed.slice(1, end), args: trimmed.slice(end + 1).trim().split(/\s+/).filter(Boolean) }
  }
  const [file = trimmed, ...args] = trimmed.split(/\s+/)
  return { file, args }
}

function stripJsonComments(text: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i++
      out += ' '
      continue
    }
    out += ch
  }
  return out
}

function stripTrailingCommas(text: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === ',') {
      let next = i + 1
      while (next < text.length && /\s/.test(text[next]!)) next++
      if (text[next] === '}' || text[next] === ']') continue
    }
    out += ch
  }
  return out
}

/** Windows Terminal accepts JSONC, so comments and trailing commas are legal. */
function parseJsonc(text: string): unknown {
  return JSON.parse(stripTrailingCommas(stripJsonComments(text.replace(/^\uFEFF/, ''))))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sameGuid(a: unknown, b: unknown): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase()
}

function windowsPowerShellPath(deps: Pick<ShellResolution, 'env' | 'find'>): string {
  const found = (deps.find ?? findOnPath)('powershell.exe')
  if (found) return found
  const root = deps.env.SystemRoot?.trim()
  return root ? path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe'
}

function findPowerShell7(deps: Pick<ShellResolution, 'find'>): string | null {
  const find = deps.find ?? findOnPath
  return find('pwsh.exe') ?? find('pwsh')
}

function shellFromGuid(guid: unknown, deps: Pick<ShellResolution, 'env' | 'find'>): ShellChoice | null {
  const key = typeof guid === 'string' ? guid.trim().toLowerCase() : ''
  switch (key) {
    case GUID_WINDOWS_POWERSHELL:
      return shellFromExecutable(windowsPowerShellPath(deps))
    case GUID_POWERSHELL_7: {
      const pwsh = findPowerShell7(deps)
      return pwsh ? shellFromExecutable(pwsh) : null
    }
    case GUID_CMD:
      return shellFromExecutable(deps.env.ComSpec?.trim() || 'cmd.exe')
    case GUID_WSL:
      return shellFromExecutable('wsl.exe')
    default:
      return null
  }
}

function gitBashExecutable(
  file: string,
  deps: Pick<ShellResolution, 'exists'>,
): string | null {
  const exists = deps.exists ?? existsSync
  const dir = path.dirname(file)
  for (const candidate of [path.join(dir, 'bin', 'bash.exe'), path.join(dir, 'usr', 'bin', 'bash.exe')]) {
    if (exists(candidate)) return candidate
  }
  return null
}

function shellFromProfile(
  profile: Record<string, unknown>,
  deps: Pick<ShellResolution, 'env' | 'find' | 'exists'>,
): ShellChoice | null {
  if (typeof profile.commandline === 'string' && profile.commandline.trim().length > 0) {
    const expanded = expandEnv(profile.commandline, deps.env)
    const { file, args } = splitCommandLine(expanded)
    if (file.replaceAll('\\', '/').split('/').pop()?.toLowerCase() === 'git-bash.exe') {
      // git-bash.exe is a launcher; the sibling bin/bash.exe takes -lc.
      const bash = gitBashExecutable(file, deps)
      if (bash) return shellFromExecutable(bash, { login: true })
    }
    return shellFromExecutable(file, { fixedArgs: args, login: true })
  }
  const source = typeof profile.source === 'string' ? profile.source : ''
  if (source === 'Windows.Terminal.PowershellCore') {
    const pwsh = findPowerShell7(deps)
    return pwsh ? shellFromExecutable(pwsh) : null
  }
  if (source === 'Microsoft.WSL') return shellFromExecutable('wsl.exe')
  return shellFromGuid(profile.guid, deps)
}

/** Resolve the default profile of a parsed Windows Terminal `settings.json`. */
export function shellFromTerminalSettings(
  text: string,
  deps: Pick<ShellResolution, 'env' | 'find' | 'exists'>,
): ShellChoice | null {
  let doc: unknown
  try {
    doc = parseJsonc(text)
  } catch {
    return null
  }
  if (!isRecord(doc)) return null
  const profiles = doc.profiles
  let list: unknown[] = []
  let defaultProfile = doc.defaultProfile
  if (Array.isArray(profiles)) {
    list = profiles
  } else if (isRecord(profiles)) {
    if (Array.isArray(profiles.list)) list = profiles.list
    defaultProfile = profiles.defaultProfile ?? defaultProfile
  }
  const profile = list.find((entry) => isRecord(entry) && sameGuid(entry.guid, defaultProfile))
  if (isRecord(profile)) return shellFromProfile(profile, deps)
  return shellFromGuid(defaultProfile, deps)
}

function windowsTerminalSettings(env: NodeJS.ProcessEnv): string[] {
  const local = env.LOCALAPPDATA?.trim()
  if (!local) return []
  const files = TERMINAL_PACKAGES.map((pkg) =>
    path.join(local, 'Packages', pkg, 'LocalState', 'settings.json'),
  )
  files.push(path.join(local, 'Microsoft', 'Windows Terminal', 'settings.json'))
  return files
}

function windowsTerminalShell(input: ShellResolution): ShellChoice | null {
  const delegation = input.delegationConsole?.trim().toLowerCase()
  // Another terminal host (conhost, ConEmu, ...) owns the default; its shell
  // configuration is not readable here, so fall back to ComSpec.
  if (delegation && delegation !== LET_WINDOWS_DECIDE && !TERMINAL_DELEGATIONS.has(delegation)) {
    return null
  }
  const read = input.readText ?? readTextFile
  for (const file of windowsTerminalSettings(input.env)) {
    const text = read(file)
    if (!text) continue
    const choice = shellFromTerminalSettings(text, input)
    if (choice) return choice
  }
  return null
}

/** Resolve the platform/overrides into the shell Denia actually spawns. */
export function resolveShellChoice(input: ShellResolution): ShellChoice {
  const find = input.find ?? findOnPath
  const override = (input.override ?? input.env.DENIA_SHELL ?? '').trim()
  if (override) {
    const file =
      override.includes('/') || override.includes('\\')
        ? expandEnv(override, input.env)
        : (find(override) ?? override)
    return shellFromExecutable(file, { login: input.platform === 'win32' })
  }
  if (input.platform !== 'win32') {
    const bash = find('bash') ?? (existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh')
    return shellFromExecutable(bash, { login: false })
  }
  return windowsTerminalShell(input) ?? shellFromExecutable(input.env.ComSpec?.trim() || 'cmd.exe')
}

/** Read the console delegation GUID; `reg` is unavailable off Windows. */
function defaultTerminalDelegate(): string | null {
  const probe = spawnSync(
    'reg',
    ['query', 'HKCU\\Console\\%%Startup', '/v', 'DelegationConsole'],
    { encoding: 'utf8', windowsHide: true },
  )
  if (probe.status !== 0) return null
  const match = /DelegationConsole\s+REG_SZ\s+(\{[^}]+\})/i.exec(probe.stdout)
  return match?.[1] ?? null
}

export function shellChoice(): ShellChoice {
  if (cachedShell !== undefined) {
    if (cachedShell === null) {
      // Resolve lazily again after a failed probe; the environment may change.
      cachedShell = undefined
    } else {
      return cachedShell
    }
  }
  cachedShell = resolveShellChoice({
    platform: process.platform,
    env: process.env,
    delegationConsole: process.platform === 'win32' ? defaultTerminalDelegate() : null,
  })
  return cachedShell
}

const ORPHAN_SWEEP_MS = 400

/**
 * `taskkill /T` snapshots the tree once. A shell that is still starting can
 * create its command right after that snapshot; the orphan inherits the stdio
 * pipes and keeps the tool result waiting forever. Sweep the dead shell's
 * remaining children once more, but never touch a reused pid.
 */
function sweepOrphans(parentPid: number): void {
  const script = [
    `$parent = ${parentPid}`,
    'if (Get-Process -Id $parent -ErrorAction SilentlyContinue) { exit 0 }',
    'Get-CimInstance Win32_Process -Filter "ParentProcessId=$parent" -ErrorAction SilentlyContinue |',
    '  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
  ].join('\n')
  const sweep = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    stdio: 'ignore',
  })
  sweep.on('error', () => {})
}

export function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.killed) return
  if (process.platform === 'win32' && child.pid !== undefined) {
    const pid = child.pid
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
    const sweep = setTimeout(() => sweepOrphans(pid), ORPHAN_SWEEP_MS)
    sweep.unref?.()
    return
  }
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }
}

export const BashTool = {
  schema: schema(
    'bash',
    'Run one shell command in the project and return its output. Commands run through the system default shell: the default Windows Terminal profile on Windows, bash on macOS/Linux, or DENIA_SHELL when set. The runtime context names the actual shell and the syntax to write. The primary project directory is the cwd; every project directory is exported in DENIA_PROJECT_DIRS. Prefer non-interactive commands; long-running work should be split into smaller commands.',
    {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 shell 命令。' },
        timeout_ms: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_TIMEOUT_MS,
          description: '超时时间(毫秒),默认 120000,最大 600000。',
        },
        run_in_background: {
          type: 'boolean',
          description: '后台执行并立即返回任务 id;用 job_output 读取输出、job_kill 停止。',
        },
      },
      required: ['command'],
    },
  ),
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const command = expectString(args, 'command')
    if (ctx.cancel.aborted) {
      return {
        content: '[工具错误] 命令被用户中断\n退出码: 1\n',
        isError: true,
        meta: { exit_code: 1, end_reason: 'cancelled', files: [], duration_ms: 0, evidence_complete: true },
        errorIdentity: { name: 'bash', code: 'cancelled' },
      }
    }
    if (optionalBoolean(args, 'run_in_background') === true) {
      if (!ctx.jobs) {
        return toolError('当前部署未启用后台任务;请直接用前台 bash,或把长任务拆成更小的命令。')
      }
      try {
        const job = ctx.jobs.start({
          owner: ctx.sessionId,
          cwd: ctx.cwd,
          command,
          ...(ctx.permission ? { permission: ctx.permission } : {}),
          cancel: ctx.cancel,
        })
        return textOutput(JSON.stringify(job))
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error))
      }
    }
    const timeoutMs = Math.min(
      MAX_TIMEOUT_MS,
      Math.max(1, Math.round(optionalNumber(args, 'timeout_ms') ?? DEFAULT_TIMEOUT_MS)),
    )
    const shell = shellChoice()
    const started = Date.now()

    return await new Promise<ReturnType<typeof textOutput>>((resolve) => {
      let stdout = ''
      let stderr = ''
      let settled = false
      let ended = 'completed'
      let error: string | null = null
      const pendingStream: { stream: string; text: string }[] = []
      let flushTimer: NodeJS.Timeout | null = null
      let timer: NodeJS.Timeout | null = null
      let settleGuard: NodeJS.Timeout | null = null

      const flushStream = () => {
        flushTimer = null
        if (pendingStream.length === 0) return
        const merged = pendingStream.splice(0)
        for (const part of merged) {
          try {
            ctx.emit({ type: 'tool-output-chunk', call_id: ctx.callId, stream: part.stream, text: part.text })
          } catch {
            /* live output is observational only */
          }
        }
      }

      const append = (stream: 'stdout' | 'stderr', text: string) => {
        if (stdout.length + stderr.length > MAX_CAPTURE_CHARS) return
        if (stream === 'stdout') stdout += text
        else stderr += text
        const last = pendingStream[pendingStream.length - 1]
        if (last && last.stream === stream) last.text += text
        else pendingStream.push({ stream, text })
        if (!flushTimer) flushTimer = setTimeout(flushStream, STREAM_INTERVAL_MS)
        flushTimer.unref?.()
      }

      const finish = (exitCode: number | null) => {
        if (settled) return
        settled = true
        if (flushTimer) {
          clearTimeout(flushTimer)
          flushTimer = null
        }
        flushStream()
        if (timer) clearTimeout(timer)
        if (settleGuard) {
          clearTimeout(settleGuard)
          settleGuard = null
        }
        ctx.cancel.removeEventListener('abort', onAbort)
        const durationMs = Date.now() - started
        let content = ''
        if (error) content += `[工具错误] ${error}\n`
        content += `退出码: ${exitCode ?? -1}\n${stdout}`
        if (stderr) content += `\n--- stderr ---\n${stderr}`
        const meta = {
          exit_code: exitCode,
          end_reason: ended,
          files: [],
          duration_ms: durationMs,
          evidence_complete: true,
        }
        if (error && ended !== 'completed') {
          resolve({ content, isError: true, meta, errorIdentity: { name: 'bash', code: ended } })
        } else {
          resolve(textOutput(content, meta))
        }
      }

      let child: ChildProcess
      try {
        const call = shellInvocation(shell, command)
        child = spawn(call.file, call.args, {
          cwd: ctx.cwd,
          windowsHide: true,
          windowsVerbatimArguments: shell.verbatim,
          detached: process.platform !== 'win32',
          env: {
            ...process.env,
            DENIA_PROJECT_DIRS: ctx.roots.join(process.platform === 'win32' ? ';' : ':'),
            DENIA_PROJECT_ROOT: ctx.cwd,
          },
        })
      } catch (spawnError) {
        error = `命令没能启动:${spawnError instanceof Error ? spawnError.message : String(spawnError)}`
        ended = 'spawn_failed'
        finish(null)
        return
      }

      // A killed grandchild can keep the stdio pipes open. Bound the wait so a
      // stopped turn always settles with the output captured so far.
      const armSettleGuard = () => {
        if (settleGuard) return
        settleGuard = setTimeout(() => {
          settleGuard = null
          if (settled) return
          child.stdout?.destroy()
          child.stderr?.destroy()
          finish(child.exitCode)
        }, 1_500)
        settleGuard.unref?.()
      }

      const onAbort = () => {
        ended = 'cancelled'
        error = '命令被用户中断'
        killTree(child)
        armSettleGuard()
      }
      ctx.cancel.addEventListener('abort', onAbort, { once: true })

      timer = setTimeout(() => {
        ended = 'timeout'
        error = `命令超时(${timeoutMs} ms 未结束)`
        killTree(child)
        armSettleGuard()
      }, timeoutMs)
      timer.unref?.()

      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => append('stdout', chunk))
      child.stderr?.on('data', (chunk: string) => append('stderr', chunk))
      child.on('error', (spawnError) => {
        error = `命令没能启动:${spawnError.message}`
        ended = 'spawn_failed'
        finish(null)
      })
      child.on('close', (code) => finish(code))
    })
  },
}
