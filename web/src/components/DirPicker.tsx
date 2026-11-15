import { useCallback, useEffect, useId, useRef, useState } from 'react'
import * as api from '../api'
import { t } from '../i18n'
import { IconArrowLeft, IconChevron, IconClose, IconProject } from './icons'

interface BrowseState {
  path: string
  parent: string | null
  dirs: string[]
}

function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  return trimmed.split(/[\\/]/).pop() || path
}

/**
 * Modal directory browser: drill into subdirectories, go up, and confirm the
 * current directory. A collapsed manual-path row covers paste-from-anywhere.
 */
export function DirPicker({
  title,
  onPick,
  onClose,
  onError,
}: {
  /** Dialog heading; defaults to the project-directory picker title. */
  title?: string
  onPick: (path: string) => Promise<void>
  onClose: () => void
  onError: (message: string) => void
}) {
  const [state, setState] = useState<BrowseState | null>(null)
  const [loading, setLoading] = useState(false)
  const [manual, setManual] = useState(false)
  const [manualPath, setManualPath] = useState('')
  const [picking, setPicking] = useState(false)
  const [folderName, setFolderName] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const mountedRef = useRef(false)
  const requestRef = useRef(0)
  const pickingRef = useRef(false)
  const creatingRef = useRef(false)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const titleId = useId()

  useEffect(() => {
    mountedRef.current = true
    const previousFocus = document.activeElement
    closeButtonRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onCloseRef.current()
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
    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      mountedRef.current = false
      requestRef.current += 1
      document.removeEventListener('keydown', handleKeyDown, true)
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
    }
  }, [])

  const browse = useCallback(
    (path?: string) => {
      const request = ++requestRef.current
      setLoading(true)
      api
        .browseDirs(path)
        .then((result) => {
          if (mountedRef.current && request === requestRef.current) setState(result)
        })
        .catch((error) => {
          if (mountedRef.current && request === requestRef.current) {
            onError(error instanceof Error ? error.message : String(error))
          }
        })
        .finally(() => {
          if (mountedRef.current && request === requestRef.current) setLoading(false)
        })
    },
    [onError],
  )

  useEffect(() => {
    browse()
  }, [browse])

  const pick = async (path: string) => {
    if (pickingRef.current) return
    pickingRef.current = true
    setPicking(true)
    try {
      await onPick(path)
      if (mountedRef.current) onCloseRef.current()
    } catch (error) {
      if (mountedRef.current) onError(error instanceof Error ? error.message : String(error))
    } finally {
      pickingRef.current = false
      if (mountedRef.current) setPicking(false)
    }
  }

  const createFolder = async () => {
    if (!state || !folderName?.trim() || loading || creatingRef.current) return
    const request = requestRef.current
    creatingRef.current = true
    setCreating(true)
    try {
      await api.mkdir(state.path, folderName.trim())
      if (mountedRef.current && request === requestRef.current) {
        setFolderName(null)
        browse(state.path)
      }
    } catch (error) {
      if (mountedRef.current) onError(error instanceof Error ? error.message : String(error))
    } finally {
      creatingRef.current = false
      if (mountedRef.current) setCreating(false)
    }
  }

  return (
    <div className="picker-backdrop" onClick={onClose}>
      <div
        className="picker"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="picker-titlebar">
          <h2 className="picker-title" id={titleId}>
            <IconProject size={20} />
            {title ?? t('selectProjectDir')}
          </h2>
          <button className="picker-close" ref={closeButtonRef} onClick={onClose} aria-label={t('close')}>
            <IconClose size={18} />
          </button>
        </div>
        <div className="picker-head">
          <button
            className="picker-up"
            disabled={!state?.parent || loading}
            onClick={() => state?.parent && browse(state.parent)}
            title={t('upDir')}
            aria-label={t('upDir')}
          >
            <IconArrowLeft size={18} />
          </button>
          <div className="picker-location">
            <span className="picker-cwd" title={state?.path}>
              {state ? baseName(state.path) : t('loading')}
            </span>
            <span className="picker-path" title={state?.path}>{state?.path}</span>
          </div>
        </div>
        <div className="picker-list" aria-busy={loading}>
          {loading && <div className="picker-empty" role="status">{t('loading')}</div>}
          {!loading && state && state.dirs.length === 0 && (
            <div className="picker-empty">{t('noSubdirs')}</div>
          )}
          {!loading &&
            state?.dirs.map((name) => (
              <button
                key={name}
                className="picker-item"
                onClick={() =>
                  browse(
                    /^[A-Za-z]:\\$/.test(name)
                      ? name
                      : `${state.path.replace(/[\\/]+$/, '')}/${name}`,
                  )
                }
              >
                <IconProject size={18} />
                <span>{name.replace(/\\+$/, '')}</span>
                <IconChevron size={12} />
              </button>
            ))}
        </div>
        <div className="picker-foot">
          {folderName !== null ? (
            <div className="picker-manual">
              <input
                type="text"
                autoFocus
                placeholder={t('newFolder')}
                aria-label={t('newFolder')}
                value={folderName}
                disabled={creating}
                onChange={(event) => setFolderName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void createFolder()
                }}
              />
              <button className="btn small" disabled={!folderName.trim() || loading || creating} onClick={() => void createFolder()}>
                {t('save')}
              </button>
            </div>
          ) : (
            <button className="picker-manual-toggle" disabled={!state || loading} onClick={() => setFolderName('')}>
              + {t('newFolder')}
            </button>
          )}
          {manual ? (
            <div className="picker-manual">
              <input
                type="text"
                autoFocus
                placeholder={t('projectPathPlaceholder')}
                aria-label={t('projectPathPlaceholder')}
                value={manualPath}
                onChange={(event) => setManualPath(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && manualPath.trim()) {
                    void pick(manualPath.trim())
                  }
                }}
              />
              <button
                className="btn small"
                disabled={!manualPath.trim() || picking}
                onClick={() => void pick(manualPath.trim())}
              >
                {t('save')}
              </button>
            </div>
          ) : (
            <button
              className="picker-manual-toggle"
              onClick={() => setManual(true)}
            >
              {t('manualPathToggle')}
            </button>
          )}
          <div className="picker-actions">
            <button className="btn" onClick={onClose}>{t('cancel')}</button>
            <button
              className="btn"
              disabled={!state || loading || picking}
              onClick={() => state && void pick(state.path)}
            >
              {t('selectCurrentDir')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
