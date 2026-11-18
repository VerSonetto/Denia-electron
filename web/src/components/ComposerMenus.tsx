import {
  Fragment,
  type Dispatch,
  type Ref,
  type SetStateAction,
} from 'react'

import type { MentionCandidate } from '../api'
import { t } from '../i18n'
import { IconFile, IconFolder, IconSlashCommand, IconSparkles, IconSpinner } from './icons'

export interface SlashCandidate {
  name: string
  kind: 'command' | 'skill'
  description: string
  userOnly: boolean
}

/** 输入框的 @ 文件与 / 命令候选弹层。 */
export function ComposerMenus({
  mentionOpen,
  mentionItems,
  mentionLoading,
  mentionQuery,
  mentionActive,
  setMentionActive,
  mentionMenuRef,
  closeMention,
  pickMention,
  slashOpen,
  slashItems,
  slashActive,
  setSlashActive,
  slashMenuRef,
  closeSlash,
  pickSlash,
}: {
  mentionOpen: boolean
  mentionItems: MentionCandidate[]
  mentionLoading: boolean
  mentionQuery: string
  mentionActive: number
  setMentionActive: Dispatch<SetStateAction<number>>
  mentionMenuRef: Ref<HTMLDivElement>
  closeMention: () => void
  pickMention: (item: MentionCandidate) => void
  slashOpen: boolean
  slashItems: SlashCandidate[]
  slashActive: number
  setSlashActive: Dispatch<SetStateAction<number>>
  slashMenuRef: Ref<HTMLDivElement>
  closeSlash: () => void
  pickSlash: (item: SlashCandidate) => void
}) {
  return (
    <>
      {mentionOpen && (
        <>
          <div className="menu-backdrop" onClick={closeMention} />
          <div
            className="mention-menu"
            id="file-mention-results"
            role="listbox"
            aria-busy={mentionLoading}
            aria-label={t('mentionAria')}
            ref={mentionMenuRef}
          >
            <div className="mention-menu-heading">{t('mentionSearchHint')}</div>
            {mentionLoading ? (
              <div className="mention-menu-empty">
                <IconSpinner size={12} />
                {t('mentionLoading')}
              </div>
            ) : mentionItems.length === 0 ? (
              <div className="mention-menu-empty">
                {mentionQuery ? t('mentionEmpty') : t('mentionEmptyQuery')}
              </div>
            ) : (
              mentionItems.map((item, index) => {
                const active = index === mentionActive
                const directory = item.kind === 'directory'
                const slash = item.path.lastIndexOf('/')
                const name = slash >= 0 ? item.path.slice(slash + 1) : item.path
                const parent = slash >= 0 ? item.path.slice(0, slash + 1) : ''
                return (
                  <button
                    key={`${item.kind}:${item.path}`}
                    id={`file-mention-option-${index}`}
                    title={item.path}
                    type="button"
                    role="option"
                    aria-selected={active}
                    data-kb={active || undefined}
                    className={`mention-menu-item${active ? ' kb' : ''}`}
                    onMouseDown={(mouseEvent) => {
                      // 阻止菜单夺焦:编辑器必须保住光标/选区,execCommand 才能落点。
                      mouseEvent.preventDefault()
                    }}
                    onMouseEnter={() => setMentionActive(index)}
                    onClick={() => pickMention(item)}
                  >
                    <span className={`mention-menu-icon${directory ? ' dir' : ''}`}>
                      {directory ? <IconFolder size={13} /> : <IconFile size={13} />}
                    </span>
                    <span className="mention-menu-text">
                      <span className="mention-menu-name">
                        {name}
                        {directory ? '/' : ''}
                      </span>
                      {parent && <span className="mention-menu-parent">{parent}</span>}
                    </span>
                  </button>
                )
              })
            )}
          </div>
        </>
      )}
      {slashOpen && (
        <>
          <div className="menu-backdrop" onClick={closeSlash} />
          <div
            className="mention-menu"
            role="listbox"
            aria-label={t('slashAria')}
            ref={slashMenuRef}
          >
            {slashItems.length === 0 ? (
              <div className="mention-menu-empty">{t('slashEmpty')}</div>
            ) : (
              slashItems.map((item, index) => {
                const active = index === slashActive
                const header =
                  index === 0 || slashItems[index - 1]!.kind !== item.kind ? (
                    <div className="slash-menu-group" role="presentation">
                      {item.kind === 'command' ? t('slashGroupCommands') : t('slashGroupSkills')}
                    </div>
                  ) : null
                return (
                  <Fragment key={`${item.kind}:${item.name}`}>
                    {header}
                    <button
                      type="button"
                      role="option"
                      aria-selected={active}
                      data-kb={active || undefined}
                      className={`mention-menu-item${active ? ' kb' : ''}`}
                      onMouseDown={(mouseEvent) => {
                        // 阻止菜单夺焦:编辑器必须保住光标/选区,execCommand 才能落点。
                        mouseEvent.preventDefault()
                      }}
                      onMouseEnter={() => setSlashActive(index)}
                      onClick={() => pickSlash(item)}
                    >
                      <span className="mention-menu-icon">
                        {item.kind === 'command' ? (
                          <IconSlashCommand name={item.name} size={13} />
                        ) : (
                          /* 技能:统一四角星,不按名字区分。 */
                          <IconSparkles size={13} />
                        )}
                      </span>
                      <span className="mention-menu-text">
                        <span className="mention-menu-name-row">
                          <span className="mention-menu-name">/{item.name}</span>
                          {item.userOnly && (
                            <span className="slash-badge">{t('slashBadgeUserOnly')}</span>
                          )}
                        </span>
                        <span className="slash-menu-desc">{item.description}</span>
                      </span>
                    </button>
                  </Fragment>
                )
              })
            )}
          </div>
        </>
      )}
    </>
  )
}
