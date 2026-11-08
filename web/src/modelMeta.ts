/**
 * 远程模型元数据自动补全:models.dev /api.json 作支持清单,按模型 id
 * 匹配后补齐上下文窗口/识图/思考/强度档位,减少手工配置。
 * CORS 开放(ACAO:*),浏览器可直连;数据只进本地缓存,不发往外部。
 */

/** models.dev 单条模型元数据的所需字段(顶层按提供方分组)。 */
interface ModelsDevModel {
  id: string
  name?: string
  modalities?: { input?: string[] }
  reasoning?: boolean
  reasoning_options?: Array<{ type?: string; values?: string[] }>
  limit?: { context?: number }
}

/** 与 denia 模型条目对齐的补全项;未命中的字段缺失。 */
export interface ModelMetaHint {
  contextWindow?: number
  vision?: boolean
  thinking?: boolean
  efforts?: string[]
}

const ENDPOINT = 'https://models.dev/api.json'
const FETCH_TIMEOUT_MS = 15_000

/**
 * 拉取策略:每次应用启动/界面刷新拉一次(启动时预取),之后只读内存、
 * 不再发请求 —— 内存结果在则直接返回,永不重新拉取。
 */
let memory: ModelsDevModel[] | null = null
let inflight: Promise<ModelsDevModel[] | null> | null = null

/** 启动预取入口:结果落进模块内存,失败静默,补全时不再重试。 */
export function prefetchModelMeta(): void {
  void fetchModelMeta()
}

/** 获取清单(仅内存);未预取或预取失败时才现场拉一次。 */
export async function fetchModelMeta(): Promise<ModelsDevModel[] | null> {
  if (memory) return memory
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
      try {
        const response = await fetch(ENDPOINT, { signal: controller.signal })
        if (!response.ok) return null
        const body = (await response.json()) as Record<
          string,
          { models?: Record<string, ModelsDevModel> }
        >
        const models: ModelsDevModel[] = []
        for (const provider of Object.values(body)) {
          for (const model of Object.values(provider.models ?? {})) {
            if (model && typeof model.id === 'string') models.push(model)
          }
        }
        // 成功与否都定格:失败不重试,避免每次失焦都打一次网络。
        memory = models.length > 0 ? models : null
        return memory
      } finally {
        clearTimeout(timer)
      }
    } catch {
      return null
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/**
 * 按模型 id 匹配元数据:精确命中优先;models.dev 的 id 是提供方裸 id,
 * 仅对「provider/model」形态的输入剥前缀,再容忍 -日期后缀差异。
 */
export function matchModelMeta(models: ModelsDevModel[], id: string): ModelsDevModel | null {
  const raw = id.trim().toLowerCase()
  if (!raw) return null
  const bare = raw.includes('/') ? (raw.split('/').pop() ?? raw) : raw
  const loose = bare.replace(/-\d{6,8}$/, '')
  let partial: ModelsDevModel | null = null
  for (const model of models) {
    const candidate = model.id.toLowerCase()
    if (candidate === raw || candidate === bare) return model
    if (candidate.replace(/-\d{6,8}$/, '') === loose) partial ??= model
  }
  return partial
}

/** models.dev 档位词元 denia 的强度档位;不认识的不带过去。 */
const EFFORT_ALIASES: Record<string, string> = {
  none: 'off',
  off: 'off',
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
  maximum: 'max',
}

/** 从匹配到的元数据提取补全项;档位取 effort 型 reasoning_options 的 values。 */
export function metaToHint(model: ModelsDevModel): ModelMetaHint {
  const hint: ModelMetaHint = {}
  const context = model.limit?.context
  if (typeof context === 'number' && context > 0) hint.contextWindow = context
  const inputs = model.modalities?.input
  if (Array.isArray(inputs)) hint.vision = inputs.includes('image')
  if (model.reasoning === true) {
    hint.thinking = true
    const option = (model.reasoning_options ?? []).find((entry) => entry?.type === 'effort')
    const values = option?.values
    if (Array.isArray(values)) {
      const efforts = [
        ...new Set(
          values
            .map((value) =>
              typeof value === 'string' ? EFFORT_ALIASES[value.toLowerCase()] : undefined,
            )
            .filter((value): value is string => Boolean(value)),
        ),
      ]
      if (efforts.length > 0) hint.efforts = efforts
    }
  }
  return hint
}
