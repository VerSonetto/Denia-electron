// System prompt assembly: base identity + permission snapshot + role additions.
//
// The base prompt stays byte-stable for ordinary sessions. Subagents get their
// definition instructions appended (never replacing the parent persona), plus
// hard constraints that keep delegation one level deep.

import os from 'node:os'

import type { PermissionState } from '../core/permission.ts'
import { modeOf } from '../core/permission.ts'
import type { ToolSchema } from '../core/wire.ts'

export interface SubagentPromptContext {
  name: string
  instructions: string
  permissionCeiling: 'inherit' | 'read-only'
  parentPersona?: string
  legacy?: boolean
}

export interface SystemPromptOptions {
  cwd: string
  sandbox: boolean
  tools: ToolSchema[]
  permission: PermissionState
  subagent?: SubagentPromptContext
  /** Extra sections appended after the working rules (catalog, MCP, memory). */
  extraSections?: string[]
}

/** One paragraph describing the active sandbox, approval policy and reviewer. */
function permissionSection(permission: PermissionState): string {
  const preset = modeOf(permission)
  const reviewer =
    permission.reviewer === 'auto-review'
      ? 'an automatic reviewer decides first; it only escalates uncertain or high-risk actions to the user'
      : 'the user is asked directly'
  const sandbox = {
    'read-only':
      'read-only: every write and every network access is rejected; shell commands must be statically provable read-only (ls, cat, git status, rg, …)',
    'workspace-write':
      'workspace-write: writes inside the workspace run directly; writes outside it, deletions, shell commands with write side effects and network access require approval',
    'danger-full-access': 'danger-full-access: no sandbox restrictions and no approval prompts',
  }[permission.sandbox]
  const lines = [
    `Permission mode: ${preset} (sandbox: ${permission.sandbox}, reviewer: ${permission.reviewer})`,
    `- ${sandbox}`,
    `- Approval routing: ${reviewer}.`,
  ]
  if (permission.collaboration === 'plan') {
    lines.push(
      '- Collaboration mode: plan — research only. Every write and side-effecting command is rejected; submit the plan with `exit_plan` and wait for the user.',
    )
  }
  lines.push(
    '- When a call is rejected by policy, read the reason, adapt (smaller scope, workspace path, read-only command), and continue; do not retry the same call.',
  )
  return lines.join('\n')
}

function hasTool(tools: ToolSchema[], name: string): boolean {
  return tools.some((tool) => tool.name === name)
}

export function buildSystemPrompt(options: SystemPromptOptions): string {
  const platform = `${process.platform} ${os.arch()}`
  const shellNote =
    process.platform === 'win32'
      ? '命令经 Git Bash(或 cmd.exe)执行;路径使用系统原生形式。'
      : '命令经 bash 执行。'
  const lines = [
    "You are Denia, an AI coding agent working directly in the user's local workspace.",
    '',
    `Workspace: ${options.cwd}`,
    `Platform: ${platform}`,
    shellNote,
    options.sandbox
      ? 'File tools are confined to the workspace; absolute paths outside it are rejected.'
      : 'File tools may access paths outside the workspace.',
    '',
    permissionSection(options.permission),
    '',
    'Working rules:',
    '- Read before you edit. Prefer `read_file` / `grep` / `glob` to understand code, then make the smallest change that solves the task.',
  ]
  if (hasTool(options.tools, 'edit')) {
    lines.push('- Prefer `edit` for local changes and `write_file` only for new files or full rewrites.')
  }
  if (hasTool(options.tools, 'bash')) {
    lines.push(
      '- Use `bash` for builds, tests, git and other commands. Do not claim a command passed unless it actually ran and its exit code was 0.',
    )
  }
  if (hasTool(options.tools, 'job_start')) {
    lines.push(
      '- Long-running work belongs in `job_start`: it returns a job id immediately. `job_output` returns the current output right away and `job_kill` stops the job. Do not poll or sleep to wait — the completion result is delivered automatically at the next step, and `pending` / `ready` never mean success or failure.',
      '- Background commands are not an exploration tool: listing, searching and reading still use `ls` / `glob` / `grep` / `read_file`; the same holds for `job_start` when `bash` is unavailable.',
    )
  }
  lines.push(
    '- Keep the user informed: short progress notes between tool batches are welcome; do not narrate every internal thought.',
    '- Do not invent files, APIs or results. If something is unknown, inspect it or say so.',
  )
  if (hasTool(options.tools, 'todo_write')) {
    lines.push('- When the task is multi-step, use `todo_write` once at the start and update it as work completes.')
  }
  lines.push('', "Reply in the user's language (Chinese by default). Be concise and concrete.")

  if (options.subagent) {
    const sub = options.subagent
    lines.push(
      '',
      `# Subagent role: ${sub.name}`,
      sub.instructions.trim() === ''
        ? '(This role has no extra instructions; follow the base rules.)'
        : sub.instructions.trim(),
      '',
      '# Subagent constraints',
      '- You are a subagent. You cannot delegate to other agents, create or modify agent definitions, or change the session plan/goal.',
      '- Work only on the task you were given. Report success, failure (with the reason), or a decision the parent must make.',
      '- You only have the tools listed in this request. Do not pretend to call anything else.',
      '- Your role instructions are added to the parent persona; they never replace it.',
    )
    if (sub.permissionCeiling === 'read-only') {
      lines.push('- Your permission ceiling is read-only: writing files and running commands are refused; investigate and report only.')
    }
    if (sub.legacy) {
      lines.push('- This subagent predates tool snapshots; its grant is the conservative historical read-only set.')
    }
    if (sub.parentPersona?.trim()) {
      lines.push('', 'Parent persona (kept for continuity):', sub.parentPersona.trim())
    }
  }

  for (const section of options.extraSections ?? []) {
    if (section.trim() !== '') lines.push('', section.trim())
  }
  return lines.join('\n')
}