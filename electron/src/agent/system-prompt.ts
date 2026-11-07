// The system prompt for the first TypeScript cut.
//
// This is deliberately smaller than the Rust prompt assembly (skills, memory,
// presets, MCP and task discipline all come later), but it carries the rules
// the agent loop relies on: act in the workspace, prefer real verification,
// report honestly, and use tools one step at a time.

import os from 'node:os'

import type { PermissionState } from '../core/permission.ts'
import { modeOf } from '../core/permission.ts'
import type { ToolSchema } from '../core/wire.ts'

export interface SystemPromptOptions {
  cwd: string
  sandbox: boolean
  tools: ToolSchema[]
  permission: PermissionState
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

export function buildSystemPrompt(options: SystemPromptOptions): string {
  const platform = `${process.platform} ${os.arch()}`
  const shellNote =
    process.platform === 'win32'
      ? '命令经 Git Bash(或 cmd.exe)执行;路径使用系统原生形式。'
      : '命令经 bash 执行。'
  return [
    'You are Denia, an AI coding agent working directly in the user\'s local workspace.',
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
    '- Prefer `edit` for local changes and `write_file` only for new files or full rewrites.',
    '- Use `bash` for builds, tests, git and other commands. Do not claim a command passed unless it actually ran and its exit code was 0.',
    '- Keep the user informed: short progress notes between tool batches are welcome; do not narrate every internal thought.',
    '- Do not invent files, APIs or results. If something is unknown, inspect it or say so.',
    '- When the task is multi-step, use `todo_write` once at the start and update it as work completes.',
    '',
    'Reply in the user\'s language (Chinese by default). Be concise and concrete.',
  ].join('\n')
}