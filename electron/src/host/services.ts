// Host services: the seam between the agent loop, MCP, subagents, skills and
// project memory.
//
// The loop owns turns; this module answers "which extra tools exist",
// "execute that tool", and "what context should be injected now". MCP
// lazy-loading and frozen subagent grants share one filter here.

import type { PermissionState } from '../core/permission.ts'
import type {
  Envelope,
  ModelSelection,
  SessionHeader,
  ToolCallRef,
  ToolOutput,
  ToolSchema,
} from '../core/wire.ts'
import type { McpManager } from '../mcp/manager.ts'
import type { SubagentPromptContext } from '../agent/system-prompt.ts'
import type { SessionServices } from '../agent/loop.ts'
import type { ToolContext } from '../tools/types.ts'
import { textOutput } from '../tools/types.ts'
import { McpListTool, McpTool } from '../tools/mcp.ts'
import { legacyChildTools } from '../subagents/types.ts'
import type { SubagentRuntime } from '../subagents/runtime.ts'
import type { SessionStore } from '../session/store.ts'
import { discoverSkills, renderEmptySkillCatalog, renderSkillCatalog } from '../skills/skills.ts'
import {
  memoryRoot,
  readIndexForInjection,
  renderIndexBlock,
  renderMemorySection,
} from '../context/memory.ts'
import {
  discoverWorkspaceInstructions,
  renderWorkspaceInstructions,
} from '../context/workspace-instructions.ts'

export interface HostServicesOptions {
  mcp: McpManager
  subagents: SubagentRuntime
  home: string
  store: SessionStore
  memoryEnabled?: boolean
  memoryIndexMaxBytes?: number
  workspaceInstructionsMaxBytes?: number
  skillCatalogDescriptionMaxChars?: number
}

export class HostServices implements SessionServices {
  private readonly mcp: McpManager
  private readonly subagents: SubagentRuntime
  private readonly home: string
  private readonly store: SessionStore
  private readonly memoryEnabled: boolean
  private readonly memoryIndexMaxBytes: number
  private readonly workspaceInstructionsMaxBytes: number
  private readonly skillCatalogDescriptionMaxChars: number
  private readonly loaded = new Map<string, Set<string>>()
  private readonly mcpTools = new Map<string, McpTool>()
  private readonly listTool: McpListTool

  constructor(options: HostServicesOptions) {
    this.mcp = options.mcp
    this.subagents = options.subagents
    this.home = options.home
    this.store = options.store
    this.memoryEnabled = options.memoryEnabled ?? true
    this.memoryIndexMaxBytes = options.memoryIndexMaxBytes ?? 25_600
    this.workspaceInstructionsMaxBytes = options.workspaceInstructionsMaxBytes ?? 65_536
    this.skillCatalogDescriptionMaxChars = options.skillCatalogDescriptionMaxChars ?? 500
    this.listTool = new McpListTool(this.mcp, (sessionId) => this.subagents.grantOf(sessionId))
  }

  private loadedOf(sessionId: string): Set<string> {
    let set = this.loaded.get(sessionId)
    if (!set) {
      set = new Set()
      this.loaded.set(sessionId, set)
    }
    return set
  }

  private grantedTools(header: SessionHeader): Set<string> | null {
    if (!header.subagent) return null
    return new Set(header.subagent.effectiveTools ?? legacyChildTools(header.subagent.allowedTools))
  }

  private allowed(header: SessionHeader, name: string): boolean {
    const granted = this.grantedTools(header)
    return granted === null || granted.has(name)
  }

  extraSchemas(sessionId: string, header: SessionHeader, state: PermissionState): ToolSchema[] {
    const out: ToolSchema[] = []
    const snapshot = this.mcp.snapshot()
    if (snapshot.hasConnected() && this.allowed(header, 'mcp_list')) {
      out.push(this.listTool.schema)
    }
    const loaded = this.loadedOf(sessionId)
    for (const def of snapshot.toolDefs()) {
      if (!loaded.has(def.name)) continue
      if (!this.allowed(header, def.name)) continue
      out.push(this.mcpToolOf(def.name, def.description, def.schema).schema)
    }
    for (const schema of this.subagents.toolSchemas(sessionId)) {
      if (!this.allowed(header, schema.name)) continue
      out.push(schema)
    }
    void state
    return out
  }

  intercept(call: ToolCallRef, sessionId: string): ToolOutput | undefined {
    if (!call.name.startsWith('mcp__')) return undefined
    const snapshot = this.mcp.snapshot()
    if (!snapshot.route(call.name)) return undefined
    const loaded = this.loadedOf(sessionId)
    if (loaded.has(call.name)) return undefined
    loaded.add(call.name)
    const definition = snapshot.schemaOf(call.name) ?? { type: 'object' }
    return textOutput(
      `本工具尚未加载参数定义,本次调用未执行。完整参数定义(JSON Schema)如下:\n${JSON.stringify(definition, null, 2)}\n请按参数定义重新调用本工具,即可正常执行。`,
    )
  }

  async executeExtra(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolOutput | undefined> {
    if (name === 'mcp_list') {
      return this.listTool.execute(args, ctx)
    }
    if (name.startsWith('mcp__')) {
      const snapshot = this.mcp.snapshot()
      if (!snapshot.route(name)) return undefined
      this.loadedOf(ctx.sessionId).add(name)
      const tool =
        this.mcpTools.get(name) ??
        this.mcpToolOf(name, snapshot.descriptionOf(name), snapshot.schemaOf(name))
      return tool.execute(args, ctx)
    }
    const result = await this.subagents.executeTool(name, args, {
      sessionId: ctx.sessionId,
      cwd: ctx.cwd,
      ...(ctx.selection ? { selection: ctx.selection } : {}),
    })
    if (!result) return undefined
    return { content: result.content, isError: result.isError }
  }

  drainInbox(sessionId: string): void {
    this.subagents.drainInbox(sessionId)
  }

  onTurnEnd(sessionId: string): void {
    this.subagents.onTurnEnd(sessionId)
  }

  promptSections(sessionId: string, header: SessionHeader): string[] {
    const sections: string[] = []
    if (!header.subagent && this.memoryEnabled) {
      sections.push(renderMemorySection(memoryRoot(this.home, header.cwd)))
    }
    const catalog = this.subagents.catalogText(sessionId)
    if (catalog) sections.push(catalog)
    const mcp = this.mcpDiscipline()
    if (mcp) sections.push(mcp)
    return sections
  }

  injections(sessionId: string, header: SessionHeader): { channel: string; text: string }[] {
    const out: { channel: string; text: string }[] = []
    const events = this.store.read(sessionId)?.events ?? []
    const previous = (channel: string): string | null => {
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index]!
        if (event.type === 'user-message' && event.channel === channel) return event.text
      }
      return null
    }
    const files = discoverWorkspaceInstructions(
      this.home,
      header.cwd,
      touchedPathsOf(events, header.cwd),
      1_048_576,
      header.subagent ? 'project-only' : 'global-and-project',
    )
    const workspace = renderWorkspaceInstructions(
      files,
      this.workspaceInstructionsMaxBytes,
      previous('workspace-instructions'),
    )
    if (workspace) out.push({ channel: 'workspace-instructions', text: workspace })

    if (this.allowed(header, 'skill')) {
      const skills = discoverSkills(this.home, header.cwd).skills
      const catalog = renderSkillCatalog(skills, this.skillCatalogDescriptionMaxChars)
      if (catalog) out.push({ channel: 'skill-catalog', text: catalog })
      else if (previous('skill-catalog') !== null) {
        out.push({ channel: 'skill-catalog', text: renderEmptySkillCatalog() })
      }
    }

    if (!header.subagent && this.memoryEnabled) {
      const root = memoryRoot(this.home, header.cwd)
      const index = readIndexForInjection(root, this.memoryIndexMaxBytes)
      if (index) out.push({ channel: 'project-memory', text: renderIndexBlock(root, index) })
    }
    return out
  }

  memoryRoot(sessionId: string, header: SessionHeader): string | null {
    if (header.subagent || !this.memoryEnabled) return null
    void sessionId
    return memoryRoot(this.home, header.cwd)
  }

  context(sessionId: string): SubagentPromptContext | null {
    return this.subagents.contextOf(sessionId)
  }

  selectionFor(sessionId: string): ModelSelection | undefined {
    return this.subagents.selectionOf(sessionId)
  }

  private mcpDiscipline(): string | null {
    const snapshot = this.mcp.snapshot()
    if (!snapshot.hasConnected()) return null
    const servers = snapshot.servers
      .filter((server) => server.enabled && server.status === 'connected')
      .map((server) => server.id)
    return [
      '[denia MCP 能力]',
      `已连接的 MCP 服务器：${servers.join('、')}。`,
      '外部工具以 mcp__<服务器>__<工具> 命名；先用 mcp_list 查看清单（可按 server 过滤），再按名称直接调用。',
      '首次调用只返回 JSON Schema、不执行；按定义尽快重新调用即可执行。不要把 MCP 当成内置能力，也不要向用户解释“用 MCP”。',
      '长结果按字符分页：带尾部给出的 result_id 与更大的 offset 再调用同一工具可续读同一次结果（不会重新执行）；优先收窄查询，不要靠翻页从头读到尾。',
      '调用失败先读错误里的可执行建议（通常需要到设置 → MCP 检查服务器状态或重连），不要反复重试同一调用。',
    ].join('\n')
  }

  private mcpToolOf(name: string, description: string, schema: unknown): McpTool {
    const existing = this.mcpTools.get(name)
    if (existing) return existing
    const tool = new McpTool(name, description, schema, this.mcp)
    this.mcpTools.set(name, tool)
    return tool
  }
}

/** Paths touched by file tools in this session (workspace instructions). */
function touchedPathsOf(events: Envelope[], cwd: string): string[] {
  const out: string[] = []
  for (const event of events) {
    if (event.type !== 'tool-call') continue
    if (!['read_file', 'write_file', 'edit', 'grep', 'glob', 'ls'].includes(event.name)) continue
    try {
      const args = JSON.parse(event.arguments) as unknown
      if (typeof args !== 'object' || args === null || Array.isArray(args)) continue
      const raw = (args as Record<string, unknown>).path
      if (typeof raw !== 'string' || raw.trim() === '') continue
      const absolute = raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw)
        ? raw
        : `${cwd}/${raw}`
      if (!out.includes(absolute)) out.push(absolute)
    } catch {
      /* unparsable arguments do not contribute touched paths */
    }
  }
  return out.slice(-32)
}