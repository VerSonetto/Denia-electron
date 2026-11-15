import { useCallback, useEffect, useId, useRef, useState } from 'react'
import * as api from '../api'
import { t } from '../i18n'
import { DirPicker } from './DirPicker'
import { IconClose, IconFolderPlus, IconProject, IconTrash } from './icons'

function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  return trimmed.split(/[\\/]/).pop() || path
}

/**
 * Create-project dialog: one name plus any number of directories.
 *
 * - Empty name → the first selected directory's name (or "新项目" when no
 *   directory is selected).
 * - Empty directory list → the host creates a managed directory for the
 *   project, so every project always has a real place to work in.
 */
export function ProjectDialog({
  onCreate,
  onClose,
  onError,
}: {
  onCreate: (input: { title?: string; dirs: string[] }) => Promise<void>
  onClose: () => void
  onError: (message: string) => void
}) {
  const [title, setTitle] = useState('')
  const [dirs, setDirs] = useState<string[]>([])
  const [browsing, setBrowsing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [managedRoot, setManagedRoot] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const titleId = useId()
  const busyRef = useRef(false)

  useEffect(() => {
    api
      .listProjects()
      .then((view) => setManagedRoot(view.managedRoot ?? null))
      .catch(() => setManagedRoot(null))
  }, [])

  useEffect(() => {
    const previousFocus = document.activeElement
    nameRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (browsing) setBrowsing(false)
        else onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const dialog = dialogRef.current
      if (!dialog) return
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), [tabindex="0"]',
        ),
      ).filter((element) => element.getClientRects().length > 0)
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!first || !last) {
        event.preventDefault()
        dialog.focus()
      } else if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
    }
  }, [browsing])

  const addDir = useCallback((path: string) => {
    setDirs((previous) => previous.includes(path) ? previous : [...previous, path])
  }, [])

  const removeDir = (path: string) => {
    setDirs((previous) => previous.filter((entry) => entry !== path))
  }

  const submit = async () => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      const trimmed = title.trim()
      await onCreate({
        title: trimmed !== '' ? trimmed : effectiveName,
        dirs,
      })
      onCloseRef.current()
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const effectiveName =
    title.trim() !== ''
      ? title.trim()
      : dirs[0]
        ? baseName(dirs[0]!)
        : t('projectUntitled')

  return (
    <>
      <div className="project-dialog-backdrop" onClick={onClose}>
        <div
          className="project-dialog"
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="project-dialog-titlebar">
            <h2 className="project-dialog-title" id={titleId}>
              <IconProject size={20} />
              {t('createProject')}
            </h2>
            <button
              className="picker-close"
              onClick={onClose}
              aria-label={t('close')}
            >
              <IconClose size={18} />
            </button>
          </div>

          <div className="project-dialog-body">
            <label className="project-dialog-field">
              <span className="project-dialog-label">{t('projectNameLabel')}</span>
              <input
                ref={nameRef}
                className="project-dialog-input"
                type="text"
                value={title}
                maxLength={80}
                placeholder={t('projectNamePlaceholder')}
                onChange={(event) => setTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  void submit()
                }}
              />
            </label>

            <div className="project-dialog-field">
              <span className="project-dialog-label">
                {t('projectDirsLabel')}
                {dirs.length > 0 && <span className="project-dialog-count">{dirs.length}</span>}
              </span>
              {dirs.length === 0 ? (
                <div className="project-dialog-empty">
                  <p>{t('projectNoDirsHint')}</p>
                  {managedRoot && (
                    <code className="project-dialog-managed">
                      {managedRoot}
                      {' / '}
                      {effectiveName}
                    </code>
                  )}
                </div>
              ) : (
                <ul className="project-dialog-dirs">
                  {dirs.map((dir) => (
                    <li key={dir} className="project-dialog-dir">
                      <IconProject size={14} />
                      <span className="project-dialog-dir-name">{baseName(dir)}</span>
                      <code className="project-dialog-dir-path" title={dir}>{dir}</code>
                      <button
                        type="button"
                        className="row-action-btn danger"
                        title={t('removeProjectDir')}
                        aria-label={t('removeProjectDir')}
                        onClick={() => removeDir(dir)}
                      >
                        <IconTrash size={12} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <button
                type="button"
                className="project-dialog-add"
                onClick={() => setBrowsing(true)}
              >
                <IconFolderPlus size={14} />
                {t('addProjectDir')}
              </button>
            </div>

            <p className="project-dialog-hint">
              {title.trim() === '' && dirs.length > 0
                ? t('projectNameFromDir', { name: effectiveName })
                : t('projectDirsHint')}
            </p>
          </div>

          <div className="project-dialog-actions">
            <button type="button" className="btn" onClick={onClose}>
              {t('cancel')}
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              onClick={() => void submit()}
            >
              {busy ? t('creating') : t('createProjectAction')}
            </button>
          </div>
        </div>
      </div>
      {browsing && (
        <DirPicker
          title={t('selectProjectDir')}
          onPick={async (path) => {
            addDir(path)
            setBrowsing(false)
          }}
          onClose={() => setBrowsing(false)}
          onError={onError}
        />
      )}
    </>
  )
}
