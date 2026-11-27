/**
 * 远程访问设置页。
 *
 * 正常用户只做两件事：开启、关闭。开启后自动准备私有中继并生成一次性二维码；
 * 配对完成后二维码自动换新。端口、隧道、设备台账等仍然存在，但收进「高级设置」，
 * 不把实现细节变成使用门槛。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import * as api from '../../api'
import { t } from '../../i18n'
import type { RemotePairingCreated, RemoteStatusView } from '../../types'
import { IconChevronDown } from '../icons'
import { PairingQr } from '../PairingQr'
import { SetmActions, SetmBtn } from './setm'
import styles from './RemoteAccessSettings.module.css'

const POLL_MS = 2000

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

function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = String(total % 60).padStart(2, '0')
  return `${minutes}:${seconds}`
}

function AdvancedSection({
  title,
  hint,
  children,
}: {
  title: string
  hint?: string
  children: ReactNode
}) {
  return (
    <section className={styles.advancedSection}>
      <div className={styles.advancedSectionHead}>
        <h4>{title}</h4>
        {hint && <p>{hint}</p>}
      </div>
      {children}
    </section>
  )
}

function PhoneGlyph() {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect
        x="6"
        y="2.5"
        width="12"
        height="19"
        rx="3"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M10 5.5h4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M9 9h6M9 12h6M9 15h3.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        opacity=".55"
      />
    </svg>
  )
}

export function RemoteAccessSettings() {
  const [status, setStatus] = useState<RemoteStatusView | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [pairing, setPairing] = useState<RemotePairingCreated | null>(null)
  const [creating, setCreating] = useState(false)
  const [copied, setCopied] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [advanced, setAdvanced] = useState(false)

  const [portDraft, setPortDraft] = useState('')
  const [publicUrlDraft, setPublicUrlDraft] = useState('')
  const [portDirty, setPortDirty] = useState(false)
  const [urlDirty, setUrlDirty] = useState(false)

  const [relayBusy, setRelayBusy] = useState(false)
  const [tunnelBusy, setTunnelBusy] = useState(false)
  const [relayCopied, setRelayCopied] = useState(false)
  const [tunnelCopied, setTunnelCopied] = useState(false)

  const createLock = useRef(false)

  const apply = useCallback((
    next: RemoteStatusView,
    options?: { fresh?: boolean },
  ) => {
    setStatus(next)
    if (options?.fresh || !portDirty) setPortDraft(String(next.listenPort))
    if (options?.fresh || !urlDirty) setPublicUrlDraft(next.publicUrl ?? '')
  }, [portDirty, urlDirty])

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

  // Pairing is one-time and expires. When it is consumed or expires, the effect
  // below creates a fresh one; this timer only drives the countdown label.
  useEffect(() => {
    if (!pairing) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [pairing])

  useEffect(() => {
    if (!pairing) return
    let cancelled = false
    const tick = async () => {
      try {
        const next = await api.getRemoteStatus()
        if (cancelled) return
        apply(next)
        const current = pairing.pairing
        const stillPending = (next.pending ?? []).some((entry) => entry.id === current.id)
        const expires = Date.parse(current.expiresAt)
        const expired = !Number.isFinite(expires) || expires <= Date.now()
        if (!next.enabled || !stillPending || expired) {
          setPairing(null)
          if (stillPending && expired) {
            void api.cancelRemotePairing(current.id).catch(() => {})
          }
        }
      } catch {
        // A transient status read does not invalidate the displayed pairing.
      }
    }
    const timer = window.setInterval(() => void tick(), POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [pairing, apply])

  const createPairing = useCallback(async () => {
    if (createLock.current) return
    createLock.current = true
    setCreating(true)
    setError('')
    setCopied(false)
    try {
      const created = await api.createRemotePairing({
        allowedKinds: ['mobile', 'desktop', 'browser'],
      })
      setPairing(created)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      createLock.current = false
      setCreating(false)
    }
  }, [])

  // No "generate code" button in the normal flow: an enabled, listening host
  // always has a current QR ready.
  useEffect(() => {
    if (
      !status?.enabled ||
      !status.listening ||
      busy ||
      preparing ||
      relayBusy ||
      tunnelBusy ||
      pairing ||
      creating ||
      error
    ) return
    const timer = window.setTimeout(() => void createPairing(), 180)
    return () => window.clearTimeout(timer)
  }, [
    status?.enabled,
    status?.listening,
    busy,
    preparing,
    relayBusy,
    tunnelBusy,
    pairing,
    creating,
    error,
    createPairing,
  ])

  const resetPairing = useCallback(async () => {
    const current = pairing
    setPairing(null)
    if (!current) return
    try {
      await api.cancelRemotePairing(current.pairing.id)
    } catch {
      // Expired or already redeemed.
    }
  }, [pairing])

  const toggle = useCallback(async (enable: boolean) => {
    if (busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      if (!enable) {
        setPreparing(false)
        await resetPairing()
        apply(await api.disableRemote())
        return
      }

      setPreparing(true)
      let next = await api.enableRemote({
        listenPort: Number(portDraft) > 0 ? Number(portDraft) : undefined,
        publicUrl: publicUrlDraft.trim() || undefined,
      })
      setPortDirty(false)
      setUrlDirty(false)
      apply(next, { fresh: true })

      // One click should also make the phone work away from home. The relay is
      // best-effort: if Cloudflare is unavailable, the QR still falls back to
      // LAN/direct candidates and the state pill says so.
      if (next.relay && next.relay.state !== 'running') {
        try {
          next = await api.startRemoteRelay()
          apply(next, { fresh: true })
        } catch {
          setNotice(t('remoteSimpleRelayFallback'))
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
      setPreparing(false)
    }
  }, [busy, portDraft, publicUrlDraft, apply, resetPairing])

  const reapply = useCallback(async () => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await resetPairing()
      const next = await api.enableRemote({
        listenPort: Number(portDraft) > 0 ? Number(portDraft) : undefined,
        publicUrl: publicUrlDraft.trim() || undefined,
      })
      setPortDirty(false)
      setUrlDirty(false)
      apply(next, { fresh: true })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [portDraft, publicUrlDraft, apply, resetPairing])

  const startRelay = useCallback(async () => {
    setRelayBusy(true)
    setError('')
    setNotice('')
    try {
      const next = await api.startRemoteRelay()
      apply(next)
      await resetPairing()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setRelayBusy(false)
    }
  }, [apply, resetPairing])

  const stopRelay = useCallback(async () => {
    setRelayBusy(true)
    setError('')
    setNotice('')
    try {
      const next = await api.stopRemoteRelay()
      apply(next)
      await resetPairing()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setRelayBusy(false)
    }
  }, [apply, resetPairing])

  const startTunnel = useCallback(async () => {
    setTunnelBusy(true)
    setError('')
    setNotice('')
    try {
      const next = await api.startRemoteTunnel()
      apply(next)
      await resetPairing()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setTunnelBusy(false)
    }
  }, [apply, resetPairing])

  const stopTunnel = useCallback(async () => {
    setTunnelBusy(true)
    setError('')
    setNotice('')
    try {
      const next = await api.stopRemoteTunnel()
      apply(next)
      await resetPairing()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setTunnelBusy(false)
    }
  }, [apply, resetPairing])

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

  const copyRelayUrl = useCallback(async (url: string) => {
    try {
      await navigator.clipboard.writeText(url)
      setRelayCopied(true)
      window.setTimeout(() => setRelayCopied(false), 1600)
    } catch {
      setError(t('remoteCopyFailed'))
    }
  }, [])

  const copyTunnelUrl = useCallback(async (url: string) => {
    try {
      await navigator.clipboard.writeText(url)
      setTunnelCopied(true)
      window.setTimeout(() => setTunnelCopied(false), 1600)
    } catch {
      setError(t('remoteCopyFailed'))
    }
  }, [])

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
  const activeClients = clients.filter((client) => !client.revokedAt)
  const revokedCount = clients.length - activeClients.length
  const addresses = useMemo(() => status?.addresses.lan ?? [], [status])
  const relay = status?.relay ?? null
  const relayState = relay?.state ?? 'disabled'
  const tunnel = status?.tunnel ?? null
  const tunnelState = tunnel?.state ?? 'idle'

  // Let the advanced cards reflect background producer progress without a
  // page reload.
  useEffect(() => {
    if (
      relayState !== 'starting' &&
      tunnelState !== 'starting' &&
      !relayBusy &&
      !tunnelBusy
    ) return
    const timer = window.setInterval(() => void refresh(), 1500)
    return () => window.clearInterval(timer)
  }, [relayState, tunnelState, relayBusy, tunnelBusy, refresh])

  const listPreparing = preparing || relayState === 'starting'
  const remoteReady = relayState === 'running' || tunnelState === 'running'
  const tone = !status
    ? 'idle'
    : !status.enabled
      ? busy ? 'pending' : 'idle'
      : !status.listening
        ? 'error'
        : listPreparing
          ? 'pending'
          : remoteReady
            ? 'ready'
            : 'limited'
  const stateLabel = !status
    ? '…'
    : !status.enabled
      ? busy ? t('remoteSimplePreparing') : t('remoteSimpleOff')
      : !status.listening
        ? t('remoteSimpleError')
        : listPreparing
          ? t('remoteSimplePreparing')
          : remoteReady
            ? t('remoteSimpleReady')
            : t('remoteSimpleLanOnly')

  const expiresAt = pairing ? Date.parse(pairing.pairing.expiresAt) : 0
  const remaining = pairing ? Math.max(0, expiresAt - now) : 0
  const formattedCode = pairing
    ? pairing.code.replace(/(.{4})(.{4})/, '$1-$2')
    : ''

  return (
    <div className={styles.wrap}>
      <section className={styles.hero}>
        <div className={styles.heroHead}>
          <div className={styles.heroCopy}>
            <h3 className={styles.heroTitle}>{t('remoteSimpleTitle')}</h3>
          </div>
          <span className={styles.statePill} data-tone={tone}>
            <span className={styles.stateDot} />
            {stateLabel}
          </span>
        </div>

        {!status ? (
          <div className={styles.preparing}>
            <span className={styles.spinner} />
            <span>{t('remoteSimpleLoading')}</span>
          </div>
        ) : !status.enabled ? (
          <div className={styles.offPanel}>
            <div className={styles.offMark}><PhoneGlyph /></div>
            <div className={styles.offCopy}>
              <strong>{t('remoteSimpleOffTitle')}</strong>
              <p>{t('remoteSimpleOffHint')}</p>
            </div>
            <button
              type="button"
              className={styles.enableButton}
              disabled={busy}
              onClick={() => void toggle(true)}
            >
              {busy ? <span className={styles.spinner} /> : null}
              {busy ? t('remoteSimplePreparing') : t('remoteEnable')}
            </button>
          </div>
        ) : (
          <div className={styles.onPanel}>
            {status.listening === false ? (
              <div className={styles.errorState}>
                <strong>{t('remoteSimpleError')}</strong>
                <p>{status.listenerError ?? t('remoteSimpleOffHint')}</p>
                <SetmBtn disabled={busy} onClick={() => void toggle(false)}>
                  {t('remoteDisable')}
                </SetmBtn>
              </div>
            ) : listPreparing ? (
              <div className={styles.preparingCard}>
                <span className={styles.spinner} />
                <div>
                  <strong>{t('remoteSimplePreparing')}</strong>
                  <p>{t('remoteSimplePreparingHint')}</p>
                </div>
              </div>
            ) : pairing ? (
              <div className={styles.pairingLayout}>
                <div className={styles.qrColumn}>
                  <div className={styles.qrCard}>
                    <PairingQr value={pairing.link} size={208} />
                  </div>
                  <span className={styles.qrCaption}>{t('remotePairingTitle')}</span>
                </div>
                <div className={styles.pairingDetails}>
                  <div className={styles.codeBlock}>
                    <span className={styles.label}>{t('remotePairingCode')}</span>
                    <div className={styles.code}>{formattedCode}</div>
                  </div>
                  <p className={styles.scanHint}>{t('remoteSimpleScanHint')}</p>
                  <div className={styles.linkRow}>
                    <SetmBtn small variant="ghost" onClick={() => void copyLink()}>
                      {copied ? t('remotePairingCopied') : t('remotePairingCopy')}
                    </SetmBtn>
                    <span className={styles.expiry}>
                      {remaining > 0
                        ? t('remoteSimpleAutoRefresh').replace('{time}', formatCountdown(remaining))
                        : t('remoteSimpleRefreshing')}
                    </span>
                  </div>
                  <div className={styles.fingerprintRow}>
                    <span>{t('remotePairingFingerprint')}</span>
                    <code>{pairing.pairing.fingerprint}</code>
                  </div>
                </div>
              </div>
            ) : (
              <div className={styles.preparingCard}>
                <span className={styles.spinner} />
                <div>
                  <strong>{t('remoteSimpleLoading')}</strong>
                  <p>{t('remotePairingHint')}</p>
                </div>
              </div>
            )}

            <div className={styles.onFooter}>
              <div className={styles.deviceCount}>
                {activeClients.length > 0
                  ? t('remoteSimpleDevices').replace('{count}', String(activeClients.length))
                  : t('remoteSimpleNoDevices')}
              </div>
              <div className={styles.footerRight}>
                <span className={styles.security}>{t('remoteSimpleSecurity')}</span>
                <SetmBtn
                  small
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void toggle(false)}
                >
                  {busy ? t('remoteSimplePreparing') : t('remoteDisable')}
                </SetmBtn>
              </div>
            </div>
          </div>
        )}
      </section>

      {notice && <p className={styles.notice} role="status">{notice}</p>}
      {error && (
        <div className={styles.errorBox} role="alert">
          <span>{error}</span>
          <button
            type="button"
            className={styles.retryButton}
            onClick={() => {
              setError('')
              setPairing(null)
              void refresh()
            }}
          >
            {t('remoteSimpleRetry')}
          </button>
        </div>
      )}

      <button
        type="button"
        className={styles.advancedToggle}
        aria-expanded={advanced}
        onClick={() => setAdvanced((value) => !value)}
      >
        <span className={styles.advancedToggleText}>
          <span>{t('remoteSimpleAdvanced')}</span>
          <small>{t('remoteSimpleAdvancedHint')}</small>
        </span>
        <span className={styles.advancedChevron} data-open={advanced}>
          <IconChevronDown size={14} />
        </span>
      </button>

      {advanced && (
        <div className={styles.advanced}>
          <AdvancedSection
            title={t('remoteAccessTitle')}
            hint={t('remoteAccessHint')}
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
                  onChange={(event) => {
                    setPublicUrlDraft(event.target.value)
                    setUrlDirty(true)
                  }}
                />
                <span className={styles.hint}>{t('remotePublicUrlHint')}</span>
              </label>
            </div>
            {status?.listenerError && <p className={styles.error}>{status.listenerError}</p>}
            {status?.enabled && (
              <SetmActions>
                <SetmBtn disabled={busy} onClick={() => void reapply()}>
                  {t('remoteReapply')}
                </SetmBtn>
              </SetmActions>
            )}
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
          </AdvancedSection>

          <AdvancedSection title={t('remoteRelayTitle')} hint={t('remoteRelayHint')}>
            <div className={styles.advancedStateRow}>
              <span className={styles.advancedState}>{t('remoteRelayTitle')}</span>
              <span className={styles.advancedSummary}>
                {relayState === 'running'
                  ? t('remoteRelayRunning')
                  : relayState === 'starting' || relayBusy
                    ? t('remoteRelayStarting')
                    : relayState === 'error'
                      ? t('remoteRelayError')
                      : t('remoteRelayIdle')}
              </span>
            </div>
            {relay?.relayUrl && relayState === 'running' && (
              <div className={styles.addresses}>
                <ul className={styles.addressList}>
                  <li><code>{relay.relayUrl}</code></li>
                </ul>
                <SetmActions>
                  <SetmBtn small variant="ghost" onClick={() => void copyRelayUrl(relay.relayUrl!)}>
                    {relayCopied ? t('remotePairingCopied') : t('remotePairingCopy')}
                  </SetmBtn>
                </SetmActions>
                <p className={styles.hint}>
                  {t('remoteRelayDevices')}: {relay.serverClients}
                </p>
              </div>
            )}
            {relay?.error && <p className={styles.error}>{relay.error}</p>}
            <SetmActions>
              {relayState === 'running'
                ? (
                  <SetmBtn small variant="ghost" disabled={relayBusy} onClick={() => void stopRelay()}>
                    {t('remoteRelayStop')}
                  </SetmBtn>
                )
                : (
                  <SetmBtn small disabled={relayBusy || !status?.enabled} onClick={() => void startRelay()}>
                    {t('remoteRelayStart')}
                  </SetmBtn>
                )}
              {!status?.enabled && <span className={styles.hint}>{t('remoteRelayNeedsEnable')}</span>}
            </SetmActions>
            <p className={styles.hint}>{t('remoteRelaySecurity')}</p>
          </AdvancedSection>

          <AdvancedSection title={t('remoteTunnelTitle')} hint={t('remoteTunnelHint')}>
            <div className={styles.advancedStateRow}>
              <span className={styles.advancedState}>{t('remoteTunnelTitle')}</span>
              <span className={styles.advancedSummary}>
                {tunnelState === 'running'
                  ? t('remoteTunnelRunning')
                  : tunnelState === 'starting' || tunnelBusy
                    ? t('remoteTunnelStarting')
                    : tunnelState === 'error'
                      ? t('remoteTunnelError')
                      : t('remoteTunnelIdle')}
              </span>
            </div>
            {tunnel?.url && tunnelState === 'running' && (
              <div className={styles.addresses}>
                <ul className={styles.addressList}>
                  <li><code>{tunnel.url}</code></li>
                </ul>
                <SetmActions>
                  <SetmBtn small variant="ghost" onClick={() => void copyTunnelUrl(tunnel.url!)}>
                    {tunnelCopied ? t('remotePairingCopied') : t('remotePairingCopy')}
                  </SetmBtn>
                </SetmActions>
                <p className={styles.hint}>{t('remoteTunnelRandom')}</p>
              </div>
            )}
            {tunnel?.error && <p className={styles.error}>{tunnel.error}</p>}
            <SetmActions>
              {tunnelState === 'running'
                ? (
                  <SetmBtn small variant="ghost" disabled={tunnelBusy} onClick={() => void stopTunnel()}>
                    {t('remoteTunnelStop')}
                  </SetmBtn>
                )
                : (
                  <SetmBtn small disabled={tunnelBusy || !status?.enabled} onClick={() => void startTunnel()}>
                    {t('remoteTunnelStart')}
                  </SetmBtn>
                )}
              {!status?.enabled && <span className={styles.hint}>{t('remoteTunnelNeedsEnable')}</span>}
            </SetmActions>
            <p className={styles.hint}>{t('remoteTunnelSecurity')}</p>
          </AdvancedSection>

          <AdvancedSection
            title={t('remoteDevices')}
            hint={t('remoteDevicesHint')}
          >
            <p className={styles.advancedSummary}>
              {t('remoteDevicesCount').replace('{count}', String(activeClients.length))}
            </p>
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
          </AdvancedSection>

          <p className={styles.foot}>{t('remoteFoot')}</p>
        </div>
      )}
    </div>
  )
}
