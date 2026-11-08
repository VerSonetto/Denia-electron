import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AgentAvatar, AVATARS, getAgentAvatar, saveAgentAvatar, useAgentAvatar, type AvatarId } from '../AgentAvatar'
import * as api from '../../api'
import { subscribeServerEvents } from '../../serverEvents'
import { t } from '../../i18n'
import type { Notify } from '../../App'
import type {
  ModelCatalog,
  ModelSelection,
  ProfileSource,
  ProfileWriteScope,
  SubagentCatalogView,
  SubagentPreview,
  SubagentProfile,
  SubagentProfileView,
  SubagentToolRow,
  SubagentToolsView,
  ToolSelection,
} from '../../types'
import { ChipRadio, Field, NumberInput, TextInput } from '../llm/atoms/form'
import { DropdownField, type SelectOption } from '../ui/controls'
import { SetmActions, SetmBtn, SetmCard } from './setm'
import {
  allowlistOf,
  blankProfile,
  cloneProfile,
  conflictKeepsDraft,
  copyProfile,
  draftAfterSave,
  readOnlyConflicts,
  rowIsDisabled,
  toggleToolName,
  toolSelectionSummary,
  unknownToolNames,
} from './subagentDraft'
import styles from './SubagentSettings.module.css'

const POLICY_NS = 'subagent-policy'
const SOURCE_LABELS: Record<ProfileSource, string> = {
  builtin: 'subagentsSourceBuiltin',
  user: 'subagentsSourceUser',
  project: 'subagentsSourceProject',
}
const SOURCE_ORDER: ProfileSource[] = ['project', 'user', 'builtin']
const EDITOR_TABS = ['basics', 'role', 'tools', 'model'] as const
type EditorTab = (typeof EDITOR_TABS)[number]
type SourceFilter = ProfileSource | 'all'
type TranslateKey = Parameters<typeof t>[0]

interface Draft {
  kind: 'create' | 'edit' | 'copy'
  target?: string
  writeScope: ProfileWriteScope
  revision: number
  profile: SubagentProfile
  dirty: boolean
  avatar: AvatarId
}

function modelSummary(profile: SubagentProfile): string {
  return profile.model.mode === 'inherit'
    ? t('subagentsModelInheritShort')
    : `${profile.model.selection.provider}/${profile.model.selection.model}`
}

export function SubagentSettings({ notify }: { notify: Notify }) {
  const [workspaces, setWorkspaces] = useState<{ id: string; title: string; path: string }[]>([])
  const [workspaceId, setWorkspaceId] = useState('')
  const [catalog, setCatalog] = useState<SubagentCatalogView | null>(null)
  const [models, setModels] = useState<ModelCatalog | null>(null)
  const [tools, setTools] = useState<SubagentToolsView | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [preview, setPreview] = useState<SubagentPreview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [actionId, setActionId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  const [policy, setPolicy] = useState<number | null>(null)
  const [catalogBudget, setCatalogBudget] = useState<number | null>(null)
  const [policyRevision, setPolicyRevision] = useState(0)
  const [policySaved, setPolicySaved] = useState(false)
  const [policyOpen, setPolicyOpen] = useState(false)
  const editorRef = useRef<HTMLElement | null>(null)

  const cwd = workspaces.find((entry) => entry.id === workspaceId)?.path ?? ''
  const scope = cwd ? { cwd } : {}
  const requestIdRef = useRef(0)

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current
    const requestedScope = cwd ? { cwd } : {}
    setLoading(true)
    setError('')
    try {
      const [profileView, toolView, settings, workspaceList, modelCatalog] = await Promise.all([
        api.listSubagentProfiles(requestedScope),
        api.listSubagentTools(requestedScope),
        api.getSettings(),
        api.listWorkspaces(),
        api.getCatalog().catch(() => null),
      ])
      if (requestId !== requestIdRef.current) return
      setCatalog(profileView)
      setTools(toolView)
      setModels(modelCatalog)
      const rows = workspaceList.workspaces.map((entry) => ({
        id: entry.id,
        title: entry.title,
        path: entry.path,
      }))
      setWorkspaces(rows)
      setWorkspaceId((current) => (current && rows.some((row) => row.id === current) ? current : ''))
      setSelectedId((current) => {
        const all = [...profileView.effective, ...profileView.shadowed]
        return current && all.some((view) => view.qualifiedId === current)
          ? current
          : profileView.effective.find((view) => view.source === 'builtin')?.qualifiedId ??
              profileView.effective[0]?.qualifiedId ?? profileView.shadowed[0]?.qualifiedId ?? null
      })
      const ns = settings.namespaces.find((entry) => entry.ns === POLICY_NS)
      if (ns) {
        setPolicy(typeof ns.value.maxConcurrentRuns === 'number' ? ns.value.maxConcurrentRuns : 8)
        setPolicyRevision(ns.revision)
      }
      const runtimeNs = settings.namespaces.find((entry) => entry.ns === 'runtime')
      const budget = runtimeNs?.value?.subagentCatalogMaxBytes
      setCatalogBudget(typeof budget === 'number' ? budget : null)
    } catch (reason) {
      if (requestId !== requestIdRef.current) return
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (requestId === requestIdRef.current) setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(
    () =>
      subscribeServerEvents((type) => {
        if (type === 'subagents-updated' && !draft?.dirty) void load()
      }),
    [load, draft?.dirty],
  )

  useEffect(() => {
    if (draft && window.matchMedia('(max-width: 779px)').matches) {
      editorRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    }
  }, [draft?.kind, draft?.target])

  const discardDraft = () => !draft?.dirty || window.confirm(t('subagentsDiscardConfirm'))
  const requestProfileChange = (change: () => void) => {
    if (!discardDraft()) return
    setDraft(null)
    setPreview(null)
    setError('')
    change()
  }
  const closeEditor = () => {
    if (!discardDraft()) return
    setDraft(null)
    setPreview(null)
    setError('')
  }
  const selectProfile = (view: SubagentProfileView) => {
    if (view.qualifiedId === selectedId && !draft) return
    requestProfileChange(() => setSelectedId(view.qualifiedId))
  }
  const startCreate = () => {
    requestProfileChange(() => {
      const profile = blankProfile()
      setDraft({
        kind: 'create',
        writeScope: cwd && catalog?.projectDir ? 'project' : 'user',
        revision: 0,
        profile,
        dirty: true,
        avatar: getAgentAvatar(`user:${profile.id}`, cwd),
      })
    })
  }
  const startEdit = (view: SubagentProfileView, kind: 'edit' | 'copy') => {
    requestProfileChange(() => {
      const profile = kind === 'copy' ? copyProfile(view) : cloneProfile(view)
      setSelectedId(view.qualifiedId)
      setDraft({
        kind,
        target: kind === 'edit' ? view.qualifiedId : undefined,
        writeScope: kind === 'edit' && view.source === 'project' ? 'project' : 'user',
        revision: view.revision,
        profile,
        dirty: kind !== 'edit',
        avatar: getAgentAvatar(view.qualifiedId, cwd),
      })
    })
  }

  const save = async () => {
    if (!draft) return
    const conflicts = readOnlyConflicts(
      draft.profile.permissionCeiling,
      allowlistOf(draft.profile) ?? [],
      tools?.tools ?? [],
    )
    if (conflicts.length > 0) {
      setError(`${t('subagentsReadOnlyConflict')}：${conflicts.join('、')}。${t('subagentsReadOnlyConflictHint')}`)
      return
    }
    setSaving(true)
    setError('')
    try {
      const result = draft.kind === 'edit' && draft.target
        ? await api.updateSubagentProfile(draft.target, {
            profile: draft.profile,
            expectedRevision: draft.revision,
            ...scope,
          })
        : await api.createSubagentProfile({
            scope: draft.writeScope,
            profile: draft.profile,
            ...scope,
          })
      saveAgentAvatar(result.profile.qualifiedId, cwd, draft.avatar)
      setDraft({
        kind: 'edit',
        dirty: false,
        avatar: draft.avatar,
        ...draftAfterSave(draft.writeScope, result.profile),
      })
      setSelectedId(result.profile.qualifiedId)
      notify('ok', t(draft.kind === 'edit' ? 'subagentsSaved' : 'subagentsCreated'))
      await load()
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      const status = reason instanceof api.ApiError ? reason.status : 0
      const { conflict } = conflictKeepsDraft(draft, status)
      setError(conflict ? `${t('subagentsConflict')}（${message}）` : message)
      notify('err', message)
    } finally {
      setSaving(false)
    }
  }

  const runAction = async (
    view: SubagentProfileView,
    action: 'toggle' | 'delete' | 'reset',
  ) => {
    if (action === 'delete' && !window.confirm(t('subagentsDeleteConfirm').replace('{name}', view.profile.name))) return
    if (action === 'reset' && !window.confirm(t('subagentsResetConfirm').replace('{name}', view.profile.name))) return
    setSaving(true)
    setActionId(view.qualifiedId)
    setError('')
    try {
      if (action === 'toggle') {
        await api.updateSubagentProfile(view.qualifiedId, {
          profile: { ...view.profile, enabled: !view.profile.enabled },
          expectedRevision: view.revision,
          ...scope,
        })
      } else if (action === 'reset') {
        await api.resetSubagentProfile(view.qualifiedId, {
          scope: view.source === 'project' ? 'project' : 'user',
          ...scope,
        })
      } else {
        await api.deleteSubagentProfile(view.qualifiedId, {
          scope: view.source === 'project' ? 'project' : 'user',
          expectedRevision: view.revision,
          ...scope,
        })
      }
      notify('ok', t(action === 'delete' ? 'subagentsDeleted' : 'subagentsSaved'))
      if (draft?.target === view.qualifiedId) setDraft(null)
      setPreview(null)
      await load()
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      setError(message)
      notify('err', message)
    } finally {
      setSaving(false)
      setActionId(null)
    }
  }

  const showPreview = async (request: () => Promise<SubagentPreview>) => {
    setPreviewing(true)
    setError('')
    try {
      setPreview(await request())
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      setError(message)
      notify('err', message)
    } finally {
      setPreviewing(false)
    }
  }

  const refreshPreview = async () => {
    if (!draft) return
    if (draft.kind === 'edit' && draft.target) {
      await showPreview(() => api.previewSubagentProfile({ profileId: draft.target, ...scope }))
      return
    }
    const { profile } = draft
    await showPreview(() =>
      api.previewSubagentProfile({
        inline: {
          name: profile.name || 'inline',
          description: profile.description || 'inline',
          instructions: profile.instructions,
          tools: profile.tools,
          model: profile.model,
          permissionCeiling: profile.permissionCeiling,
        },
        ...scope,
      }),
    )
  }

  const savePolicy = async () => {
    if (policy === null) return
    setSaving(true)
    setError('')
    try {
      await api.replaceNamespace(POLICY_NS, { maxConcurrentRuns: policy }, policyRevision)
      const settings = await api.getSettings()
      const ns = settings.namespaces.find((entry) => entry.ns === POLICY_NS)
      if (ns) setPolicyRevision(ns.revision)
      else setPolicyRevision(0)
      setPolicySaved(true)
      notify('ok', t('runtimeSaved'))
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      setError(message)
      notify('err', message)
    } finally {
      setSaving(false)
    }
  }

  const rows = useMemo(() => {
    const all = [...(catalog?.effective ?? []), ...(catalog?.shadowed ?? [])]
    const needle = search.trim().toLowerCase()
    return all.filter((view) => {
      if (sourceFilter !== 'all' && view.source !== sourceFilter) return false
      return !needle || [view.profile.id, view.profile.name, view.profile.description]
        .join(' ')
        .toLowerCase()
        .includes(needle)
    })
  }, [catalog, search, sourceFilter])

  const grouped = useMemo(() => {
    const map = new Map<ProfileSource, SubagentProfileView[]>()
    for (const source of SOURCE_ORDER) map.set(source, [])
    for (const view of rows) map.get(view.source)?.push(view)
    return map
  }, [rows])

  const workspaceOptions = useMemo<SelectOption<string>[]>(
    () => [
      { id: '', label: t('subagentsScopeUser'), hint: t('subagentsSessionHint') },
      ...workspaces.map((entry) => ({
        id: entry.id,
        label: (entry.title || entry.path).split(/[\\/]/).filter(Boolean).pop() ?? entry.path,
        hint: entry.path,
      })),
    ],
    [workspaces],
  )

  const update = (patch: Partial<SubagentProfile>) => {
    setDraft((current) =>
      current ? { ...current, profile: { ...current.profile, ...patch }, dirty: true } : current,
    )
  }

  const effective = catalog?.effective ?? []
  const shadowedIds = new Set((catalog?.shadowed ?? []).map((view) => view.qualifiedId))
  const diagnostics = catalog?.diagnostics ?? []
  const selected = rows.find((view) => view.qualifiedId === selectedId) ?? null
  const enabledCount = effective.filter((view) => view.profile.enabled).length
  const busy = saving || loading

  return (
    <section className={`setm-section ${styles.page}`} data-testid="subagent-settings">
      <header className={styles.pageHead}>
        <div className={styles.pageCopy}>
          <h4>{t('subagentsPaneTitle')}</h4>
          <p>{t('subagentsInheritNote')} {t('subagentsNoDispatchNote')}</p>
        </div>
        <SetmBtn disabled={saving || loading} onClick={startCreate}>
          {t('subagentsNew')}
        </SetmBtn>
      </header>

      <div className={styles.scopeBar}>
        <DropdownField
          label={t('subagentsSessionLabel')}
          value={workspaceId}
          options={workspaceOptions}
          disabled={saving}
          onChange={(next) => {
            if (next === workspaceId) return
            requestProfileChange(() => {
              setWorkspaceId(next)
              setSelectedId(null)
              setCatalog(null)
            })
          }}
        />
        <p className={styles.scopeSummary}>
          {t('subagentsEffective')} {effective.length} · {t('subagentsEnabled')} {enabledCount}
        </p>
      </div>

      <SetmCard
        title={t('subagentsScheduleTitle')}
        hint={t('subagentsScheduleHint')}
        summary={policy === null ? undefined : String(policy)}
        open={policyOpen}
        onToggle={() => setPolicyOpen((open) => !open)}
      >
        <div className="setm-field-block">
          <div className="setm-field-label">{t('subagentsMaxConcurrentRuns')}</div>
          <NumberInput value={policy ?? undefined} onChange={(next) => { setPolicySaved(false); setPolicy(next ?? null) }} />
        </div>
        {catalogBudget !== null && (
          <p className="setm-callout">
            {t('subagentsCatalogBudget')}：{catalogBudget}（runtime.subagentCatalogMaxBytes，改 YAML 生效；超限按 UTF-8 边界截断并明示）
          </p>
        )}
        <SetmActions>
          <SetmBtn disabled={saving || policy === null} onClick={() => void savePolicy()}>{t('subagentsSave')}</SetmBtn>
          {policySaved && <span className={styles.saved} role="status">{t('runtimeSaved')}</span>}
        </SetmActions>
      </SetmCard>

      {error && <div className={styles.error} role="alert">{error}</div>}

      <div className={`${styles.workbench}${draft ? ` ${styles.workbenchEditing}` : ''}`}>
        <aside className={styles.browser} aria-label={t('subagentsDefinitions')}>
          <div className={styles.browserHead}>
            <div className={styles.browserTitleRow}>
              <h5>{t('subagentsDefinitions')}</h5>
              <span>{rows.length}</span>
            </div>
            <Field label={t('subagentsSearch')} error={null}>
              <TextInput value={search} onChange={setSearch} placeholder={t('subagentsSearch')} />
            </Field>
            <DropdownField
              label={t('subagentsSourceFilter')}
              value={sourceFilter}
              options={[
                { id: 'all', label: t('subagentsAllSources') },
                ...SOURCE_ORDER.map((source) => ({ id: source, label: t(SOURCE_LABELS[source] as TranslateKey) })),
              ]}
              onChange={(value) => setSourceFilter(value as SourceFilter)}
            />
          </div>
          <div className={styles.profileList} aria-busy={loading}>
            {loading && !catalog ? (
              <p className="setm-empty">{t('loading')}</p>
            ) : rows.length === 0 ? (
              <div className={styles.emptyList}>
                <p>{effective.length === 0 ? t('subagentsEmpty') : t('subagentsNoMatches')}</p>
                {effective.length === 0 && <SetmBtn small onClick={startCreate}>{t('subagentsNew')}</SetmBtn>}
              </div>
            ) : SOURCE_ORDER.map((source) => {
              const sourceRows = grouped.get(source) ?? []
              if (sourceRows.length === 0) return null
              return (
                <div key={source} className={styles.sourceGroup}>
                  <h6>{t(SOURCE_LABELS[source] as TranslateKey)}</h6>
                  {sourceRows.map((view) => (
                    <ProfileListItem
                      key={view.qualifiedId}
                      view={view}
                      cwd={cwd}
                      models={models}
                      selected={selectedId === view.qualifiedId}
                      editing={draft?.target === view.qualifiedId}
                      shadowed={shadowedIds.has(view.qualifiedId)}
                      disabled={busy}
                      onSelect={() => selectProfile(view)}
                    />
                  ))}
                </div>
              )
            })}
          </div>
          {diagnostics.length > 0 && (
            <details className={styles.diagnostics}>
              <summary>{t('subagentsDiagnostics')} ({diagnostics.length})</summary>
              <ul>{diagnostics.map((issue, index) => <li key={`${issue.code}-${index}`}><code>{issue.code}</code> {issue.message}</li>)}</ul>
            </details>
          )}
        </aside>

        <div className={styles.detail}>
          {draft ? (
            <DraftEditor
              ref={editorRef}
              draft={draft}
              tools={tools}
              models={models}
              preview={preview}
              previewing={previewing}
              projectWritable={Boolean(catalog?.projectDir)}
              saving={saving}
              onChange={update}
              onAvatarChange={(avatar) => setDraft({ ...draft, avatar, dirty: true })}
              onScopeChange={(writeScope) => setDraft({ ...draft, writeScope, dirty: true })}
              onToolsChange={(next) => setDraft({ ...draft, profile: { ...draft.profile, tools: next }, dirty: true })}
              onModelChange={(next) => setDraft({ ...draft, profile: { ...draft.profile, model: next }, dirty: true })}
              onSave={() => void save()}
              onPreview={() => void refreshPreview()}
              onClose={closeEditor}
            />
          ) : selected ? (
            <ProfileDetail
              key={selected.qualifiedId}
              view={selected}
              cwd={cwd}
              models={models}
              preview={preview}
              previewing={previewing}
              shadowed={shadowedIds.has(selected.qualifiedId)}
              busy={busy}
              acting={actionId === selected.qualifiedId}
              onEdit={() => startEdit(selected, 'edit')}
              onCopy={() => startEdit(selected, 'copy')}
              onToggle={() => void runAction(selected, 'toggle')}
              onReset={() => void runAction(selected, 'reset')}
              onDelete={() => void runAction(selected, 'delete')}
              onPreview={() => void showPreview(() => api.previewSubagentProfile({ profileId: selected.qualifiedId, ...scope }))}
            />
          ) : (
            <div className={styles.emptyDetail}>
              <h5>{effective.length === 0 ? t('subagentsEmpty') : t('subagentsSelectPrompt')}</h5>
              {effective.length === 0 && <SetmBtn onClick={startCreate}>{t('subagentsNew')}</SetmBtn>}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

function ProfileFacts({ view, models }: { view: SubagentProfileView; models: ModelCatalog | null }) {
  const tools = toolSelectionSummary(view.profile.tools, {
    inherit: t('subagentsToolsInherit'),
    none: t('subagentsToolsNone'),
    count: (n) => t('subagentsToolsCount').replace('{n}', String(n)),
  })
  const unavailable = view.profile.model.mode === 'explicit' && modelAvailability(models, view.profile.model.selection) === 'unavailable'
  return (
    <div className={styles.facts}>
      <span><small>{t('subagentsEnabled')}</small>{view.profile.enabled ? t('subagentsEnable') : t('subagentsDisable')}</span>
      <span><small>{t('subagentsToolsTitle')}</small>{tools}</span>
      <span className={unavailable ? styles.modelWarn : undefined} title={unavailable ? t('subagentsModelFallbackHint') : undefined}>
        <small>{t('subagentsModelTitle')}</small>{modelSummary(view.profile)}
        {unavailable && <em>{t('subagentsModelUnavailable')}</em>}
      </span>
    </div>
  )
}

function ProfileListItem({ view, cwd, models, selected, editing, shadowed, disabled, onSelect }: {
  view: SubagentProfileView
  cwd: string
  models: ModelCatalog | null
  selected: boolean
  editing: boolean
  shadowed: boolean
  disabled: boolean
  onSelect: () => void
}) {
  const avatar = useAgentAvatar(view.qualifiedId, cwd)
  return (
    <button
      type="button"
      className={`${styles.profileItem}${selected ? ` ${styles.profileItemSelected}` : ''}`}
      aria-pressed={selected}
      aria-label={`${view.profile.name}, ${view.profile.enabled ? t('subagentsEnabled') : t('subagentsDisabled')}`}
      data-qualified={view.qualifiedId}
      disabled={disabled}
      onClick={onSelect}
    >
      <AgentAvatar avatar={avatar} size={30} />
      <span className={styles.profileItemBody}>
        <span className={styles.profileItemName}>{view.profile.name}{shadowed && <small>{t('subagentsShadowedShort')}</small>}</span>
        <ProfileFacts view={view} models={models} />
      </span>
      {editing && <span className={styles.editingMark}>{t('subagentsEditing')}</span>}
    </button>
  )
}

function ProfileDetail({ view, cwd, models, preview, previewing, shadowed, busy, acting, onEdit, onCopy, onToggle, onReset, onDelete, onPreview }: {
  view: SubagentProfileView
  cwd: string
  models: ModelCatalog | null
  preview: SubagentPreview | null
  previewing: boolean
  shadowed: boolean
  busy: boolean
  acting: boolean
  onEdit: () => void
  onCopy: () => void
  onToggle: () => void
  onReset: () => void
  onDelete: () => void
  onPreview: () => void
}) {
  const avatar = useAgentAvatar(view.qualifiedId, cwd)
  const disabled = busy || acting
  return (
    <section className={styles.detailCard} data-testid="subagent-detail">
      <header className={styles.detailHead}>
        <div className={styles.detailIdentity}>
          <AgentAvatar avatar={avatar} size={40} />
          <div><h5>{view.profile.name}</h5><code>{view.qualifiedId}</code></div>
        </div>
        <div className={styles.tags}>
          <span className={`${styles.tag} ${view.profile.enabled ? styles.tagAccent : styles.tagMuted}`}>
            {view.profile.enabled ? t('subagentsEnabled') : t('subagentsDisabled')}
          </span>
          <span className={styles.tag}>{t(SOURCE_LABELS[view.source] as TranslateKey)}</span>
          {shadowed && <span className={styles.tagMuted}>{t('subagentsShadowedShort')}</span>}
        </div>
      </header>
      <div className={styles.detailBody}>
        <p className={styles.description}>{view.profile.description || t('subagentsNoDescription')}</p>
        <ProfileFacts view={view} models={models} />
        <dl className={styles.detailMeta}>
          <div><dt>{t('subagentsCeilingTitle')}</dt><dd>{view.profile.permissionCeiling === 'read-only' ? t('subagentsCeilingReadOnly') : t('subagentsCeilingInherit')}</dd></div>
          <div><dt>{t('subagentsModelTitle')}</dt><dd>{view.profile.model.mode === 'inherit' ? t('subagentsModelSourceInherit') : t('subagentsModelSourceExplicit')}</dd></div>
        </dl>
        {view.profile.instructions && <div className={styles.roleSummary}><span>{t('subagentsInstructions')}</span><p>{view.profile.instructions}</p></div>}
        {(view.diagnostics ?? []).length > 0 && <div className={styles.alert} role="status"><strong>{t('subagentsDiagnostics')}</strong><ul>{view.diagnostics?.map((issue, index) => <li key={`${issue.code}-${index}`}><code>{issue.code}</code> {issue.message}</li>)}</ul></div>}
        {view.source === 'builtin' && <p className={styles.hint}>{t('subagentsBuiltinReset')}</p>}
        {preview && <PreviewPanel preview={preview} />}
      </div>
      <footer className={styles.detailActions}>
        {!shadowed && <SetmBtn disabled={disabled || !view.editable} onClick={onEdit}>{t('subagentsEdit')}</SetmBtn>}
        <SetmBtn variant="ghost" disabled={disabled} onClick={onCopy}>{t('subagentsCopy')}</SetmBtn>
        <SetmBtn variant="ghost" disabled={disabled || previewing} onClick={onPreview}>{previewing ? t('loading') : t('subagentsPreview')}</SetmBtn>
        {!shadowed && <SetmBtn variant="ghost" disabled={disabled || !view.editable} onClick={onToggle}>{view.profile.enabled ? t('subagentsDisable') : t('subagentsEnable')}</SetmBtn>}
        {!shadowed && view.source !== 'builtin' && <SetmBtn variant="ghost" disabled={disabled || !view.editable} onClick={onReset}>{t('subagentsReset')}</SetmBtn>}
        {!shadowed && view.source !== 'builtin' && <SetmBtn variant="danger" disabled={disabled || !view.editable} onClick={onDelete}>{t('subagentsDelete')}</SetmBtn>}
      </footer>
    </section>
  )
}

const DraftEditor = forwardRef<HTMLElement, {
  draft: Draft
  tools: SubagentToolsView | null
  models: ModelCatalog | null
  preview: SubagentPreview | null
  previewing: boolean
  projectWritable: boolean
  saving: boolean
  onChange: (patch: Partial<SubagentProfile>) => void
  onAvatarChange: (avatar: AvatarId) => void
  onScopeChange: (scope: ProfileWriteScope) => void
  onToolsChange: (next: ToolSelection) => void
  onModelChange: (next: SubagentProfile['model']) => void
  onSave: () => void
  onPreview: () => void
  onClose: () => void
}>(function DraftEditor({ draft, tools, models, preview, previewing, projectWritable, saving, onChange, onAvatarChange, onScopeChange, onToolsChange, onModelChange, onSave, onPreview, onClose }, ref) {
  const [toolFilter, setToolFilter] = useState('')
  const [tab, setTab] = useState<EditorTab>('basics')
  const { profile } = draft
  const allowlist = profile.tools.mode === 'allowlist' ? profile.tools.names : []
  const rows: SubagentToolRow[] = tools?.tools ?? []
  const needle = toolFilter.trim().toLowerCase()
  const visible = rows.filter((row) => !needle || row.name.toLowerCase().includes(needle))
  const categories = Array.from(new Set(visible.map((row) => row.category)))
  const unknown = unknownToolNames(allowlist, rows)
  const conflicts = readOnlyConflicts(profile.permissionCeiling, allowlist, rows)
  const modelUnavailable = profile.model.mode === 'explicit' && modelAvailability(models, profile.model.selection) === 'unavailable'
  const tabLabels: Record<EditorTab, string> = { basics: t('subagentsBasic'), role: t('subagentsInstructions'), tools: t('subagentsToolsTitle'), model: t('subagentsModelTitle') }
  const toggleTool = (name: string) => onToolsChange({ mode: 'allowlist', names: toggleToolName(allowlist, name) })

  return (
    <section ref={ref} className={styles.editor} data-testid="subagent-editor">
      <header className={styles.editorHead}>
        <div className={styles.editorHeading}>
          <h5>{draft.kind === 'edit' ? t('subagentsEdit') : draft.kind === 'copy' ? t('subagentsCopy') : t('subagentsNew')}</h5>
          <span>{profile.name || profile.id || t('subagentsUntitled')}</span>
        </div>
        <div className={styles.editorActions}>
          <SetmBtn small variant="ghost" disabled={saving} onClick={onClose}>{t('cancel')}</SetmBtn>
          <SetmBtn small disabled={saving} onClick={onSave}>{saving ? t('loading') : t('subagentsSave')}</SetmBtn>
        </div>
      </header>
      <div className={styles.editorTabBar} role="tablist" aria-label={t('subagentsEditorSections')}>
        {EDITOR_TABS.map((id) => (
          <button key={id} id={`subagent-tab-${id}`} type="button" role="tab" aria-selected={tab === id} aria-controls={`subagent-panel-${id}`} tabIndex={tab === id ? 0 : -1} className={tab === id ? styles.editorTabActive : undefined} onClick={() => setTab(id)} onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            const index = EDITOR_TABS.indexOf(id)
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? EDITOR_TABS.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + EDITOR_TABS.length) % EDITOR_TABS.length
            setTab(EDITOR_TABS[next])
            document.getElementById(`subagent-tab-${EDITOR_TABS[next]}`)?.focus()
          }}>
            {tabLabels[id]}{id === 'tools' && conflicts.length > 0 && <span className={styles.tabAlert} aria-label={t('subagentsReadOnlyConflict')} />}{id === 'model' && modelUnavailable && <span className={styles.tabAlert} aria-label={t('subagentsModelUnavailable')} />}
          </button>
        ))}
      </div>
      <div className={styles.editorBody}>
        <p className={styles.editorNote}>{t('subagentsEditorHint')}</p>
        {tab === 'basics' && <div id="subagent-panel-basics" role="tabpanel" aria-labelledby="subagent-tab-basics" className={styles.editorPanel}>
          <div className="setm-form-grid two">
            <Field label="id" hint="^[a-z0-9][a-z0-9-]{0,63}$" error={null}><TextInput value={profile.id} mono disabled={draft.kind === 'edit'} placeholder="api-reviewer" onChange={(value) => onChange({ id: value })} /></Field>
            <Field label={t('subagentsName')} error={null}><TextInput value={profile.name} onChange={(value) => onChange({ name: value })} /></Field>
          </div>
          <Field label={t('subagentsDescription')} error={null}><textarea className={styles.textArea} aria-label={t('subagentsDescription')} rows={3} value={profile.description} onChange={(event) => onChange({ description: event.target.value })} /></Field>
          <div className="setm-form-grid two">
            <Field label={t('subagentsEnabled')} error={null}><ChipRadio value={profile.enabled ? 'on' : 'off'} options={[{ id: 'on', label: t('subagentsEnable') }, { id: 'off', label: t('subagentsDisable') }]} onChange={(value) => onChange({ enabled: value === 'on' })} /></Field>
            <Field label={t('subagentsCeilingTitle')} hint={t('subagentsCeilingHint')} error={null}><ChipRadio value={profile.permissionCeiling} options={[{ id: 'inherit', label: t('subagentsCeilingInherit') }, { id: 'read-only', label: t('subagentsCeilingReadOnly') }]} onChange={(value) => onChange({ permissionCeiling: value as SubagentProfile['permissionCeiling'] })} /></Field>
            <Field label={t('subagentsScope')} hint={t('subagentsScopeHint')} error={null}><ChipRadio value={draft.writeScope} options={[{ id: 'user', label: t('subagentsScopeUser') }, { id: 'project', label: t('subagentsScopeProject') }]} disabled={draft.kind === 'edit'} onChange={(value) => onScopeChange(value as ProfileWriteScope)} /></Field>
          </div>
          {!projectWritable && <p className={styles.hint}>{t('subagentsScopeProjectUnavailable')}</p>}
          <Field label={t('subagentsAvatar')} hint={t('subagentsAvatarLocal')} error={null}><div className={styles.avatarGrid} role="group" aria-label={t('subagentsAvatar')}>{AVATARS.map((avatar, index) => <button key={avatar} type="button" className={styles.avatarOption} aria-label={`${t('subagentsAvatar')} ${index + 1}`} aria-pressed={draft.avatar === avatar} onClick={() => onAvatarChange(avatar)}><AgentAvatar avatar={avatar} size={26} /></button>)}</div></Field>
        </div>}
        {tab === 'role' && <div id="subagent-panel-role" role="tabpanel" aria-labelledby="subagent-tab-role" className={styles.editorPanel}>
          <div className="setm-prompt-shell"><textarea className="setm-textarea" aria-label={t('subagentsInstructions')} rows={12} spellCheck={false} value={profile.instructions} onChange={(event) => onChange({ instructions: event.target.value })} /></div>
          <p className={styles.hint}>{t('subagentsInstructionsHint')}</p>
        </div>}
        {tab === 'tools' && <div id="subagent-panel-tools" role="tabpanel" aria-labelledby="subagent-tab-tools" className={styles.editorPanel}>
          <ChipRadio ariaLabel={t('subagentsToolsTitle')} value={profile.tools.mode} options={[{ id: 'inherit', label: t('subagentsToolsInheritOption') }, { id: 'allowlist', label: t('subagentsToolsAllowlistOption') }]} onChange={(value) => onToolsChange(value === 'inherit' ? { mode: 'inherit' } : { mode: 'allowlist', names: allowlist })} />
          {profile.tools.mode === 'allowlist' && <>
            <p className={styles.hint}>{allowlist.length === 0 ? t('subagentsToolsNone') : t('subagentsToolsCount').replace('{n}', String(allowlist.length))} · {t('subagentsToolsSectionHint')}</p>
            <div className={styles.toolFilter}><Field label={t('subagentsSearch')} error={null}><TextInput value={toolFilter} onChange={setToolFilter} placeholder="bash" /></Field></div>
            <div className={styles.toolPanel} data-testid="subagent-tools">
              {visible.length === 0 && <p className={styles.hint}>{t('subagentsToolNoMatch')}</p>}
              {categories.map((category) => <div key={category}><div className={styles.toolCategory}>{category}</div>{visible.filter((row) => row.category === category).map((row) => {
                const selected = allowlist.includes(row.name)
                const note = row.hardDenied ? t('subagentsToolHardDenied') : row.granted === false ? t('subagentsToolUngranted') : row.reason
                return <button key={row.name} type="button" role="switch" aria-checked={selected} aria-label={row.name} disabled={rowIsDisabled(row)} title={note} className={`${styles.toolRow}${selected ? ` ${styles.toolRowOn}` : ''}`} data-tool={row.name} onClick={() => toggleTool(row.name)}><span className={styles.toolName}>{selected ? '✓ ' : ''}{row.name}</span><span className={styles.toolEffect}>{row.effect || note}</span><span className={`${styles.toolState}${selected ? ` ${styles.toolOn}` : ''}`}>{selected ? t('subagentsToolSelected') : note ? t('subagentsToolBlocked') : ''}</span></button>
              })}</div>)}
            </div>
            {unknown.length > 0 && <div className={styles.alert} role="alert" data-testid="unknown-tools"><span className={styles.alertTitle}>{t('subagentsUnknownTools')}</span><p className={styles.hint}>{t('subagentsUnknownToolsHint')}</p><ul className={styles.alertList}>{unknown.map((name) => <li key={name} className={styles.alertItem}><code>{name}</code><SetmBtn small variant="ghost" onClick={() => toggleTool(name)}>{t('subagentsRemoveTool')}</SetmBtn></li>)}</ul></div>}
            {conflicts.length > 0 && <div className={styles.alert} role="alert" data-testid="readonly-conflicts"><span className={styles.alertTitle}>{t('subagentsReadOnlyConflict')}</span><p className={styles.hint}>{t('subagentsReadOnlyConflictHint')}</p><code>{conflicts.join('、')}</code><div className={styles.alertActions}><SetmBtn small variant="ghost" onClick={() => onChange({ permissionCeiling: 'inherit' })}>{t('subagentsUseInheritCeiling')}</SetmBtn><SetmBtn small variant="ghost" onClick={() => onToolsChange({ mode: 'allowlist', names: allowlist.filter((name) => !conflicts.includes(name)) })}>{t('subagentsDropConflicts')}</SetmBtn></div></div>}
          </>}
        </div>}
        {tab === 'model' && <div id="subagent-panel-model" role="tabpanel" aria-labelledby="subagent-tab-model" className={styles.editorPanel}>
          <ChipRadio ariaLabel={t('subagentsModelTitle')} value={profile.model.mode} options={[{ id: 'inherit', label: t('subagentsModelInherit') }, { id: 'explicit', label: t('subagentsModelExplicit') }]} onChange={(value) => onModelChange(value === 'inherit' ? { mode: 'inherit' } : { mode: 'explicit', selection: { provider: '', model: '', reasoningEffort: undefined } })} />
          {profile.model.mode === 'explicit' && <ExplicitModelFields models={models} model={profile.model.selection} onChange={onModelChange} />}
        </div>}
        <div className={styles.editorFooter}>
          <SetmBtn variant="ghost" disabled={saving || previewing} onClick={onPreview}>{previewing ? t('loading') : t('subagentsPreview')}</SetmBtn>
          {draft.dirty && <span className={styles.saved} role="status">{t('subagentsDraftChanged')}</span>}
        </div>
        {preview && <PreviewPanel preview={preview} />}
      </div>
    </section>
  )
})

function PreviewPanel({ preview }: { preview: SubagentPreview }) {
  return <div className={styles.preview} data-testid="subagent-preview">
    <span className={styles.previewTitle}>{preview.final ? t('subagentsPreviewTitle') : t('subagentsPreview')}</span>
    {preview.final ? <>
      <p className={styles.defMeta}><span>{preview.profile?.qualifiedId}</span><span>{preview.model?.provider}/{preview.model?.model}</span><span>{preview.modelOrigin === 'parent' ? t('subagentsModelSourceInherit') : t('subagentsModelSourceExplicit')}</span><span>{preview.permissionCeiling === 'read-only' ? t('subagentsCeilingReadOnly') : t('subagentsCeilingInherit')}</span><span>{preview.instructionScope}</span></p>
      {preview.modelFallback && <p className={styles.modelWarn} role="status">{preview.modelFallback}</p>}
      <span className={styles.sectionLabel}>{t('subagentsPreviewTools')}</span>
      {(preview.tools ?? []).length === 0 ? <p className={styles.hint}>{t('subagentsToolsNone')}</p> : <ul className={styles.chipList}>{(preview.tools ?? []).map((name) => <li key={name} className={styles.chip}>{name}</li>)}</ul>}
    </> : <p className={styles.hint}>{preview.note ?? t('subagentsPreviewHint')}（{t('subagentsPreviewNoSession')}）</p>}
  </div>
}

function modelAvailability(models: ModelCatalog | null, selection: ModelSelection): 'ok' | 'unavailable' | 'unknown' {
  if (!models || models.groups.length === 0) return 'unknown'
  const group = models.groups.find((entry) => entry.id === selection.provider)
  if (!group) return 'unavailable'
  return group.models.some((entry) => entry.id === selection.model) ? 'ok' : 'unavailable'
}

function ExplicitModelFields({ models, model, onChange }: { models: ModelCatalog | null; model: ModelSelection; onChange: (next: SubagentProfile['model']) => void }) {
  // Every selection replaces the whole model choice; no provider/model/effort subfield is saved alone.
  const patch = (part: Partial<ModelSelection>) => onChange({ mode: 'explicit', selection: { ...model, ...part } })
  const availability = modelAvailability(models, model)
  const groups = models?.groups ?? []
  const group = groups.find((entry) => entry.id === model.provider)
  const modelInfo = group?.models.find((entry) => entry.id === model.model)
  const providerOptions: SelectOption<string>[] = groups.map((entry) => ({ id: entry.id, label: entry.name || entry.id }))
  if (model.provider && !providerOptions.some((option) => option.id === model.provider)) providerOptions.push({ id: model.provider, label: model.provider })
  const modelOptions: SelectOption<string>[] = (group?.models ?? []).map((entry) => ({ id: entry.id, label: entry.name }))
  if (model.model && !modelOptions.some((option) => option.id === model.model)) modelOptions.push({ id: model.model, label: model.model })
  const effortOptions: SelectOption[] = [{ id: '', label: t('subagentsEffortDefault') }, ...(modelInfo?.reasoning?.efforts ?? []).map((effort) => ({ id: effort.id, label: effort.name }))]
  if (model.reasoningEffort && !effortOptions.some((option) => option.id === model.reasoningEffort)) effortOptions.push({ id: model.reasoningEffort, label: model.reasoningEffort })

  if (groups.length > 0) {
    return <div className="setm-form-grid two">
      <DropdownField label="provider" value={model.provider} options={providerOptions} onChange={(provider) => { const nextGroup = groups.find((entry) => entry.id === provider); patch({ provider, model: nextGroup?.models[0]?.id ?? '', reasoningEffort: undefined }) }} />
      <DropdownField label="model" value={model.model} options={modelOptions} onChange={(nextModel) => patch({ model: nextModel, reasoningEffort: undefined })} />
      <DropdownField label="reasoning effort" value={model.reasoningEffort ?? ''} options={effortOptions} onChange={(effort) => patch({ reasoningEffort: effort || undefined })} />
      {availability === 'unavailable' && <div className={`${styles.alert} ${styles.modelAlert}`} role="alert"><span className={styles.alertTitle}>{t('subagentsModelUnavailable')}</span><p className={styles.hint}>{t('subagentsModelFallbackHint')}</p></div>}
    </div>
  }

  return <div className="setm-form-grid two">
    <Field label="provider" error={null}><TextInput value={model.provider} onChange={(value) => patch({ provider: value })} /></Field>
    <Field label="model" error={null}><TextInput value={model.model} onChange={(value) => patch({ model: value })} /></Field>
    <Field label="reasoning effort" hint={t('subagentsEffortHint')} error={null}><TextInput value={model.reasoningEffort ?? ''} onChange={(value) => patch({ reasoningEffort: value || undefined })} /></Field>
    {availability === 'unavailable' && <div className={`${styles.alert} ${styles.modelAlert}`} role="alert"><span className={styles.alertTitle}>{t('subagentsModelUnavailable')}</span><p className={styles.hint}>{t('subagentsModelFallbackHint')}</p></div>}
  </div>
}
