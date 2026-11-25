// Host services: the seam between the agent loop, MCP, subagents, skills and
// project memory.
//
// The loop owns turns; this module answers "which extra tools exist",
// "execute that tool", and "what context should be injected now". MCP tool
// declarations and frozen subagent grants share one filter here.

import type { PermissionState } from '../core/permission.ts'
import type {
  Envelope,
  ModelSelection,
  SessionHeader,
  TokenUsage,
  ToolOutput,
  ToolSchema,
  TurnEndReason,
} from '../core/wire.ts'
import fs from 'node:fs'
import path from 'node:path'

import type { McpManager } from '../mcp/manager.ts'
import { visibleInjections } from '../agent/history.ts'
import { buildRuntimeContext, DEFAULT_PERSONA } from '../agent/system-prompt.ts'
import { presetForSession } from '../agent/presets.ts'
import type { PromptExtraSection, SubagentPromptContext } from '../agent/system-prompt.ts'
import type { SessionServices } from '../agent/loop.ts'
import type { ToolContext } from '../tools/types.ts'
import type { Tool } from '../tools/types.ts'
import type { FileHistoryBackend } from '../tools/types.ts'
import { McpListTool, McpTool } from '../tools/mcp.ts'
import { createJobTools } from '../tools/jobs.ts'
import { GoalReadTool } from '../tools/goal.ts'
import type { GoalRuntime } from '../goal/runtime.ts'
import { formatGoalStateForModel } from '../goal/prompts.ts'
import type { JobManager } from '../jobs/manager.ts'
import { legacyChildTools } from '../subagents/types.ts'
import type { SubagentRuntime } from '../subagents/runtime.ts'
import type { SessionStore } from '../session/store.ts'
import type { FileHistoryStore } from '../session/file-history.ts'
import { discoverSkills, loadSkill, renderEmptySkillCatalog, renderSkillCatalog } from '../skills/skills.ts'
import {
  projectMemoryRoot,
  readIndexForInjection,
  renderIndexBlock,
  renderMemorySection,
} from '../context/memory.ts'
import {
  discoverProjectInstructions,
  renderProjectInstructions,
} from '../context/project-instructions.ts'
import type { ProjectRecord, ProjectStore } from '../project/store.ts'

export interface HostServicesOptions {
  mcp: McpManager
  subagents: SubagentRuntime
  /** Background-job registry; absent in bare deployments and unit tests. */
  jobs?: JobManager
  home: string
  store: SessionStore
  /** Project registry: directories, membership and the default fallback. */
  projects: ProjectStore
  /** File rewind history shared by tool backups and the HTTP rewind routes. */
  fileHistory: FileHistoryStore
  /** Current permission state for runtime-context snapshots. */
  permissionStateOf: (sessionId: string) => PermissionState
  /** Session goal runtime; absent in bare deployments and unit tests. */
  goal?: GoalRuntime
  memoryEnabled?: boolean
  memoryIndexMaxBytes?: number
  projectInstructionsMaxBytes?: number
  skillCatalogDescriptionMaxChars?: number
  /** This instance's HTTP base URL; resolved lazily once the server listens. */
  apiBase?: () => string
}

/** On-disk override for the deployment persona (same file as the Rust host). */
const SYSTEM_PROMPT_FILE = 'SYSTEM.md'

export class HostServices implements SessionServices {
  private readonly mcp: McpManager
  private readonly subagents: SubagentRuntime
  private readonly jobManager: JobManager | undefined
  private readonly jobTools: Tool[]
  private readonly home: string
  private readonly store: SessionStore
  private readonly projects: ProjectStore
  private readonly fileHistoryStore: FileHistoryStore
  private readonly permissionStateOf: (sessionId: string) => PermissionState
  private readonly memoryEnabled: boolean
  private readonly memoryIndexMaxBytes: number
  private readonly projectInstructionsMaxBytes: number
  private readonly skillCatalogDescriptionMaxChars: number
  private readonly apiBase: (() => string) | undefined
  /** Cached SYSTEM.md text; undefined = not read yet, null = factory persona. */
  private systemPrompt: string | null | undefined
  /**
   * MCP tool wrappers, keyed by qualified name. The cache is dropped whenever
   * the connection snapshot changes, so a reconnected server's new schema and
   * description reach the tool surface instead of the stale wrapper.
   */
  private mcpToolVersion = -1
  private readonly mcpTools = new Map<string, McpTool>()
  private readonly listTool: McpListTool
  private readonly goalRuntime: GoalRuntime | undefined
  private readonly goalReadTool: GoalReadTool | undefined

  constructor(options: HostServicesOptions) {
    this.mcp = options.mcp
    this.subagents = options.subagents
    this.jobManager = options.jobs
    this.jobTools = options.jobs ? createJobTools(options.jobs) : []
    this.home = options.home
    this.store = options.store
    this.projects = options.projects
    this.fileHistoryStore = options.fileHistory
    this.permissionStateOf = options.permissionStateOf
    this.memoryEnabled = options.memoryEnabled ?? true
    this.memoryIndexMaxBytes = options.memoryIndexMaxBytes ?? 25_600
    this.projectInstructionsMaxBytes = options.projectInstructionsMaxBytes ?? 65_536
    this.skillCatalogDescriptionMaxChars = options.skillCatalogDescriptionMaxChars ?? 500
    this.apiBase = options.apiBase
    this.systemPrompt = undefined
    this.listTool = new McpListTool(this.mcp, (sessionId) => this.subagents.grantOf(sessionId))
    this.goalRuntime = options.goal
    this.goalReadTool = options.goal ? new GoalReadTool(options.goal) : undefined
  }

  /** Project owning a session; legacy headers fall back by cwd/default. */
  projectOf(header: SessionHeader): ProjectRecord {
    return (
      this.projects.get(header.project_id) ??
      this.projects.projectForPath(header.cwd) ??
      this.projects.default
    )
  }

  /** Every directory the model may touch for this session. */
  rootsOf(header: SessionHeader): string[] {
    return this.projects.rootsOf(this.projectOf(header), header.cwd)
  }

  projectRoots(_sessionId: string, header: SessionHeader): string[] {
    return this.rootsOf(header)
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
    void sessionId
    const out: ToolSchema[] = []
    const snapshot = this.mcp.snapshot()
    if (snapshot.hasConnected() && this.allowed(header, 'mcp_list')) {
      out.push(this.listTool.schema)
    }
    // Every connected MCP tool ships its real parameter schema, so the model
    // can call it on the first try instead of fetching the definition first.
    for (const def of snapshot.toolDefs()) {
      if (!this.allowed(header, def.name)) continue
      out.push(this.mcpToolOf(snapshot.version, def.name, def.description, def.schema).schema)
    }
    for (const schema of this.subagents.toolSchemas(sessionId)) {
      if (!this.allowed(header, schema.name)) continue
      out.push(schema)
    }
    for (const tool of this.jobTools) {
      if (!this.allowed(header, tool.schema.name)) continue
      out.push(tool.schema)
    }
    if (!header.subagent && this.goalReadTool && this.allowed(header, this.goalReadTool.schema.name)) {
      out.push(this.goalReadTool.schema)
    }
    void state
    return out
  }

  /** The job manager, for the loop to hand down to the `bash` tool. */
  get jobs(): JobManager | undefined {
    return this.jobManager
  }

  async executeExtra(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolOutput | undefined> {
    if (name === 'mcp_list') {
      return this.listTool.execute(args, ctx)
    }
    if (name === 'goal_read' && this.goalReadTool) {
      return this.goalReadTool.execute(args, ctx)
    }
    if (name.startsWith('mcp__')) {
      const snapshot = this.mcp.snapshot()
      if (!snapshot.route(name)) return undefined
      const tool = this.mcpToolOf(
        snapshot.version,
        name,
        snapshot.descriptionOf(name),
        snapshot.schemaOf(name),
      )
      return tool.execute(args, ctx)
    }
    const jobTool = this.jobTools.find((tool) => tool.schema.name === name)
    if (jobTool) return jobTool.execute(args, ctx)
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

  fileSnapshot(sessionId: string, scope: string | readonly string[], messageSeq: number): void {
    this.fileHistoryStore.snapshot(sessionId, scope, messageSeq)
  }

  fileHistory(sessionId: string, scope: string | readonly string[]): FileHistoryBackend {
    return this.fileHistoryStore.backend(sessionId, scope)
  }

  onTurnStart(sessionId: string): void {
    this.subagents.onTurnStart(sessionId)
    this.goalRuntime?.onTurnStart(sessionId)
  }

  onTurnEnd(sessionId: string, reason: TurnEndReason, usage?: TokenUsage): void {
    this.subagents.onTurnEnd(sessionId, reason)
    this.goalRuntime?.onTurnEnd(sessionId, reason, usage)
  }

  /**
   * Runtime-owned system-prompt sections, placed at their fixed slots:
   * memory before the communication group, MCP inside the tool group.
   * The goal discipline is static (it only depends on `goal_read` being on
   * the tool surface); the live objective travels on the `goal` channel.
   */
  promptSections(_sessionId: string, header: SessionHeader): PromptExtraSection[] {
    const sections: PromptExtraSection[] = []
    if (!header.subagent && this.memoryEnabled) {
      sections.push({
        name: 'memory',
        text: renderMemorySection(projectMemoryRoot(this.home, this.projectOf(header))),
      })
    }
    const mcp = this.mcpDiscipline()
    if (mcp) sections.push({ name: 'mcp', text: mcp })
    return sections
  }

  /** Deployment persona: SYSTEM.md when present, factory persona otherwise. */
  persona(): string {
    return this.systemPromptText() ?? DEFAULT_PERSONA
  }

  systemPromptView(): { text: string; source: 'default' | 'file'; path: string } {
    const text = this.systemPromptText()
    return {
      text: text ?? DEFAULT_PERSONA,
      source: text === null ? 'default' : 'file',
      path: path.join(this.home, SYSTEM_PROMPT_FILE),
    }
  }

  saveSystemPrompt(text: string): void {
    const file = path.join(this.home, SYSTEM_PROMPT_FILE)
    if (text.trim() === '') {
      fs.rmSync(file, { force: true })
      this.systemPrompt = null
      return
    }
    fs.writeFileSync(file, text, 'utf8')
    this.systemPrompt = text
  }

  resetSystemPrompt(): void {
    fs.rmSync(path.join(this.home, SYSTEM_PROMPT_FILE), { force: true })
    this.systemPrompt = null
  }

  private systemPromptText(): string | null {
    if (this.systemPrompt !== undefined) return this.systemPrompt
    try {
      const text = fs.readFileSync(path.join(this.home, SYSTEM_PROMPT_FILE), 'utf8')
      this.systemPrompt = text.trim() === '' ? null : text
    } catch {
      this.systemPrompt = null
    }
    return this.systemPrompt
  }

  injections(sessionId: string, header: SessionHeader): { channel: string; text: string }[] {
    const out: { channel: string; text: string }[] = []
    const events = this.store.read(sessionId)?.events ?? []
    // Compare against what the model can actually see: compaction hides a seq
    // range without deleting it, and a hidden baseline must be rendered again
    // instead of being treated as already injected.
    const visible = visibleInjections(events)
    const previous = (channel: string, legacy?: string): string | null =>
      visible.get(channel) ?? (legacy !== undefined ? (visible.get(legacy) ?? null) : null)
    const roots = this.rootsOf(header)
    const files = discoverProjectInstructions(
      this.home,
      roots,
      1_048_576,
      header.subagent ? 'project-only' : 'global-and-project',
    )
    const instructions = renderProjectInstructions(
      files,
      this.projectInstructionsMaxBytes,
      previous('project-instructions', 'workspace-instructions'),
    )
    if (instructions) out.push({ channel: 'project-instructions', text: instructions })

    out.push({
      channel: 'capability',
      text: `[denia 能力上下文]\n当前代理：${sessionId}；父代理：${header.parent_session ?? '无'}。`,
    })

    if (this.allowed(header, 'skill')) {
      const skills = discoverSkills(this.home, roots).skills
      const catalog = renderSkillCatalog(skills, this.skillCatalogDescriptionMaxChars)
      if (catalog) out.push({ channel: 'skill-catalog', text: catalog })
      else if (previous('skill-catalog') !== null) {
        out.push({ channel: 'skill-catalog', text: renderEmptySkillCatalog() })
      }
    }

    if (!header.subagent && this.memoryEnabled) {
      const root = projectMemoryRoot(this.home, this.projectOf(header))
      const index = readIndexForInjection(root, this.memoryIndexMaxBytes)
      if (index) out.push({ channel: 'project-memory', text: renderIndexBlock(root, index) })
    }

    // Rust injects the delegation catalog as a step-boundary message so the
    // transcript can show it; it is not a system-prompt section.
    const catalog = this.subagents.catalogText(sessionId)
    if (catalog) out.push({ channel: 'subagent-catalog', text: catalog })

    if (!header.subagent && this.goalRuntime) {
      const goal = this.goalRuntime.read(sessionId)
      if (goal && goal.status !== 'complete') {
        out.push({ channel: 'goal', text: formatGoalStateForModel(goal) })
      }
    }

    out.push({
      channel: 'runtime-context',
      text: buildRuntimeContext({
        cwd: header.cwd,
        roots,
        sandbox: header.sandbox,
        permission: this.permissionStateOf(sessionId),
        ...(this.apiBase ? { apiBase: this.apiBase() } : {}),
      }),
    })
    return out
  }

  memoryRoot(sessionId: string, header: SessionHeader): string | null {
    if (header.subagent || !this.memoryEnabled) return null
    void sessionId
    return projectMemoryRoot(this.home, this.projectOf(header))
  }

  context(sessionId: string): SubagentPromptContext | null {
    return this.subagents.contextOf(sessionId)
  }

  /**
   * Load a user-invocable skill body for `/skill-name` and explicit `/skill`
   * selections. Unknown or model-only skills resolve to null: the gesture then
   * stays plain text instead of failing the turn.
   */
  userSkill(sessionId: string, name: string): { name: string; source: string; body: string } | null {
    const header = this.store.header(sessionId)
    if (!header) return null
    const skills = discoverSkills(this.home, this.rootsOf(header)).skills
    try {
      const loaded = loadSkill(skills, name, true)
      return { name: loaded.skill.name, source: loaded.skill.source, body: loaded.body }
    } catch {
      return null
    }
  }

  selectionFor(sessionId: string): ModelSelection | undefined {
    return this.subagents.selectionOf(sessionId)
  }

  historyFor(sessionId: string, events: Envelope[]): Envelope[] {
    return this.subagents.historyFor(sessionId, events)
  }

  notifyParent(sessionId: string, message: string): void {
    this.subagents.notifyParent(sessionId, message)
  }

  presetFor(sessionId: string, header: SessionHeader) {
    return presetForSession(this.home, header, this.store.read(sessionId)?.events ?? [])
  }

  private mcpDiscipline(): string | null {
    const snapshot = this.mcp.snapshot()
    if (!snapshot.hasConnected()) return null
    const servers = snapshot.servers
      .filter((server) => server.enabled && server.status === 'connected')
      .map((server) => server.id)
    return [
      `当前已接入的 MCP 服务器：${servers.join('、')}。`,
      '- mcp__<服务器>__<工具> 是用户接入的第三方能力，不是内置功能，也不向用户解释“用 MCP”。同名能力内置优先，内置做不到才用外部。这些工具的参数定义已直接声明在工具面上，按名称和参数直接调用即可执行；只有拿不准某个服务器有哪些工具时才用 mcp_list 查看清单。',
      '- 长结果按字符分页：每个 MCP 工具都带可选的 offset / limit / result_id 参数。输出尾部给出 result_id 时，带上同一个 result_id 与更大的 offset 再调一次即可续读同一次结果（不会重新执行）；不带 result_id 的调用都是新调用，会真实执行。优先收窄查询，不靠翻页从头读到尾。',
      '- 失败先读错误里的可执行建议（常需在设置 → MCP 检查或重连），不反复重试同一调用，换内置工具或请用户处理。',
    ].join('\n')
  }

  private mcpToolOf(version: number, name: string, description: string, schema: unknown): McpTool {
    // A reload can change a tool's schema or retire it: rebuild the wrappers so
    // the declared surface never lags behind the live connections.
    if (version !== this.mcpToolVersion) {
      this.mcpTools.clear()
      this.mcpToolVersion = version
    }
    const existing = this.mcpTools.get(name)
    if (existing) return existing
    const tool = new McpTool(name, description, schema, this.mcp)
    this.mcpTools.set(name, tool)
    return tool
  }
}
