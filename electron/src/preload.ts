import { contextBridge, ipcRenderer } from 'electron'

/**
 * Renderer bridge for the frameless window.
 *
 * Keep the surface minimal: the page only needs the three caption actions plus
 * the maximized state. The main process resolves the target window from the
 * sender, so no window ids cross the boundary.
 */
contextBridge.exposeInMainWorld('deniaDesktop', {
  kind: 'electron',
  window: {
    minimize: () => ipcRenderer.send('desktop-window:minimize'),
    toggleMaximize: () => ipcRenderer.send('desktop-window:toggle-maximize'),
    close: () => ipcRenderer.send('desktop-window:close'),
    isMaximized: () => ipcRenderer.invoke('desktop-window:is-maximized') as Promise<boolean>,
    onMaximizedChange: (listener: (maximized: boolean) => void) => {
      const handler = (_event: unknown, maximized: boolean) => listener(maximized)
      ipcRenderer.on('desktop-window:maximized', handler)
      return () => {
        ipcRenderer.removeListener('desktop-window:maximized', handler)
      }
    },
  },
})