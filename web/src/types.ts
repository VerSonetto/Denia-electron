// Shared wire types are generated from Rust/serde; UI-only types stay here.
import type { ModelSelection, LlmFailure, TokenUsage, StreamChunk, FinishReason, ContentBlock, TurnEndReason, TodoItem, AskOption, AskQuestion, AskAnswer, AskOutcome, AskResolution, PermissionMode, GoalStatus, GoalOp, SessionEnvelope, PresetFeatures, PresetSpec, SessionHeader as WireSessionHeader, ImageData as UserMessageImage, SubagentProfile, SubagentProfileView, SubagentInlineSpec, ToolSelection, ModelChoice, PermissionCeiling, ProfileSource, ProfileWriteScope, ProfileColor, ProfileDiagnostic, SubagentCatalogEntry, SubagentDescriptor } from './generated/core'
export type { ModelSelection, LlmFailure, TokenUsage, StreamChunk, FinishReason, ContentBlock, TurnEndReason, TodoItem, AskOption, AskQuestion, AskAnswer, AskOutcome, AskResolution, PermissionMode, GoalStatus, GoalOp, SessionEnvelope, PresetFeatures, PresetSpec, UserMessageImage, SubagentProfile, SubagentProfileView, SubagentInlineSpec, ToolSelection, ModelChoice, PermissionCeiling, ProfileSource, ProfileWriteScope, ProfileColor, ProfileDiagnostic, SubagentCatalogEntry, SubagentDescriptor }
export type SessionHeader = WireSessionHeader & { agent_preset?: string }

/** 定义目录响应：有效项 + 被覆盖项 + 诊断（来源元数据由服务端生成）。 */
export interface SubagentCatalogView {
  scope: 'user' | 'project'
  projectRoot?: string | null
  projectDir?: string | null
  userDir: string
  revision: number
  effective: SubagentProfileView[]
  shadowed: SubagentProfileView[]
  diagnostics: ProfileDiagnostic[]
  colors: ProfileColor[]
  sources: ProfileSource[]
}

/** 真实工具目录：来源、能力分类与可授予性。 */
export interface SubagentToolRow {
  name: string
  source: string
  category: string
  /** 副作用说明（写/shell/MCP 的影响必须看得见）。 */
  effect: string
  /** 只读上限下是否被拒（与执行面 `ceiling_denied_tool` 同源）。 */
  readOnlyDenied: boolean
  granted: boolean | null
  grantable: boolean
  /** 子代理硬禁用（禁止派遣 / 宿主配置 / 会话主控）：UI 显示为不可选。 */
  hardDenied: boolean
  reason: string
}

export interface SubagentToolsView {
  sessionId?: string | null
  registered: number
  tools: SubagentToolRow[]
}

/** 派遣预览：只有指定父会话时才宣称"最终可用工具"。 */
export interface SubagentPreview {
  sessionId?: string | null
  final: boolean
  note?: string
  requested?: string
  profile?: {
    qualifiedId: string
    name: string
    description: string
    inline: boolean
    revision: number
  }
  tools?: string[]
  toolCount?: number
  model?: ModelSelection
  modelOrigin?: 'call-override' | 'profile-explicit' | 'parent'
  /** 显式模型不可用时的回退说明；有值说明实际用的是父会话模型。 */
  modelFallback?: string | null
  permissionCeiling?: PermissionCeiling
  effectivePermissionMode?: PermissionMode
  delegationAllowed?: boolean
  instructionScope?: string
  fingerprint?: string
}
/** Wire types shared with the Rust backend. camelCase mirrors serde. */

export interface ProviderInfo {
  id: string
  name: string
}

export interface ReasoningEffortInfo {
  id: string
  name: string
  description?: string
}

export interface ReasoningInfo {
  efforts: ReasoningEffortInfo[]
  defaultEffort?: string
}

export interface CatalogModel {
  id: string
  name: string
  description?: string
  contextWindow?: number
  inputModalities?: string[]
  thinkingSupported?: boolean
  reasoning?: ReasoningInfo
}

export interface ModelProviderGroup {
  id: string
  name: string
  models: CatalogModel[]
}

export interface ModelCatalogFailure {
  id: string
  name: string
  message: string
}

/** 网关路由的线上协议(与 Rust `WireProtocol` 的 serde 标识对齐)。 */
export type WireProtocol = 'openai-completions' | 'openai-responses' | 'anthropic-messages'

export interface ModelCatalog {
  routableProviders: string[]
  groups: ModelProviderGroup[]
  failures: ModelCatalogFailure[]
}

export interface CredentialInfo {
  configured: boolean
  source?: string
  writable: boolean
}

export interface SecretInfo {
  path: string[]
  set: boolean
}

export interface NamespaceView {
  ns: string
  value: Record<string, unknown>
  base?: Record<string, unknown>
  user?: Record<string, unknown>
  revision: number
  applies: 'live' | 'restart'
  secrets: SecretInfo[]
}

export interface SettingsDescribe {
  writable: boolean
  documentPath: string
  namespaces: NamespaceView[]
}

export interface DiscoveredModel {
  id: string
  name?: string
}

/** One configured gateway route in the `llm-openai` section. */
export interface OpenAiProfile {
  baseURL: string
  displayName?: string
  apiKeyEnv?: string
  /** 路由的线上协议;缺省即 chat/completions。 */
  protocol?: WireProtocol
  models: {
    id: string
    name?: string
    description?: string
    contextWindow?: number
    inputModalities?: string[]
    thinkingSupported?: boolean
    reasoningEfforts?: string[]
  }[]
  defaultContextWindow?: number
  defaultMaxTokens?: number
  /** 附加请求头;值支持 `${REF}` 引用凭据/环境变量(整段占位)。 */
  headers?: Record<string, string>
  /** 定向兼容:网关把推理内联进 content(以 `</think>` 收尾)时,开启后拆成推理块。默认关闭。 */
  inlineThinkTags?: boolean
  /** 把历史推理正文回传给 chat/completions。默认关闭:多数网关不认,且每次请求都重新计费。 */
  replayReasoning?: boolean
  /** 请求提供方的长缓存档:Anthropic `ttl: "1h"`、OpenAI 24h retention。 */
  longCache?: boolean
  /** 路由是否接受 OpenAI 的 `prompt_cache_key`;严格网关可关闭。默认开启。 */
  supportsPromptCacheKey?: boolean
}

/** 输入框中的一张粘贴图片:预览 data URL 供缩略图,data 是发给模型的原始 base64。 */
export interface PastedImage {
  name: string
  mime: string
  data: string
  bytes: number
  preview: string
}

/** 输入框中的一份已选附件:只持宿主机绝对路径,不发文件内容。
 *
 * 旧版本用 `{ name, mime, file }` 把整个 File 塞进草稿,发送时转 base64 上传;那
 * 条路对大文件必撞请求体上限,而且只是把磁盘上的原件又复制一份。现在存路径，
 * 模型用 read_file 按需读。 */
export interface PendingAttachment {
  name: string
  /** 宿主机绝对路径。 */
  path: string
}

/** 旧草稿可能只剩 `{ name, mime, file }`(已选但尚未发送)——
 * 没有绝对路径就拿不到原件,恢复时直接丢弃而不是静默变成"看起来能发、
 * 发送时才报错"。 */
export function isPendingAttachment(value: unknown): value is PendingAttachment {
  const candidate = value as Partial<PendingAttachment> | null
  return typeof candidate === 'object' && candidate !== null
    && typeof candidate.name === 'string'
    && typeof candidate.path === 'string' && candidate.path.length > 0
}

/**
 * 一条排队消息:AI 运行中输入的新消息,本轮结束后自动发送。
 *
 * 与输入框同一套载荷 —— 图片/附件/轨迹引用都随消息一起排队,不再只承载
 * 纯文本:排队时把输入区里的这些内容整体搬进队列(输入区随之下空),发送
 * 时原样交回 postMessage,与手动发送走同一条链路。
 */
export interface QueuedMessage {
  id: string
  text: string
  images?: PastedImage[]
  attachments?: PendingAttachment[]
  /** 轨迹引用(与 trajectory.ts 的 TrajectoryQuote 同形,避免循环依赖在此展开)。 */
  quotes?: { id: string; title: string; text: string }[]
  /**
   * 发送方式（旧持久化队列缺省视为 guide：原语义就是"本轮结束后发送"）。
   * - guide：不打断当前轮次，服务端在步骤边界注入（未赶上则由队列在轮次
   *   结束后按普通消息发送）；
   * - interject：立即打断并发送（`sendNow` 的语义，用于重试失败的插话）。
   */
  mode?: 'guide' | 'interject'
  /**
   * 队列投递状态：queued = 等轮次结束；steering = 已交给服务端，等下一步骤。
   * 只用于显示与自动发送前的宽限判定，不参与服务端状态。
   */
  state?: 'queued' | 'steering'
  /** 入队时的模型选择：切走会话后自动发送仍用当时选择的模型。 */
  selection?: ModelSelection
  /** 入队时刻（epoch ms），用于日志与排序诊断。 */
  queuedAt?: number
}

/** 旧日志三档值 → 新四档的显示映射(serde alias 的前端对应)。 */
export function normalizePermissionMode(raw: string): PermissionMode {
  if (raw === 'workspace-write') return 'auto-edit'
  if (raw === 'danger-full-access') return 'full'
  if (raw === 'read-only' || raw === 'auto-edit' || raw === 'plan' || raw === 'full') {
    return raw
  }
  return 'auto-edit'
}

/**
 * 权限选择器可选值:后端四档之外,Electron 宿主多一个「自动审批」。
 * 不支持的宿主没有该值,前端用能力探测(`/api/permissions/catalog`)
 * 决定是否展示。
 */
export type PermissionChoice = PermissionMode | 'approve-for-me'

export function normalizePermissionChoice(raw: string): PermissionChoice {
  if (raw === 'approve-for-me') return 'approve-for-me'
  return normalizePermissionMode(raw)
}

export interface SessionSummary {
  /** 子代理运行快照（wire 类型由 Rust 生成；旧日志由 serde default 补齐）。 */
  subagent?: SubagentDescriptor
  id: string
  created_at: number
  /** 最近一次活动时间（会话日志 mtime）；侧栏按它排序与显示相对时间。 */
  updated_at?: number
  excerpt: string | null
  /** AI 生成的会话标题(第一轮用户消息后后台产出);展示优先于 excerpt。 */
  title: string | null
  cwd?: string
  sandbox?: boolean
  cwd_alive?: boolean
  /** 分支血缘:父会话 id;侧栏据此把子会话嵌套在源会话之下。 */
  parent_session?: string
  /** 会话运行的 agent preset(id);创建时写入,缺省表示后端未提供。 */
  agent_preset?: string
  /**
   * 会话最后实际使用的模型(服务端对整份日志的投影)。
   * 切换会话时输入框恢复到它;缺省表示该会话还没发过请求。
   */
  last_selection?: ModelSelection
}

/**
 * 全会话累计统计(服务端对整份日志的投影,见 Rust `denia_session::SessionTotals`)。
 *
 * 分页只给窗口,窗口里没有早期轮次 —— 状态栏的轮次/耗时/token 用它当基准,
 * 再叠加实时帧,刷新/翻页/长会话裁剪才不会让累计数字缩水。
 */
export interface SessionTotals {
  /** 已闭合轮次的墙钟时长之和(毫秒);进行中的轮次由界面加实时值。 */
  turnMs: number
  turns: number
  steps: number
  toolCalls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  reasoningTokens: number
}

/** 用量页可选的统计区间;服务端拥有这份集合,界面不另抄一份。 */
export type UsageRange = 'today' | '7d' | '30d' | 'all'

/**
 * 一个统计区间的 token 计数。
 *
 * 口径与 `TokenUsage` 一致:`inputTokens` 是**未缓存**输入,与
 * `cacheReadTokens` 互斥;`reasoningTokens` 是输出侧的明细,不计入总量。
 */
export interface UsageBucket {
  inputTokens: number
  cacheReadTokens: number
  outputTokens: number
  reasoningTokens: number
  /** 上报了用量的模型请求数。 */
  requests: number
  /** 已闭合轮次。 */
  turns: number
  /** 工具调用数。 */
  toolCalls: number
}

export interface UsageSummary extends UsageBucket {
  /** 计费 token = 未缓存输入 + 缓存读 + 输出。 */
  totalTokens: number
  /** 缓存读 /(未缓存输入 + 缓存读),百分比;无任何缓存上报时为 null。 */
  cacheHitRate: number | null
  activeDays: number
  peakDay: string | null
  peakDayTokens: number
  currentStreakDays: number
  longestStreakDays: number
  /** 区间内上报过用量的会话数。 */
  sessions: number
}

export interface UsageDay extends UsageBucket {
  /** 本地日历日,YYYY-MM-DD。 */
  date: string
  totalTokens: number
}

export interface UsageModelRow extends UsageBucket {
  provider: string
  model: string
  totalTokens: number
  /** 占当前区间总量的比例,0–1。 */
  share: number
}

export interface UsageSessionRow extends UsageBucket {
  id: string
  title: string | null
  cwd: string | null
  updatedAt: number
  /** 由父会话派遣产生,而非用户直接发起。 */
  subagent: boolean
  totalTokens: number
}

export interface UsageHeatmapCell {
  date: string
  totalTokens: number
  requests: number
  /** 0 = 无用量,1–4 为最忙当天的四等分。 */
  level: number
}

export interface UsageHeatmapWeek {
  weekIndex: number
  /** 七格,周一在前;今天之后的列为 null。 */
  days: (UsageHeatmapCell | null)[]
}

export interface UsageHeatmap {
  startDate: string
  endDate: string
  maxTokens: number
  weeks: UsageHeatmapWeek[]
}

/** 用量快照(/api/usage)。 */
export interface UsageSnapshot {
  range: UsageRange
  /** 服务端接受的区间;页面按它渲染切换项。 */
  ranges: UsageRange[]
  generatedAt: number
  timeZone: string
  /** 全量累计:总览条与热力图不随区间收窄。 */
  lifetime: UsageSummary
  summary: UsageSummary
  /** 区间内连续的每日数据,最早在前。 */
  days: UsageDay[]
  models: UsageModelRow[]
  sessions: UsageSessionRow[]
  heatmap: UsageHeatmap
}

/** agent preset 名册里的一行(随附或用户自定义)。 */
export interface AgentPresetRow {
  id: string
  trust: 'shipped' | 'user'
  name: string
  description: string
  /** 工具白名单;缺省表示出厂全量工具集。 */
  tools?: string[]
  hasPersona: boolean
  /** 用户根目录下的 preset 才可删除、可被对照。 */
  writable: boolean
  /** 功能开关快照(关闭项在卡片上列出)。 */
  features: PresetFeatures
  path?: string
  /** 损坏原因;有值时该行无法用于会话。 */
  broken?: string
}

export interface AgentPresetsView {
  /** 新建会话未显式指定时使用的默认 preset id。 */
  default: string
  /** 是否显示模式选择器;关闭时空白会话固定用部署默认预设。 */
  modeSelection: boolean
  /** 用户 preset 根目录(展示与"用编辑器打开"用)。 */
  root: string
  /** 部署已注册的工具名(排序后):编辑器工具多选的数据源。 */
  tools: string[]
  presets: AgentPresetRow[]
}

export interface WorkspaceEntry {
  path: string
  name?: string
}

/** 工作区注册表记录。 */
export interface WorkspaceRecord {
  id: string
  path: string
  title: string
  createdAt: number
  sessionIds: string[]
}

/* ---- 内嵌浏览器(与 browser 工具同款命令面) ---- */

export interface BrowserTabInfo {
  tabId: string
  url: string
  title: string
  active: boolean
}

export interface BrowserState {
  running: boolean
  activeTabId?: string | null
  tabs: BrowserTabInfo[]
  dialogs?: unknown[]
}

export interface BrowserOutcome {
  ok: boolean
  error?: { code: string; message: string }
  value?: unknown
  state?: Record<string, unknown>
  snapshot?: {
    url?: string
    title?: string
    elements?: {
      ref: string
      tag: string
      name?: string
      rect?: { x: number; y: number; width: number; height: number }
      inViewport?: boolean
      editable?: boolean
      href?: string
    }[]
    truncated?: boolean
  }
  image?: { base64: string; mimeType: string }
  dialog?: { type?: string; message?: string } | null
  tabs?: BrowserTabInfo[]
  elapsedMs: number
}

/** /api/browser/stream 的一帧事件。 */
export type BrowserEventFrame =
  | { type: 'tabs-changed' }
  | { type: 'frame'; tabId: string; data: string; viewport?: { width: number; height: number } }
  | { type: 'dialog-opened'; tabId: string; kind: string; message: string }
  | { type: 'dialog-closed'; tabId: string }
  | { type: 'navigated'; tabId: string; url: string; title: string }
  | { type: 'visual-mode-requested' }
  | { type: 'exited' }

/** 微信通道状态(/api/channels/weixin)。 */
export interface WeixinChannelStatus {
  connected: boolean
  account: { accountId: string; userId: string } | null
  lastError: string | null
  /** 最近一条入站消息的时刻、字符数与处理动作(诊断用)。 */
  lastInboundAt: number | null
  lastInboundChars: number
  lastAction: string | null
  login: {
    status: string
    message: string | null
    qrSvg: string
    qrContent: string
  } | null
}

/** QQ 机器人通道状态(/api/channels/qqbot)。 */
export interface QqbotChannelStatus {
  connected: boolean
  account: { appId: string } | null
  lastError: string | null
  lastInboundAt: number | null
  lastInboundChars: number
  lastAction: string | null
}

/* ---- 远程访问(/api/remote/*) ---- */

export type RemoteClientKind = 'mobile' | 'desktop' | 'browser'

export interface RemoteClientView {
  id: string
  label: string
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
  clientKind: RemoteClientKind
  deviceName: string | null
  devicePlatform: string | null
  appVersion: string | null
}

export interface RemotePairingView {
  id: string
  createdAt: string
  expiresAt: string
  usedAt: string | null
  cancelledAt: string | null
  clientId: string | null
  label: string | null
  /** 带外核对用指纹,形如 A1B2-C3D4。 */
  fingerprint: string
  allowedKinds: RemoteClientKind[]
}

export interface RemoteCandidateView {
  type: 'lan' | 'tunnel'
  url: string
  priority?: number
}

export interface RemoteStatusView {
  /** true 表示这次请求来自宿主本机(桌面窗口 / 本机浏览器)。 */
  local: boolean
  authenticated: boolean
  enabled: boolean
  listenPort: number
  bindHost: string | null
  publicUrl: string | null
  listening: boolean
  listenerError: string | null
  addresses: { lan: string[]; publicUrl: string | null }
  serverLabel?: string
  /** 服务器稳定标识;App 用它防止把令牌发给换了主的局域网地址。 */
  serverId?: string
  clientKind?: RemoteClientKind | null
  clients?: RemoteClientView[]
  pending?: RemotePairingView[]
}

export interface RemotePairingCreated {
  pairing: RemotePairingView
  secret: string
  code: string
  link: string
  candidates: RemoteCandidateView[]
}
