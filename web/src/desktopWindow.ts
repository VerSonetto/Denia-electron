import { isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'

/** Window controls exposed by the desktop shell; the UI uses the same pair. */
export interface DesktopWindowControls {
  minimize(): Promise<void>
  toggleMaximize(): Promise<void>
  close(): Promise<void>
  isMaximized(): Promise<boolean>
  /** Subscribe to maximize changes; returns the unsubscribe function. */
  onMaximizedChange(listener: (maximized: boolean) => void): () => void
}

export interface DesktopShell {
  kind: 'tauri' | 'electron'
  controls: DesktopWindowControls
}

interface ElectronWindowBridge {
  minimize(): void
  toggleMaximize(): void
  close(): void
  isMaximized(): Promise<boolean>
  onMaximizedChange(listener: (maximized: boolean) => void): () => void
}

declare global {
  interface Window {
    /** Injected by the Electron preload; absent in browsers and Tauri. */
    deniaDesktop?: { kind: 'electron'; window: ElectronWindowBridge }
  }
}

function tauriControls(): DesktopWindowControls {
  const window = getCurrentWindow()
  return {
    minimize: () => window.minimize(),
    toggleMaximize: () => window.toggleMaximize(),
    close: () => window.close(),
    isMaximized: () => window.isMaximized(),
    onMaximizedChange: (listener) => {
      let disposed = false
      let unlisten: (() => void) | undefined
      // Resize covers maximize/unmaximize on every platform Tauri builds for;
      // re-querying keeps one code path instead of tracking native events.
      void window
        .onResized(() => {
          void window
            .isMaximized()
            .then((value) => {
              if (!disposed) listener(value)
            })
            .catch(() => {})
        })
        .then((stop) => {
          if (disposed) stop()
          else unlisten = stop
        })
        .catch(() => {})
      return () => {
        disposed = true
        unlisten?.()
      }
    },
  }
}

function electronControls(bridge: ElectronWindowBridge): DesktopWindowControls {
  return {
    minimize: () => {
      bridge.minimize()
      return Promise.resolve()
    },
    toggleMaximize: () => {
      bridge.toggleMaximize()
      return Promise.resolve()
    },
    close: () => {
      bridge.close()
      return Promise.resolve()
    },
    isMaximized: () => bridge.isMaximized(),
    onMaximizedChange: (listener) => bridge.onMaximizedChange(listener),
  }
}

/** The desktop shell hosting this page, or null in a plain browser. */
export function getDesktopShell(): DesktopShell | null {
  if (isTauri()) return { kind: 'tauri', controls: tauriControls() }
  const bridge = typeof window === 'undefined' ? undefined : window.deniaDesktop?.window
  if (!bridge) return null
  return { kind: 'electron', controls: electronControls(bridge) }
}