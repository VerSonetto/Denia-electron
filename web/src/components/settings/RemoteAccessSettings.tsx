/**
 * 远程访问设置页。
 *
 * 三块内容对应三件事:能不能连上(监听开关)、怎么进来(一次性配对)、
 * 谁进来过(设备台账)。凭证只在这一页出现一次 —— 配对码与链接由服务端
 * 生成后立刻只留摘要,所以「再显示一次」这件事在协议上就不存在。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import * as api from '../../api'
import { t } from '../../i18n'
import type { RemotePairingCreated, RemoteStatusView } from '../../types'
import { PairingQr } from '../PairingQr'
import { SetmActions, SetmBtn, SetmCard } from './setm'
import styles from './RemoteAccessSettings.module.css'

const POLL_MS = 2000

/** 三块内容都默认展开:这一页没有长到需要折叠,折叠反而多一次点击。 */
function Card({ title, hint, summary, children }: {
  title: string
  hint?: string
  summary?: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(true)
  return (
    <SetmCard title={title} hint={hint} summary={summary} open={open} onToggle={() => setOpen((v) => !v)}>
      {children}
    </SetmCard>
  )
}

function formatTime(iso: string | null): string {
  if (!iso) return t('remoteNever')
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return t('remoteNever')
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `${y}-${m}-${d} ${hh}:${mm}`
}

export function RemoteAccessSettings() {
  const [status, setStatus] = useState<RemoteStatusView | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // 端口/地址草稿:只有用户改过才提交,避免每次轮询覆盖输入框。
  const [portDraft, setPortDraft] = useState('')
  const [publicUrlDraft, setPublicUrlDraft] = useState('')
  const [portDirty, setPortDirty] = useState(false)

  const [pairing, setPairing] = useState<RemotePairingCreated | null>(null)
  const [copied, setCopied] = useState(false)
  const [creating, setCreating] = useState(false)
  const pairingIdRef = useRef<string | null>(null)

  const apply = useCallback((next: RemoteStatusView) => {
    setStatus(next)
    if (!portDirty) setPortDraft(String(next.listenPort))
    setPublicUrlDraft(next.publicUrl ?? '')
  }, [portDirty])

  const refresh = useCallback(async () => {
    try {
      const next = await api.getRemoteStatus()
      apply(next)
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [apply])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // 有配对在进行时才轮询:见到它从 pending 消失,就说明被兑换(或过期)。
  useEffect(() => {
    if (!pairing || !pairingIdRef.current) return
    const id = pairingIdRef.current
    const timer = window.setInterval(() => {
      void api.getRemoteStatus()
        .then((next) => {
          apply(next)
          const stillPending = (next.pending ?? []).some((entry) => entry.id === id)
          if (!stillPending) {
            setPairing(null)
            pairingIdRef.current = null
          }
        })
        .catch(() => {
          // 轮询失败不打断当前页面。
        })
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [pairing, apply])

  const toggle = useCallback(async (enable: boolean) => {
    setBusy(true)
    setError('')
    try {
      const port = Number(portDraft)
      const next = enable
        ? await api.enableRemote({
          listenPort: Number.isInteger(port) && port > 0 ? port : undefined,
          publicUrl: publicUrlDraft.trim() || undefined,
        })
        : await api.disableRemote()
      setPortDirty(false)
      apply(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [apply, portDraft, publicUrlDraft])

  const createPairing = useCallback(async () => {
    setCreating(true)
    setError('')
    setCopied(false)
    try {
      const created = await api.createRemotePairing({ allowedKinds: ['mobile', 'desktop', 'browser'] })
      pairingIdRef.current = created.pairing.id
      setPairing(created)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setCreating(false)
    }
  }, [refresh])

  const cancelPairing = useCallback(async () => {
    if (!pairing) return
    try {
      await api.cancelRemotePairing(pairing.pairing.id)
    } catch {
      // 已经过期或已兑换,本地收掉即可。
    }
    pairingIdRef.current = null
    setPairing(null)
    await refresh()
  }, [pairing, refresh])

  const copyLink = useCallback(async () => {
    if (!pairing) return
    try {
      await navigator.clipboard.writeText(pairing.link)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setError(t('remoteCopyFailed'))
    }
  }, [pairing])

  const revoke = useCallback(async (id: string) => {
    try {
      await api.revokeRemoteClient(id)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [refresh])

  const purge = useCallback(async () => {
    try {
      await api.purgeRemoteClients()
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [refresh])

  const clients = status?.clients ?? []
  const active = clients.filter((client) => !client.revokedAt)
  const revokedCount = clients.length - active.length
  const addresses = useMemo(() => status?.addresses.lan ?? [], [status])

  return (
    <div className={styles.wrap}>
      {error && <p className={styles.error} role="alert">{error}</p>}

      <Card
        title={t('remoteAccessTitle')}
        hint={t('remoteAccessHint')}
        summary={status?.enabled
          ? (status.listening ? t('remoteStatusOn') : t('remoteStatusError'))
          : t('remoteStatusOff')}
      >
        <div className={styles.grid}>
          <label className={styles.field}>
            <span className={styles.label}>{t('remoteListenPort')}</span>
            <input
              className={styles.input}
              value={portDraft}
              inputMode="numeric"
              disabled={status?.enabled}
              onChange={(event) => {
                setPortDraft(event.target.value.replace(/[^0-9]/g, ''))
                setPortDirty(true)
              }}
            />
            <span className={styles.hint}>{t('remoteListenPortHint')}</span>
          </label>
          <label className={styles.field}>
            <span className={styles.label}>{t('remotePublicUrl')}</span>
            <input
              className={styles.input}
              value={publicUrlDraft}
              placeholder="https://denia.example.com"
              onChange={(event) => setPublicUrlDraft(event.target.value)}
            />
            <span className={styles.hint}>{t('remotePublicUrlHint')}</span>
          </label>
        </div>

        {status?.listenerError && <p className={styles.error}>{status.listenerError}</p>}

        <SetmActions>
          {status?.enabled
            ? (
              <>
                <SetmBtn variant="danger" disabled={busy} onClick={() => void toggle(false)}>
                  {t('remoteDisable')}
                </SetmBtn>
                <SetmBtn variant="ghost" disabled={busy} onClick={() => void toggle(true)}>
                  {t('remoteReapply')}
                </SetmBtn>
              </>
            )
            : (
              <SetmBtn disabled={busy} onClick={() => void toggle(true)}>
                {t('remoteEnable')}
              </SetmBtn>
            )}
        </SetmActions>

        {status?.enabled && (
          <div className={styles.addresses}>
            <span className={styles.label}>{t('remoteAddresses')}</span>
            {addresses.length === 0 && status.publicUrl === null
              ? <span className={styles.hint}>{t('remoteNoAddress')}</span>
              : (
                <ul className={styles.addressList}>
                  {status.publicUrl && <li><code>{status.publicUrl}</code></li>}
                  {addresses.map((url) => <li key={url}><code>{url}</code></li>)}
                </ul>
              )}
          </div>
        )}
      </Card>

      <Card
        title={t('remotePairingTitle')}
        hint={t('remotePairingHint')}
        summary={pairing ? t('remotePairingWaiting') : t('remotePairingIdle')}
      >
        {!pairing && (
          <SetmActions>
            <SetmBtn disabled={creating || !status?.enabled} onClick={() => void createPairing()}>
              {t('remotePairingCreate')}
            </SetmBtn>
            {!status?.enabled && <span className={styles.hint}>{t('remotePairingNeedEnable')}</span>}
          </SetmActions>
        )}

        {pairing && (
          <div className={styles.pairing}>
            <div className={styles.pairingTop}>
              <PairingQr value={pairing.link} size={188} className={styles.qr} />
              <div className={styles.pairingInfo}>
                <div>
                  <span className={styles.label}>{t('remotePairingCode')}</span>
                  <div className={styles.code}>{pairing.code.replace(/(.{4})(.{4})/, '$1-$2')}</div>
                </div>
                <div>
                  <span className={styles.label}>{t('remotePairingFingerprint')}</span>
                  <div className={styles.fingerprint}>{pairing.pairing.fingerprint}</div>
                </div>
                <p className={styles.hint}>{t('remotePairingScanHint')}</p>
                <p className={styles.hint}>{t('remotePairingCodeHint')}</p>
              </div>
            </div>

            <span className={styles.label}>{t('remotePairingLink')}</span>
            <textarea className={styles.link} readOnly value={pairing.link} rows={3} />
            <SetmActions>
              <SetmBtn small variant="ghost" onClick={() => void copyLink()}>
                {copied ? t('remotePairingCopied') : t('remotePairingCopy')}
              </SetmBtn>
              <SetmBtn small variant="ghost" onClick={() => void cancelPairing()}>
                {t('remotePairingCancel')}
              </SetmBtn>
            </SetmActions>
            <p className={styles.hint}>
              {t('remotePairingExpires').replace('{time}', formatTime(pairing.pairing.expiresAt))}
            </p>
          </div>
        )}
      </Card>

      <Card
        title={t('remoteDevices')}
        hint={t('remoteDevicesHint')}
        summary={t('remoteDevicesCount').replace('{count}', String(active.length))}
      >
        {clients.length === 0
          ? <p className={styles.empty}>{t('remoteDevicesEmpty')}</p>
          : (
            <ul className={styles.devices}>
              {clients.map((client) => (
                <li key={client.id} className={client.revokedAt ? styles.revoked : undefined}>
                  <div className={styles.deviceMain}>
                    <span className={styles.deviceName}>{client.label}</span>
                    <span className={styles.deviceMeta}>
                      {[client.devicePlatform ?? client.clientKind, client.deviceName]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </div>
                  <span className={styles.deviceTime}>{formatTime(client.lastUsedAt)}</span>
                  {client.revokedAt
                    ? <span className={styles.badge}>{t('remoteRevoked')}</span>
                    : (
                      <SetmBtn small variant="danger" onClick={() => void revoke(client.id)}>
                        {t('remoteRevoke')}
                      </SetmBtn>
                    )}
                </li>
              ))}
            </ul>
          )}
        {revokedCount > 0 && (
          <SetmActions>
            <SetmBtn small variant="ghost" onClick={() => void purge()}>
              {t('remotePurge')}
            </SetmBtn>
          </SetmActions>
        )}
      </Card>

      <p className={styles.foot}>{t('remoteFoot')}</p>
    </div>
  )
}
