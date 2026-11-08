/**
 * 提供方弹窗里的模型行编辑器:ID/名称/上下文窗口/识图/思考/强度档位。
 * 行数少(个位数量级),直接受控渲染;批量目录展示走 ModelsPanel 的窗口化列表。
 */

import { memo, useRef, useState } from 'react'
import { t } from '../../i18n'
import {
  REASONING_EFFORT_IDS,
  REASONING_EFFORT_OFF,
  REASONING_INTENSITY_IDS,
  type CatalogModelEntry,
  type ReasoningEffortId,
  defaultReasoningEfforts,
  formatContextWindow,
  hasVision,
  isReasoningEffortId,
  setVision,
} from '../../modelCatalog'
import { reasoningEffortLabel } from '../../reasoningEffort'
import type { DiscoveredModel } from '../../types'
import { fetchModelMeta, matchModelMeta, metaToHint, type ModelMetaHint } from '../../modelMeta'
import { NumberInput, TextInput } from './atoms/form'
import { DiscoverFlow, type DiscoverParams } from './DiscoverFlow'
import styles from './ModelRowsEditor.module.css'

function toggleEffort(
  efforts: ReasoningEffortId[] | undefined,
  effort: ReasoningEffortId,
  enabled: boolean,
): ReasoningEffortId[] {
  const current = new Set(efforts ?? defaultReasoningEfforts())
  if (enabled) {
    current.add(effort)
    if (effort === 'off') {
      for (const id of REASONING_INTENSITY_IDS) current.delete(id)
    } else {
      current.delete('off')
    }
  } else {
    current.delete(effort)
    if (current.size === 0) current.add('off')
  }
  return REASONING_EFFORT_IDS.filter((id) => current.has(id))
}

/** 补全项的展示名,与命中提示的 fields 顺序保持一致。 */
function hintFields(hint: ModelMetaHint): string[] {
  const names: string[] = []
  if (hint.contextWindow !== undefined) names.push(t('contextWindowColumn'))
  if (hint.vision !== undefined) names.push(t('visionColumn'))
  if (hint.thinking !== undefined) names.push(t('thinkingColumn'))
  if (hint.efforts !== undefined) names.push(t('effortLevelsColumn'))
  return names
}

/** 清单档位词(已过别名映射)→ 去重排序后的 ReasoningEffortId 列表。 */
function toReasoningEffortIds(efforts: string[]): ReasoningEffortId[] {
  const known = efforts.filter((id): id is ReasoningEffortId => isReasoningEffortId(id))
  const hasIntensity = known.some((id) => REASONING_INTENSITY_IDS.includes(id as never))
  // 清单给出强度档位时补上「关」,与手配开思考的默认形态一致。
  return hasIntensity && !known.includes(REASONING_EFFORT_OFF)
    ? [REASONING_EFFORT_OFF, ...known]
    : known
}

/** 把补全项合入条目;只往「开启能力」方向补,不覆盖用户的手配。 */
function applyMetaHint(entry: CatalogModelEntry, hint: ModelMetaHint): {
  entry: CatalogModelEntry
  applied: ModelMetaHint
} {
  const next: CatalogModelEntry = { ...entry }
  const applied: ModelMetaHint = {}
  if (hint.contextWindow !== undefined && !next.contextWindow) {
    next.contextWindow = hint.contextWindow
    applied.contextWindow = hint.contextWindow
  }
  // 识图只在清单说支持而条目没勾时补勾;清单说不支持时不动手配。
  if (hint.vision === true && !hasVision(next)) {
    next.inputModalities = setVision(next, true).inputModalities
    applied.vision = true
  }
  // 思考同理:清单说支持而条目未开时补开,档位一并按清单回填。
  if (hint.thinking === true && next.thinkingSupported !== true) {
    next.thinkingSupported = true
    next.reasoningEfforts = hint.efforts
      ? toReasoningEffortIds(hint.efforts)
      : defaultReasoningEfforts()
    applied.thinking = true
    if (hint.efforts) applied.efforts = hint.efforts
  }
  return { entry: next, applied }
}

const EffortChips = memo(function EffortChips({
  efforts,
  disabled,
  onToggle,
}: {
  efforts: ReasoningEffortId[] | undefined
  disabled?: boolean
  onToggle: (effort: ReasoningEffortId, enabled: boolean) => void
}) {
  return (
    <div className={styles.efforts} role="group" aria-label={t('effortLevelsColumn')}>
      {REASONING_EFFORT_IDS.map((effort) => {
        const active = (efforts ?? defaultReasoningEfforts()).includes(effort)
        return (
          <button
            key={effort}
            type="button"
            className={`${styles.effort}${active ? ` ${styles.effortActive}` : ''}`}
            disabled={disabled}
            aria-pressed={active}
            onClick={() => onToggle(effort, !active)}
          >
            {reasoningEffortLabel(effort)}
          </button>
        )
      })}
    </div>
  )
})

export function ModelRowsEditor({
  models,
  onChange,
  defaultContextWindow,
  discoverParams,
  disabled,
  onCommit,
}: {
  models: CatalogModelEntry[]
  onChange: (models: CatalogModelEntry[]) => void
  defaultContextWindow?: number
  /** 提供方探测参数;baseURL 为空时探测按钮自会报错。 */
  discoverParams: () => DiscoverParams
  disabled?: boolean
  /** 自动保存的显式提交点:输入框失焦即落盘,不等防抖。 */
  onCommit?: () => void
}) {
  // 所有异步写回(补全回来时组件可能已重渲染)都经 ref 读最新行集,
  // 否则 update 闭包里的旧 models 会把新行/别的改动冲掉。
  const modelsRef = useRef(models)
  modelsRef.current = models
  const update = (index: number, patch: Partial<CatalogModelEntry>) => {
    onChange(modelsRef.current.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)))
  }

  // 补全提示:命中后短暂展示补了哪些字段;每行一份,换行时清旧计时器。
  const [metaNotice, setMetaNotice] = useState<{ index: number; fields: string; ok: boolean } | null>(null)
  const noticeTimerRef = useRef<number | undefined>(undefined)
  const showMetaNotice = (index: number, fields: string[], ok: boolean) => {
    window.clearTimeout(noticeTimerRef.current)
    setMetaNotice({ index, fields: fields.join(' · '), ok })
    noticeTimerRef.current = window.setTimeout(() => setMetaNotice(null), 4000)
  }

  /** ID 失焦/导入后的统一入口:查公开清单,命中且能补出东西才写回。 */
  const tryAutoFill = async (index: number, modelId: string) => {
    const id = modelId.trim()
    if (!id) return
    const list = await fetchModelMeta()
    // 拉取失败静默降级,不误报「未收录」。
    if (!list) return
    const hit = matchModelMeta(list, id)
    if (!hit) {
      showMetaNotice(index, [], false)
      return
    }
    const hint = metaToHint(hit)
    // 再次校验 id:等待期间用户可能已改掉该行,命中也不能写错行。
    const rows = modelsRef.current
    const current = rows[index]
    if (!current || current.id.trim() !== id) return
    const { entry, applied } = applyMetaHint(current, hint)
    const fields = hintFields(applied)
    if (fields.length === 0) return
    update(index, entry)
    showMetaNotice(index, fields, true)
  }

  const addBlank = () => {
    onChange([
      ...models,
      {
        id: '',
        inputModalities: ['text'],
        thinkingSupported: false,
        contextWindow: defaultContextWindow,
      },
    ])
  }

  const importDiscovered = (found: DiscoveredModel[]) => {
    // 导入的行与清单一并交给自动补全;onChange 回传后父级 setState 是异步的,
    // 等一轮宏任务让 modelsRef 反映新行集,再逐条触发补全。
    const added: { index: number; id: string }[] = []
    const next = [...models]
    for (const model of found) {
      if (next.some((entry) => entry.id === model.id)) continue
      added.push({ index: next.length, id: model.id })
      next.push({
        id: model.id,
        name: model.name && model.name !== model.id ? model.name : undefined,
        inputModalities: ['text'],
        thinkingSupported: false,
      })
    }
    onChange(next)
    if (added.length === 0) return
    void (async () => {
      const list = await fetchModelMeta()
      // setState 是异步的:等一帧让 modelsRef 摄入刚导入的行。
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (!list) return
      const rows = modelsRef.current
      for (const item of added) {
        const index = rows.findIndex((entry) => entry.id === item.id)
        if (index >= 0) void tryAutoFill(index, item.id)
      }
    })()
  }

  return (
    <div className={styles.root}>
      <DiscoverFlow
        readParams={discoverParams}
        isAdded={(id) => models.some((entry) => entry.id === id)}
        onImport={importDiscovered}
        disabled={disabled}
      />

      <div className={styles.rows}>
        {models.length === 0 && (
          <p className={styles.empty}>{t('llm.models.emptyEditor')}</p>
        )}
        {models.map((entry, index) => (
          <div key={index} className={styles.row}>
            <div className={styles.rowGrid}>
              <TextInput
                mono
                placeholder={t('modelIdPlaceholder')}
                value={entry.id}
                disabled={disabled}
                onChange={(id) => update(index, { id })}
                onCommit={() => {
                  onCommit?.()
                  void tryAutoFill(index, entry.id)
                }}
              />
              <TextInput
                placeholder={entry.id || t('modelNamePlaceholder')}
                value={entry.name ?? ''}
                disabled={disabled}
                onChange={(name) => update(index, { name: name || undefined })}
                onCommit={onCommit}
              />
              <NumberInput
                value={entry.contextWindow}
                disabled={disabled}
                mono
                placeholder={
                  defaultContextWindow
                    ? `${t('contextWindowPlaceholder')} ${formatContextWindow(defaultContextWindow)}`
                    : t('contextWindowPlaceholder')
                }
                onChange={(contextWindow) => update(index, { contextWindow })}
                onCommit={onCommit}
              />
              <button
                type="button"
                className={`${styles.cap}${hasVision(entry) ? ` ${styles.capOn}` : ''}`}
                disabled={disabled}
                aria-pressed={hasVision(entry)}
                title={t('visionColumn')}
                onClick={() => update(index, setVision(entry, !hasVision(entry)))}
              >
                {t('visionColumn')}
              </button>
              <button
                type="button"
                className={`${styles.cap}${entry.thinkingSupported ? ` ${styles.capOn}` : ''}`}
                disabled={disabled}
                aria-pressed={entry.thinkingSupported === true}
                title={t('thinkingColumn')}
                onClick={() =>
                  update(index, {
                    thinkingSupported: entry.thinkingSupported !== true,
                    reasoningEfforts:
                      entry.thinkingSupported !== true ? defaultReasoningEfforts() : undefined,
                  })
                }
              >
                {t('thinkingColumn')}
              </button>
              <button
                type="button"
                className={styles.remove}
                disabled={disabled}
                title={t('removeModel')}
                aria-label={`${t('removeModel')} ${entry.id || index + 1}`}
                onClick={() => onChange(models.filter((_, i) => i !== index))}
              >
                ✕
              </button>
            </div>
            {metaNotice?.index === index && (
              <p className={styles.metaNotice} role="status">
                {metaNotice.ok
                  ? t('llm.models.metaFilled', { fields: metaNotice.fields })
                  : t('llm.models.metaMiss')}
              </p>
            )}
            {entry.thinkingSupported && (
              <EffortChips
                efforts={entry.reasoningEfforts}
                disabled={disabled}
                onToggle={(effort, enabled) =>
                  update(index, {
                    reasoningEfforts: toggleEffort(entry.reasoningEfforts, effort, enabled),
                  })
                }
              />
            )}
          </div>
        ))}
      </div>

      <div>
        <button
          type="button"
          className={styles.addBtn}
          disabled={disabled}
          onClick={addBlank}
        >
          + {t('llm.models.addManual')}
        </button>
        {defaultContextWindow ? (
          <span className={styles.ctxHint}>
            {t('contextWindowDefaultHint', { n: formatContextWindow(defaultContextWindow) })}
          </span>
        ) : null}
      </div>
    </div>
  )
}
