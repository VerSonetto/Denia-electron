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
  kind: 'electron'
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
    /** Injected by the Electron preload; absent in browsers. */
    deniaDesktop?: { kind: 'electron'; window: ElectronWindowBridge }
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

/** The Electron shell hosting this page, or null in a plain browser. */
export function getDesktopShell(): DesktopShell | null {
  const bridge = typeof window === 'undefined' ? undefined : window.deniaDesktop?.window
  if (!bridge) return null
  return { kind: 'electron', controls: electronControls(bridge) }
}