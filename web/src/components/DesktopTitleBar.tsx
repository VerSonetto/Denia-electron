import { useEffect, useState } from 'react'
import { getDesktopShell } from '../desktopWindow'
import { t } from '../i18n'
import {
  IconClose,
  IconWindowMaximize,
  IconWindowMinimize,
  IconWindowRestore,
} from './icons'

/**
 * 桌面壳(Tauri / Electron)的窗口条。
 *
 * ## 为什么它不是"通栏标题栏"
 *
 * 最初这一条是通栏的(左侧品牌 + 右侧窗口按钮),结果是**两个 Denia**:
 * 侧栏左上角已经有一个品牌,标题栏再来一个,重复且割裂。
 *
 * 现在把它整条移进**主列内部**(见 `.main > .desktop-titlebar`),于是:
 *
 * - 侧栏从窗口最顶端一直贯到底,成为一条完整的竖带,品牌只有一处(侧栏顶部);
 * - 窗口按钮落在主列上沿,与主列左边界对齐,不跨到侧栏上方去;
 * - 窗口拖动区只覆盖主列顶部,侧栏顶部的品牌区不参与拖动 —— 那里要能点。
 *
 * 浏览器形态不渲染它,避免把桌面窗口语义带过去。
 */
export function DesktopTitleBar() {
  const [shell] = useState(() => getDesktopShell())
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    if (!shell) return

    let disposed = false
    const { controls } = shell
    const sync = () => {
      void controls
        .isMaximized()
        .then((value) => {
          if (!disposed) setMaximized(value)
        })
        .catch(() => {})
    }

    sync()
    const unsubscribe = controls.onMaximizedChange((value) => {
      if (!disposed) setMaximized(value)
    })

    return () => {
      disposed = true
      unsubscribe()
    }
  }, [shell])

  if (!shell) return null

  const { controls } = shell
  const toggleMaximize = () => {
    void controls.toggleMaximize().catch(() => {})
  }

  return (
    <header className="desktop-titlebar" data-shell={shell.kind} aria-label={t('titleBarLabel')}>
      {/* 拖动区:主列顶部整条。Tauri 用 `data-tauri-drag-region="deep"` ——
          裸属性只认「直接点在自己身上」(`el === composedPath[0]`),点在子元素
          上不拖,`deep` 让整棵子树可拖。Electron 侧由 `[data-shell='electron']`
          的 `-webkit-app-region: drag` 接管。

          双击最大化**不在这里挂 onDoubleClick**:两个壳都由系统/壳层自己响应
          拖动区的双击,再挂一次就会双击一下切换两次、净效果为零(看起来就是
          双击没反应)。 */}
      <div className="desktop-titlebar-drag" data-tauri-drag-region="deep" />
      <div className="desktop-titlebar-actions">
        <button
          type="button"
          className="desktop-window-btn"
          aria-label={t('titleBarMinimize')}
          title={t('titleBarMinimize')}
          onClick={() => void controls.minimize().catch(() => {})}
        >
          <IconWindowMinimize size={15} />
        </button>
        <button
          type="button"
          className="desktop-window-btn"
          aria-label={maximized ? t('titleBarRestore') : t('titleBarMaximize')}
          title={maximized ? t('titleBarRestore') : t('titleBarMaximize')}
          onClick={toggleMaximize}
        >
          {maximized ? <IconWindowRestore size={15} /> : <IconWindowMaximize size={15} />}
        </button>
        <button
          type="button"
          className="desktop-window-btn close"
          aria-label={t('titleBarClose')}
          title={t('titleBarClose')}
          onClick={() => void controls.close().catch(() => {})}
        >
          <IconClose size={16} />
        </button>
      </div>
    </header>
  )
}