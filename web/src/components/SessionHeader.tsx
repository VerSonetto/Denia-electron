import type { Dispatch, SetStateAction } from 'react';
import { t } from '../i18n';
import { sessionDisplayTitle } from '../sessionDisplay';
import type { ProjectRecord, SessionSummary } from '../types';
import { SessionPresetLabel } from './SessionPresetLabel';
import { OpenInApp } from './OpenInApp';
import { AgentPresetSelector } from './AgentPresetSelector';
import { IconCheck, IconChevron, IconDownload, IconPanelOpen, IconPlus, IconProject } from './icons';
import type { ExportFormat } from '../lib/exportSession';
import type { AgentPresetsView } from '../api';
import * as api from '../api';
import { notify } from '../appStore';
import { downloadFile, serializeSession } from '../lib/exportSession';

export type ComposerView = 'chat' | 'trajectory'

/** 会话页头部:标题/预设标签、视图切换、导出与右侧面板开关。 */
export function SessionHeader({
  activeSession,
  activeId,
  agentPresetId,
  agentPresetCatalog,
  view,
  setView,
  sidePaneOpen,
  onToggleSidePane,
  runtimeCounts,
  runtimeCollapsed,
  onExpandRuntime,
  exportOpen,
  exportBusy,
  setExportOpen,
  setExportBusy,
}: {
  activeSession: SessionSummary | null
  activeId: string | null
  agentPresetId: string | null
  agentPresetCatalog: AgentPresetsView | null
  view: ComposerView
  setView: (view: ComposerView) => void
  sidePaneOpen: boolean
  onToggleSidePane?: () => void
  runtimeCounts?: { agents: number; jobs: number }
  runtimeCollapsed?: boolean
  onExpandRuntime?: () => void
  exportOpen: boolean
  exportBusy: boolean
  setExportOpen: Dispatch<SetStateAction<boolean>>
  setExportBusy: Dispatch<SetStateAction<boolean>>
}) {
  /* ---- 导出会话:从后端拉全量 events 后回放文件 ---- */
  const handleExport = async (format: ExportFormat) => {
    if (!activeId || exportBusy) return
    setExportOpen(false)
    setExportBusy(true)
    try {
      const snapshot = await api.getSession(activeId)
      if (snapshot.events.length === 0) {
        notify('err', t('exportEmpty'))
        return
      }
      const title = activeSession ? sessionDisplayTitle(activeSession) : t('blankSession')
      const payload = serializeSession(format, {
        header: snapshot.header,
        events: snapshot.events,
        title,
      })
      downloadFile(payload.content, payload.filename, payload.mimeType)
      notify('ok', t('exportDownloaded', { name: payload.filename }))
    } catch (error) {
      console.error('[export] 会话导出失败', error)
      notify('err', t('exportFailed'))
    } finally {
      setExportBusy(false)
    }
  }

  return (
    <header className="session-header">
      {/* 标题块:标题与预设标签同处一块,标签紧贴标题文字。
          这样头部动作区一个元素都不新增,标签也不会飘到最右。 */}
      <div className="session-title-block">
        <h1 className="session-title">
          {activeSession ? sessionDisplayTitle(activeSession) : t('blankSession')}
        </h1>
        {activeSession && agentPresetId && (
          <SessionPresetLabel
            presetId={agentPresetId}
            presets={agentPresetCatalog?.presets ?? []}
          />
        )}
        {runtimeCollapsed && runtimeCounts && onExpandRuntime && (runtimeCounts.agents > 0 || runtimeCounts.jobs > 0) && (
          <button type="button" className="runtime-header-entry" onClick={onExpandRuntime} aria-label={t('runtimeExpand')}>
            {runtimeCounts.agents > 0 && <span>{t('runtimeAgentCount', { n: runtimeCounts.agents })}</span>}
            {runtimeCounts.agents > 0 && runtimeCounts.jobs > 0 && <span aria-hidden="true">{t('runtimeCountJoin')}</span>}
            {runtimeCounts.jobs > 0 && <span>{t('runtimeJobCount', { n: runtimeCounts.jobs })}</span>}
          </button>
        )}
      </div>
      {activeSession?.cwd_alive === false && (
        <span className="badge err" title={t('deadCwdHint')}>
          {t('deadCwd')}
        </span>
      )}
      <div className="view-switch" role="tablist" aria-label={t('viewTrajectory')}>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'chat'}
          className={`view-switch-tab${view === 'chat' ? ' active' : ''}`}
          onClick={() => setView('chat')}
        >
          {t('viewChat')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'trajectory'}
          className={`view-switch-tab${view === 'trajectory' ? ' active' : ''}`}
          onClick={() => setView('trajectory')}
        >
          {t('viewTrajectory')}
        </button>
      </div>
      <OpenInApp
        cwd={activeSession?.cwd_alive === false ? null : activeSession?.cwd ?? null}
      />
      {/* 右侧面板开关:项目头部最右、紧邻导出。 */}
      {onToggleSidePane && (
        <button
          type="button"
          className={`icon-btn session-pane-btn${sidePaneOpen ? ' active' : ''}`}
          title={t('sidePaneToggle')}
          aria-label={sidePaneOpen ? t('sidePaneCollapse') : t('sidePaneExpand')}
          aria-pressed={sidePaneOpen}
          data-testid="side-pane-toggle"
          onClick={onToggleSidePane}
        >
          <IconPanelOpen size={15} />
        </button>
      )}
      <div className={`session-export${exportOpen ? ' open' : ''}`}>
        <button
          type="button"
          className="icon-btn session-export-btn"
          title={t('exportSessionHint')}
          aria-label={t('exportSession')}
          aria-haspopup="menu"
          aria-expanded={exportOpen}
          disabled={!activeId || exportBusy}
          onClick={() => setExportOpen((open) => !open)}
        >
          <IconDownload size={15} />
        </button>
        {exportOpen && (
          <>
            <div className="menu-backdrop" onClick={() => setExportOpen(false)} />
            <div className="session-export-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                className="session-export-item"
                onClick={() => void handleExport('markdown')}
              >
                <span className="session-export-item-title">{t('exportAsMarkdown')}</span>
                <span className="session-export-item-hint">.md</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="session-export-item"
                onClick={() => void handleExport('json')}
              >
                <span className="session-export-item-title">{t('exportAsJson')}</span>
                <span className="session-export-item-hint">.json</span>
              </button>
            </div>
          </>
        )}
      </div>
    </header>
  )
}

/** 欢迎页(hero)的项目选择行:项目芯片 + 预设选择器 + 项目菜单。 */
export function HeroProjectRow({
  projects,
  activeProject,
  locked,
  inert,
  projectMenuOpen,
  setProjectMenuOpen,
  agentPresetCatalog,
  agentPresetId,
  agentPresetBusy,
  changeAgentPreset,
  onSelectProject,
  onAddProject,
  onOpenPicker,
}: {
  projects: ProjectRecord[]
  activeProject: ProjectRecord | null
  locked: boolean
  inert: boolean
  projectMenuOpen: boolean
  setProjectMenuOpen: Dispatch<SetStateAction<boolean>>
  agentPresetCatalog: AgentPresetsView | null
  agentPresetId: string | null
  agentPresetBusy: boolean
  changeAgentPreset: (id: string) => void
  onSelectProject: (project: ProjectRecord) => void
  onAddProject: () => void
  onOpenPicker: () => void
}) {
  return (
    <div className="composer-project hero-project-row">
      <button
        type="button"
        className={`project-chip${projectMenuOpen ? ' open' : ''}`}
        aria-expanded={projectMenuOpen}
        onClick={() => {
          if (projects.length === 0) onOpenPicker()
          else setProjectMenuOpen((open) => !open)
        }}
      >
        <IconProject size={16} />
        <span className={activeProject ? 'label' : 'label dim'}>
          {activeProject ? (activeProject.builtin === 'default' ? t('defaultProject') : activeProject.title) : t('heroChooseProject')}
        </span>
        <IconChevron size={11} />
      </button>
      {/* 模式选择关闭时新会话固定用部署默认预设,选择器整个不渲染。 */}
      {agentPresetCatalog && agentPresetCatalog.modeSelection && agentPresetId && (
        <AgentPresetSelector
          value={agentPresetId}
          presets={agentPresetCatalog.presets}
          defaultId={agentPresetCatalog.default}
          disabled={inert || agentPresetBusy}
          onChange={changeAgentPreset}
        />
      )}
      {projectMenuOpen && (
        <>
          <div className="menu-backdrop" onClick={() => setProjectMenuOpen(false)} />
          <div className="project-menu">
            {projects.map((project) => {
              const notCurrent = project.id !== activeProject?.id
              const blocked = locked && notCurrent
              return (
                <button
                  key={project.id}
                  type="button"
                  className={`project-menu-item${project.id === activeProject?.id ? ' active' : ''}`}
                  title={blocked ? t('projectLockedTitle') : project.dirs.join('\n')}
                  disabled={blocked}
                  onClick={() => {
                    setProjectMenuOpen(false)
                    onSelectProject(project)
                  }}
                >
                  <IconProject size={18} />
                  <span className="project-menu-text">
                    <span className="name">{project.builtin === 'default' ? t('defaultProject') : project.title}</span>
                    <span className="project-menu-path">
                      {project.dirs.length > 1
                        ? t('projectDirsCount', { n: project.dirs.length })
                        : project.dirs[0] ?? ''}
                    </span>
                  </span>
                  {project.id === activeProject?.id && <IconCheck size={13} />}
                </button>
              )
            })}
            <button
              type="button"
              className="project-menu-item create"
              onClick={() => {
                setProjectMenuOpen(false)
                onAddProject()
              }}
            >
              <IconPlus size={13} />
              <span className="name">{t('addProjectMenu')}</span>
            </button>
          </div>
        </>
      )}
    </div>
  )
}
