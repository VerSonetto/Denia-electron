/**
 * 远程解锁门。
 *
 * 只在「这次请求来自非回环来源、且还没配对」时挡在应用前面。本机打开时
 * 它什么都不渲染,桌面体验一字不变。
 *
 * 为什么不自己判断来源:来源只有服务端知道(它看的是 socket 对端地址),
 * 前端一律以 `/api/remote/status` 的 `local` 为准,避免被伪造的头部带偏。
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'

import * as api from '../api'
import { t } from '../i18n'
import { DeniaWordmark } from './DeniaWordmark'
import styles from './RemoteGate.module.css'

type Phase = 'checking' | 'open' | 'locked' | 'offline'

export function RemoteGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>('checking')
  const [serverLabel, setServerLabel] = useState('')
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let disposed = false
    api
      .getRemoteStatus()
      .then((status) => {
        if (disposed) return
        setServerLabel(status.serverLabel ?? '')
        setPhase(status.local || status.authenticated ? 'open' : 'locked')
      })
      .catch(() => {
        // 连状态都读不到：服务端不可达，交给应用自己的连接提示。
        if (!disposed) setPhase('offline')
      })
    return () => {
      disposed = true
    }
  }, [])

  const submit = useCallback(async () => {
    const value = input.trim()
    if (!value || busy) return
    setBusy(true)
    setError('')
    try {
      // 整条链接原样交给服务端解析；否则按手输短码处理。
      const result = value.toLowerCase().startsWith('denia://')
        ? await api.redeemRemotePairing({ link: value })
        : await api.redeemRemotePairing({ code: value, clientKind: 'browser' })
      if (!result?.ok) throw new Error(t('remoteGateFailed'))
      // 换到正常界面：刷新让启动流程带着新 Cookie 重走一遍，
      // 比在门里手工接上事件流更不容易漏。
      window.location.reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }, [busy, input])

  if (phase === 'open' || phase === 'offline') return <>{children}</>
  if (phase === 'checking') {
    return <div className={styles.screen}><div className={styles.spinner} aria-hidden /></div>
  }

  return (
    <div className={styles.screen}>
      <form
        className={styles.card}
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <div className={styles.brand}>
          <DeniaWordmark />
        </div>
        <h1 className={styles.title}>{t('remoteGateTitle')}</h1>
        <p className={styles.hint}>
          {serverLabel
            ? t('remoteGateHintWithServer').replace('{server}', serverLabel)
            : t('remoteGateHint')}
        </p>
        <label className={styles.label} htmlFor="remote-pairing-input">
          {t('remoteGateCodeLabel')}
        </label>
        <input
          id="remote-pairing-input"
          className={styles.input}
          value={input}
          onChange={(event) => {
            setInput(event.target.value)
            setError('')
          }}
          placeholder="ABCD-EFGH"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          inputMode="text"
          disabled={busy}
        />
        {error && <p className={styles.error} role="alert">{error}</p>}
        <button type="submit" className={styles.submit} disabled={busy || input.trim().length === 0}>
          {busy ? t('remoteGateConnecting') : t('remoteGateConnect')}
        </button>
        <p className={styles.foot}>{t('remoteGateFoot')}</p>
      </form>
    </div>
  )
}
