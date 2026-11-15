import { useRef } from 'react'
import type { KeyboardEvent } from 'react'
import { PuzzlePiece, GraduationCap, Plugs } from '@phosphor-icons/react'
import type { Notify } from '../App'
import { t } from '../i18n'
import { McpSettings } from '../components/settings/McpSettings'
import { SkillsManager } from '../components/extensions/SkillsManager'
import styles from './ExtensionsPage.module.css'

import type { ExtensionTab } from '../extensionsRoute'

export default function ExtensionsPage({ tab, cwd, onTabChange, notify }: {
  tab: ExtensionTab
  cwd?: string
  onTabChange: (tab: ExtensionTab) => void
  notify: Notify
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([])
  const tabs = [
    { id: 'skills' as const, label: t('extensionsSkills'), icon: GraduationCap },
    { id: 'mcp' as const, label: 'MCP', icon: Plugs },
  ]
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') next = 1 - index
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = 1
    else return
    event.preventDefault()
    onTabChange(tabs[next].id)
    buttons.current[next]?.focus()
  }
  return (
    <section className={styles.page} aria-label={t('extensionsTitle')}>
      <div className={styles.content}>
        <header className={styles.header}>
          <div className={styles.title}><PuzzlePiece size={22} /><h1>{t('extensionsTitle')}</h1></div>
          <p>{t('extensionsDescription')}</p>
        </header>
        <div className={styles.navigation}>
          <div className={styles.tabs} role="tablist" aria-label={t('extensionsTitle')}>
            {tabs.map(({ id, label, icon: Icon }, index) => (
              <button key={id} ref={(node) => { buttons.current[index] = node }} type="button"
                id={`extension-tab-${id}`} role="tab" aria-selected={tab === id}
                aria-controls={`extension-panel-${id}`} tabIndex={tab === id ? 0 : -1}
                onKeyDown={(event) => onKeyDown(event, index)} onClick={() => onTabChange(id)}>
                <Icon size={18} /><span>{label}</span>
              </button>
            ))}
          </div>
          {cwd && <span className={styles.project} title={cwd}>{t('extensionsProject')}: {cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd}</span>}
        </div>
        <div role="tabpanel" id={`extension-panel-${tab}`} aria-labelledby={`extension-tab-${tab}`} className={styles.panel}>
          {tab === 'skills' ? <SkillsManager key={cwd ?? 'user'} cwd={cwd} /> : <McpSettings notify={notify} />}
        </div>
      </div>
    </section>
  )
}
