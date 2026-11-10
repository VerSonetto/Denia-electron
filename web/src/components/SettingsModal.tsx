import { SubagentSettings } from './settings/SubagentSettings'
import { MessagingSettings } from './settings/MessagingSettings'
import { RuntimeSettings } from './settings/RuntimeSettings'
import { MemorySettings } from './settings/MemorySettings'
import { SetmActions, SetmBtn, SetmCard, SetmTiles } from './settings/setm'
import { useCallback, useEffect, useRef, useState } from 'react'
import * as api from '../api'
import { t } from '../i18n'
import { subscribeServerEvents } from '../serverEvents'
import { DropdownField } from './ui/controls'
import { useIsMobile } from '../hooks/useIsMobile'
import type { Notify } from '../App'
import {
  IconArrowLeft,
  IconChevron,
  IconClose,
  IconUpdate,
} from './icons'
import { IconSettingsGeneral, IconSettingsAgents, IconSettingsPresets, IconSettingsPrompt, IconSettingsModels, IconSettingsMemory, IconSettingsChannels, IconSettingsRuntime, IconSettingsAppearance } from './SettingsIcons'
import { LlmPanel } from './llm/LlmPanel'
import { AgentPresetSettings } from './settings/AgentPresetSettings'
import { normalizePermissionChoice, type PermissionChoice } from '../types'
import { defaultPermissionLevels } from './PermissionSelector'
import {
  QUEUE_DEFAULT_ACTIONS,
  normalizeQueueDefaultAction,
  setQueueDefaultAction,
  type QueueDefaultAction,
} from '../features/conversation/queueDefaults'
import {
  CONVERSATION_FOLD_MODES,
  normalizeConversationFoldMode,
  setConversationFoldMode,
  type ConversationFoldMode,
} from '../features/conversation/foldMode'

type SettingsTab =
  | 'runtime'
  | 'subagents'
  | 'general'
  | 'presets'
  | 'prompts'
  | 'models'
  | 'memory'
  | 'channels'
  | 'appearance'

const CONSOLE_NS = 'console'

const TABS: SettingsTab[] = [
  'general',
  'subagents',
  'presets',
  'prompts',
  'models',
  'memory',
  'channels',
  'runtime',
  'appearance',
]

/** 队列处理方式的文案映射;可选项本身来自 QUEUE_DEFAULT_ACTIONS。 */
const QUEUE_LABELS: Record<QueueDefaultAction, Parameters<typeof t>[0]> = {
  ask: 'queueDefaultAsk',
  interject: 'queueModeInterject',
  guide: 'queueModeGuide',
}

/** 折叠方式的文案映射;可选项本身来自 CONVERSATION_FOLD_MODES。 */
const FOLD_LABELS: Record<
  ConversationFoldMode,
  { nameKey: Parameters<typeof t>[0]; hintKey: Parameters<typeof t>[0] }
> = {
  standard: { nameKey: 'conversationFoldStandard', hintKey: 'conversationFoldStandardHint' },
  'tool-group': { nameKey: 'conversationFoldToolGroup', hintKey: 'conversationFoldToolGroupHint' },
  detailed: { nameKey: 'conversationFoldDetailed', hintKey: 'conversationFoldDetailedHint' },
}

function normalizeDefaultPermission(raw: unknown): PermissionChoice {
  const mode = typeof raw === 'string' ? normalizePermissionChoice(raw) : 'auto-edit'
  return mode === 'plan' ? 'auto-edit' : mode
}

/** Summarization threshold as a whole percent; the server stores a ratio. */
function normalizeCompactionPercent(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 && raw <= 1
    ? Math.min(100, Math.max(1, Math.round(raw * 100)))
    : 90
}

function compactionPercentOf(value: unknown): number {
  if (typeof value !== 'object' || value === null) return 90
  return normalizeCompactionPercent((value as Record<string, unknown>).compactRatio)
}

function tabIcon(tab: SettingsTab, size = 16) {
  switch (tab) {
    case 'runtime':
      return <IconSettingsRuntime size={size} />
    case 'subagents':
      return <IconSettingsAgents size={size} />
    case 'general':
      return <IconSettingsGeneral size={size} />
    case 'presets':
      return <IconSettingsPresets size={size} />
    case 'prompts':
      return <IconSettingsPrompt size={size} />
    case 'models':
      return <IconSettingsModels size={size} />
    case 'memory':
      return <IconSettingsMemory size={size} />
    case 'channels':
      return <IconSettingsChannels size={size} />
    case 'appearance':
      return <IconSettingsAppearance size={size} />
  }
}

function tabLabel(tab: SettingsTab): string {
  switch (tab) {
    case 'runtime':
      return t('runtimeSettings')
    case 'subagents':
      return t('subagentsTab')
    case 'general':
      return t('settingsTabGeneral')
    case 'presets':
      return t('settingsTabPresets')
    case 'prompts':
      return t('settingsTabPrompts')
    case 'models':
      return t('settingsTabModels')
    case 'memory':
      return t('memoryTab')
    case 'channels':
      return t('channelsTab')
    case 'appearance':
      return t('settingsTabAppearance')
  }
}

function tabNavDesc(tab: SettingsTab): string {
  switch (tab) {
    case 'runtime':
      return t('runtimeSettingsHint')
    case 'subagents':
      return t('subagentsTabDesc')
    case 'general':
      return t('settingsTabGeneralDesc')
    case 'presets':
      return t('settingsTabPresetsDesc')
    case 'prompts':
      return t('settingsTabPromptsDesc')
    case 'models':
      return t('settingsTabModelsDesc')
    case 'memory':
      return t('memoryTabDesc')
    case 'channels':
      return t('channelsTabDesc')
    case 'appearance':
      return t('settingsTabAppearanceDesc')
  }
}

function paneTitle(tab: SettingsTab): string {
  switch (tab) {
    case 'runtime':
      return t('runtimeSettings')
    case 'subagents':
      return t('subagentsPaneTitle')
    case 'general':
      return t('settingsPaneGeneralTitle')
    case 'presets':
      return t('settingsPanePresetsTitle')
    case 'prompts':
      return t('settingsPanePromptsTitle')
    case 'models':
      return t('settingsPaneModelsTitle')
    case 'memory':
      return t('memoryPaneTitle')
    case 'channels':
      return t('channelsPaneTitle')
    case 'appearance':
      return t('catAppearance')
  }
}

function paneDesc(tab: SettingsTab): string {
  switch (tab) {
    case 'runtime':
      return t('runtimeSettingsHint')
    case 'subagents':
      return t('subagentsPaneDesc')
    case 'general':
      return t('settingsPaneGeneralDesc')
    case 'presets':
      return t('settingsPanePresetsDesc')
    case 'prompts':
      return t('settingsPanePromptsDesc')
    case 'models':
      return t('settingsPaneModelsDesc')
    case 'memory':
      return t('memoryPaneDesc')
    case 'channels':
      return t('channelsPaneDesc')
    case 'appearance':
      return t('settingsAppearanceHint')
  }
}


export function SettingsModal({ notify, onClose, onOpenVersion }: { notify: Notify; onClose: () => void; onOpenVersion: () => void }) {
  const [tab, setTab] = useState<SettingsTab>('general')
  const [loading, setLoading] = useState(true)
  /** 是否已完成过首拉:决定重拉时要不要重新亮骨架屏。 */
  const loadedOnceRef = useRef(false)
  const [saving, setSaving] = useState(false)
  // 窄屏:标签栏与面板是两屏,先选分类再进面板(横向滚动条里塞 9 个
  // 148px 的标签,手机上既看不全也点不准)。
  const isMobile = useIsMobile()
  const [mobilePaneOpen, setMobilePaneOpen] = useState(false)

  const [theme, setTheme] = useState('system')
  const [locale, setLocaleState] = useState('zh')
  const [defaultPermission, setDefaultPermission] = useState<PermissionChoice>('auto-edit')
  const [showApproveForMe, setShowApproveForMe] = useState(false)
  const [queueDefaultAction, setQueueDefaultActionState] = useState<QueueDefaultAction>('ask')
  const [conversationFoldMode, setConversationFoldModeState] =
    useState<ConversationFoldMode>('standard')
  const [compactionPercent, setCompactionPercent] = useState('90')
  const [savedCompactionPercent, setSavedCompactionPercent] = useState('90')
  const [consoleValue, setConsoleValue] = useState<Record<string, unknown>>({})
  const [consoleRevision, setConsoleRevision] = useState(0)
  const [promptText, setPromptText] = useState('')
  const [promptSource, setPromptSource] = useState<'file' | 'default'>('default')
  const [rulesText, setRulesText] = useState('')
  const [rulesSource, setRulesSource] = useState<'file' | 'default'>('default')
  const [rulesPath, setRulesPath] = useState('')
  // 卡片默认折叠:pane 只留标题行 + 状态,展开才占面积。
  const [openCard, setOpenCard] = useState<string | null>(null)
  const toggleCard = (id: string) => setOpenCard((current) => (current === id ? null : id))

  const load = useCallback(async () => {
    // 骨架屏只在首拉出现。设置变更后的自动重拉(SSE settings-updated)不能
    // 把整个面板连子弹窗一起卸载 —— 模型面板改成自动保存后,保存就发生在
    // 弹窗开着的中途,一旦卸载用户正在填的表单就没了。
    if (!loadedOnceRef.current) setLoading(true)
    try {
      const [nextDescribe, nextPrompt, nextRules, permissionCatalog] = await Promise.all([
        api.getSettings(),
        api.getSystemPrompt(),
        api.getGlobalRules(),
        api.permissionCatalog(),
      ])
      const supportsApproveForMe = Boolean(
        permissionCatalog?.modes.includes('approve-for-me'),
      )
      setShowApproveForMe(supportsApproveForMe)
      setPromptText(nextPrompt.text)
      setPromptSource(nextPrompt.source)
      setRulesText(nextRules.text)
      setRulesSource(nextRules.source)
      setRulesPath(nextRules.displayPath)

      const console = nextDescribe.namespaces.find((n) => n.ns === CONSOLE_NS)
      if (console) {
        setConsoleValue(console.value)
        setTheme((console.value.theme as string) ?? 'system')
        setLocaleState((console.value.locale as string) ?? 'zh')
        const storedPermission = normalizeDefaultPermission(
          console.value.defaultPermissionMode,
        )
        setDefaultPermission(
          storedPermission === 'approve-for-me' && !supportsApproveForMe
            ? 'auto-edit'
            : storedPermission,
        )
        setQueueDefaultActionState(
          normalizeQueueDefaultAction(console.value.queueDefaultAction),
        )
        setConversationFoldModeState(
          normalizeConversationFoldMode(console.value.conversationFoldMode),
        )
        const percent = String(compactionPercentOf(console.value.compaction))
        setCompactionPercent(percent)
        setSavedCompactionPercent(percent)
        setConsoleRevision(console.revision)
      }

    } catch (error) {
      notify('err', error instanceof Error ? error.message : String(error))
    } finally {
      loadedOnceRef.current = true
      setLoading(false)
    }
  }, [notify])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    return subscribeServerEvents((type) => {
      if (type === 'settings-updated') void load()
    })
  }, [load])

  // 弹窗期间锁定 body 滚动并补偿滚动条宽度:遮罩下不再出现滚动条抖动。
  useEffect(() => {
    const body = document.body
    const scrollbar = window.innerWidth - document.documentElement.clientWidth
    const prevOverflow = body.style.overflow
    const prevPadding = body.style.paddingRight
    body.style.overflow = 'hidden'
    if (scrollbar > 0) body.style.paddingRight = `${scrollbar}px`
    return () => {
      body.style.overflow = prevOverflow
      body.style.paddingRight = prevPadding
    }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // 内层抽屉/确认框已 preventDefault 的 Esc 不连弹窗一起关。
      if (event.key === 'Escape' && !event.defaultPrevented) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const saveConsole = async () => {
    setSaving(true)
    try {
      const view = await api.replaceNamespace(
        CONSOLE_NS,
        { ...consoleValue, theme, locale },
        consoleRevision,
      )
      setConsoleRevision((view as { revision: number }).revision)
      notify('ok', t('settingsSaved'))
    } catch (error) {
      notify('err', error instanceof Error ? error.message : String(error))
      void load()
    } finally {
      setSaving(false)
    }
  }

  /** 通用设置项:整份 console 命名空间替换,写成功后才更新本地快照。 */
  const saveGeneral = async (
    patch: Record<string, unknown>,
    message: string,
  ): Promise<boolean> => {
    setSaving(true)
    try {
      const next = {
        ...consoleValue,
        defaultPermissionMode: defaultPermission,
        queueDefaultAction,
        conversationFoldMode,
        ...patch,
      }
      const view = await api.replaceNamespace(CONSOLE_NS, next, consoleRevision)
      setConsoleRevision((view as { revision: number }).revision)
      setConsoleValue(next)
      notify('ok', message)
      return true
    } catch (error) {
      notify('err', error instanceof Error ? error.message : String(error))
      void load()
      return false
    } finally {
      setSaving(false)
    }
  }

  /** 权限档位:选中即保存。新草稿态在下次拉设置时自动跟随这个值。 */
  const changeDefaultPermission = (next: PermissionChoice): void => {
    setDefaultPermission(next)
    void saveGeneral({ defaultPermissionMode: next }, t('defaultPermissionSaved'))
  }

  /** 队列消息默认处理:选中即保存,并同步发送路径的前端缓存。 */
  const changeQueueDefaultAction = (next: QueueDefaultAction): void => {
    setQueueDefaultActionState(next)
    setQueueDefaultAction(next)
    void saveGeneral({ queueDefaultAction: next }, t('queueDefaultSaved'))
  }

  /** 工作步骤展示:选中即保存,并同步对话流的本地缓存。 */
  const changeConversationFoldMode = (next: ConversationFoldMode): void => {
    setConversationFoldModeState(next)
    setConversationFoldMode(next)
    void saveGeneral({ conversationFoldMode: next }, t('conversationFoldSaved'))
  }

  /** 上下文压缩阈值:校验后写 console.compaction.compactRatio,下一轮生效。 */
  const saveCompactionThreshold = async (): Promise<void> => {
    const percent = Number(compactionPercent)
    if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
      notify('err', t('compactionThresholdInvalid'))
      return
    }
    const current =
      typeof consoleValue.compaction === 'object' && consoleValue.compaction !== null
        ? (consoleValue.compaction as Record<string, unknown>)
        : {}
    const saved = await saveGeneral(
      { compaction: { ...current, compactRatio: percent / 100 } },
      t('compactionThresholdSaved'),
    )
    if (saved) {
      setCompactionPercent(String(percent))
      setSavedCompactionPercent(String(percent))
    }
  }

  const savePrompt = async () => {
    setSaving(true)
    try {
      const view = await api.saveSystemPrompt(promptText)
      setPromptText(view.text)
      setPromptSource(view.source)
      notify('ok', t('settingsSaved'))
    } catch (error) {
      notify('err', error instanceof Error ? error.message : String(error))
      void load()
    } finally {
      setSaving(false)
    }
  }

  const resetPrompt = async () => {
    setSaving(true)
    try {
      await api.resetSystemPrompt()
      setPromptText('')
      setPromptSource('default')
      notify('ok', t('systemPromptResetDone'))
    } catch (error) {
      notify('err', error instanceof Error ? error.message : String(error))
      void load()
    } finally {
      setSaving(false)
    }
  }

  /** 全局规则:空正文 = 删除文件回到"未设置"(后端幂等)。 */
  const saveRules = async () => {
    setSaving(true)
    try {
      const view = await api.saveGlobalRules(rulesText)
      setRulesText(view.text)
      setRulesSource(view.source)
      setRulesPath(view.displayPath)
      notify('ok', rulesText.trim() ? t('globalRulesSaved') : t('globalRulesCleared'))
    } catch (error) {
      notify('err', error instanceof Error ? error.message : String(error))
      void load()
    } finally {
      setSaving(false)
    }
  }

  const clearRules = async () => {
    setSaving(true)
    try {
      const view = await api.saveGlobalRules('')
      setRulesText('')
      setRulesSource('default')
      setRulesPath(view.displayPath)
      notify('ok', t('globalRulesCleared'))
    } catch (error) {
      notify('err', error instanceof Error ? error.message : String(error))
      void load()
    } finally {
      setSaving(false)
    }
  }

  const permissionOptions = defaultPermissionLevels(showApproveForMe).map((entry) => ({
    id: entry.level,
    label: t(entry.nameKey),
    hint: t(entry.descKey),
  }))
  const queueOptions = QUEUE_DEFAULT_ACTIONS.map((id) => ({
    id,
    label: t(QUEUE_LABELS[id]),
  }))
  const foldOptions = CONVERSATION_FOLD_MODES.map((id) => ({
    id,
    label: t(FOLD_LABELS[id].nameKey),
    hint: t(FOLD_LABELS[id].hintKey),
  }))

  return (
    <div
      className="setm-backdrop"
      // 遮罩单击不关窗(容易误触),双击才关;点在壳内不算外部点击。
      onDoubleClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="setm-shell"
        role="dialog"
        aria-modal="true"
        aria-label={t('settingsModalTitle')}
        data-mobile={isMobile || undefined}
        data-pane={isMobile && mobilePaneOpen ? 'open' : undefined}
      >
        <aside className="setm-rail">
          <div className="setm-rail-head">
            <span className="setm-rail-kicker">Denia</span>
            <h2>{t('settingsModalTitle')}</h2>
            <p>{t('settingsModalSubtitle')}</p>
          </div>
          {/* 窄屏分类列表这一屏没有面板头部,关闭按钮必须单独给一个 ——
              否则用户进来后找不到出口(只能靠 Esc,手机上不可用)。 */}
          {isMobile && (
            <button
              type="button"
              className="setm-rail-close"
              onClick={onClose}
              aria-label={t('close')}
            >
              <IconClose size={18} />
            </button>
          )}

          <nav className="setm-rail-nav" aria-label={t('settingsModalTitle')}>
            {TABS.map((item) => (
              <button
                key={item}
                type="button"
                className={`setm-nav-item${tab === item ? ' active' : ''}`}
                aria-current={tab === item ? 'page' : undefined}
                onClick={() => {
                  setTab(item)
                  // 窄屏:选中分类即进入该面板。
                  if (isMobile) setMobilePaneOpen(true)
                }}
              >
                <span className="setm-nav-icon">{tabIcon(item)}</span>
                <span className="setm-nav-copy">
                  <span className="setm-nav-label">{tabLabel(item)}</span>
                  <span className="setm-nav-desc">{tabNavDesc(item)}</span>
                </span>
                {isMobile && (
                  <span className="setm-nav-chev" aria-hidden="true">
                    <IconChevron size={14} />
                  </span>
                )}
              </button>
            ))}
            <button type="button" className="setm-nav-item" onClick={onOpenVersion}>
              <span className="setm-nav-icon"><IconUpdate size={16} /></span>
              <span className="setm-nav-copy">
                <span className="setm-nav-label">{t('versionPageTitle')}</span>
                <span className="setm-nav-desc">{t('versionPageDesc')}</span>
              </span>
              {isMobile && <span className="setm-nav-chev" aria-hidden="true"><IconChevron size={14} /></span>}
            </button>
          </nav>

        </aside>

        <main className="setm-panel">
          <header className="setm-panel-head">
            {isMobile && (
              <button
                type="button"
                className="setm-panel-back"
                onClick={() => setMobilePaneOpen(false)}
                aria-label={t('settingsBackToTabs')}
              >
                <IconArrowLeft size={18} />
              </button>
            )}
            <div>
              <h3>{paneTitle(tab)}</h3>
              <p>{paneDesc(tab)}</p>
            </div>
            <button type="button" className="setm-panel-close" onClick={onClose} aria-label={t('close')}>
              <IconClose size={18} />
            </button>
          </header>

          <div className="setm-panel-body">
            {loading ? (
              <div className="setm-loading">
                <span className="setm-loading-dot" />
                <p>{t('loading')}</p>
              </div>
            ) : (
              <>
                {tab === 'runtime' && <RuntimeSettings />}
                {tab === 'subagents' && <SubagentSettings notify={notify} />}
                {tab === 'general' && (
                  <div className="setm-general">
                    <div className="setm-general-row">
                      <div className="setm-general-copy">
                        <div className="setm-general-title">{t('defaultPermissionTitle')}</div>
                        <p className="setm-general-hint">{t('defaultPermissionHint')}</p>
                      </div>
                      <div className="setm-general-control">
                        <DropdownField
                          label=""
                          value={defaultPermission}
                          options={permissionOptions}
                          onChange={changeDefaultPermission}
                          disabled={saving}
                        />
                      </div>
                    </div>

                    <div className="setm-general-row">
                      <div className="setm-general-copy">
                        <div className="setm-general-title">{t('queueDefaultActionTitle')}</div>
                        <p className="setm-general-hint">{t('queueDefaultActionHint')}</p>
                      </div>
                      <div className="setm-general-control">
                        <DropdownField
                          label=""
                          value={queueDefaultAction}
                          options={queueOptions}
                          onChange={changeQueueDefaultAction}
                          disabled={saving}
                        />
                      </div>
                    </div>

                    <div className="setm-general-row">
                      <div className="setm-general-copy">
                        <div className="setm-general-title">{t('conversationFoldTitle')}</div>
                        <p className="setm-general-hint">
                          {t(FOLD_LABELS[conversationFoldMode].hintKey)}
                        </p>
                      </div>
                      <div className="setm-general-control">
                        <DropdownField
                          label=""
                          value={conversationFoldMode}
                          options={foldOptions}
                          onChange={changeConversationFoldMode}
                          disabled={saving}
                        />
                      </div>
                    </div>

                    <div className="setm-general-row">
                      <div className="setm-general-copy">
                        <div className="setm-general-title">{t('compactionThresholdTitle')}</div>
                        <p className="setm-general-hint">{t('compactionThresholdHint')}</p>
                      </div>
                      <div className="setm-general-control setm-general-threshold">
                        <input
                          className="setm-input mono"
                          type="text"
                          inputMode="numeric"
                          value={compactionPercent}
                          aria-label={t('compactionThresholdLabel')}
                          onChange={(event) => setCompactionPercent(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') void saveCompactionThreshold()
                          }}
                        />
                        <span className="setm-general-unit">%</span>
                        <SetmBtn
                          small
                          disabled={saving || compactionPercent === savedCompactionPercent}
                          onClick={() => void saveCompactionThreshold()}
                        >
                          {t('save')}
                        </SetmBtn>
                      </div>
                    </div>
                  </div>
                )}

                {tab === 'prompts' && (
                  <div className="setm-cards">
                    <SetmCard
                      title={t('systemPromptTitle')}
                      hint={t('systemPromptHint')}
                      summary={promptSource === 'file' ? t('customized') : t('factoryDefault')}
                      open={openCard === 'prompt'}
                      onToggle={() => toggleCard('prompt')}
                    >
                      {promptSource === 'default' && !promptText && (
                        <p className="setm-callout">{t('systemPromptEmptyHint')}</p>
                      )}
                      <div className="setm-prompt-shell">
                        <textarea
                          className="setm-textarea"
                          rows={14}
                          value={promptText}
                          onChange={(event) => setPromptText(event.target.value)}
                          spellCheck={false}
                          placeholder={t('systemPromptPlaceholder')}
                        />
                      </div>
                      <SetmActions>
                        <SetmBtn disabled={saving} onClick={() => void savePrompt()}>
                          {t('systemPromptSave')}
                        </SetmBtn>
                        <SetmBtn
                          variant="ghost"
                          disabled={saving}
                          onClick={() => void resetPrompt()}
                        >
                          {t('systemPromptReset')}
                        </SetmBtn>
                      </SetmActions>
                    </SetmCard>

                    <SetmCard
                      title={t('globalRulesTitle')}
                      hint={t('globalRulesHint')}
                      summary={rulesSource === 'file' ? t('customized') : t('notSet')}
                      open={openCard === 'rules'}
                      onToggle={() => toggleCard('rules')}
                    >
                      <p className="setm-card-meta">
                        <span>{t('globalRulesPathLabel')}</span>
                        <code>{rulesPath || '~/AGENTS.md'}</code>
                      </p>
                      {rulesSource === 'default' && !rulesText && (
                        <p className="setm-callout">{t('globalRulesEmptyHint')}</p>
                      )}
                      <div className="setm-prompt-shell">
                        <textarea
                          className="setm-textarea"
                          rows={10}
                          value={rulesText}
                          onChange={(event) => setRulesText(event.target.value)}
                          spellCheck={false}
                          placeholder={t('globalRulesPlaceholder')}
                        />
                      </div>
                      <SetmActions>
                        <SetmBtn disabled={saving} onClick={() => void saveRules()}>
                          {t('globalRulesSave')}
                        </SetmBtn>
                        <SetmBtn variant="ghost" disabled={saving} onClick={() => void clearRules()}>
                          {t('globalRulesClear')}
                        </SetmBtn>
                      </SetmActions>
                    </SetmCard>
                  </div>
                )}

                {tab === 'presets' && <AgentPresetSettings notify={notify} />}
                {tab === 'models' && <LlmPanel notify={notify} />}


                {tab === 'memory' && <MemorySettings />}

                {tab === 'channels' && <MessagingSettings notify={notify} />}

                {tab === 'appearance' && (
                  <section className="setm-section">
                    <div className="setm-field-block">
                      <div className="setm-field-label">{t('themeLabel')}</div>
                      <SetmTiles
                        value={theme}
                        options={[
                          { id: 'system', label: t('themeSystem') },
                          { id: 'light', label: t('themeLight') },
                          { id: 'dark', label: t('themeDark') },
                        ]}
                        onChange={setTheme}
                      />
                    </div>
                    <div className="setm-field-block">
                      <div className="setm-field-label">{t('languageLabel')}</div>
                      <SetmTiles
                        value={locale}
                        options={[
                          { id: 'zh', label: '中文' },
                          { id: 'en', label: 'English' },
                        ]}
                        onChange={setLocaleState}
                      />
                    </div>
                    <SetmActions>
                      <SetmBtn disabled={saving} onClick={() => void saveConsole()}>
                        {t('save')}
                      </SetmBtn>
                    </SetmActions>
                  </section>
                )}
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  )
}
