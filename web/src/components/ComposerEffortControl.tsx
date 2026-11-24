import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import * as Slider from '@radix-ui/react-slider'
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion, useTransform } from 'motion/react'
import { t } from '../i18n'
import { REASONING_EFFORT_OFF, reasoningEffortRank } from '../modelCatalog'
import { reasoningEffortLabel } from '../reasoningEffort'
import { useClampedPopover } from '../hooks/useClampedPopover'
import type { ReasoningEffortInfo } from '../types'
import { EffortMaxFill } from './EffortMaxFill'

const BURST_POINTS = [
  [-3, -34], [15, -29], [30, -19], [34, -2], [30, 16], [15, 30],
  [-5, 35], [-24, 27], [-34, 10], [-33, -13], [-22, -27], [7, -24],
  [24, -9], [20, 10], [-9, 21], [-25, -5],
]

/**
 * 最高档填充里向右漂流的微粒。`speed` 是穿过整条填充的时长，`delay` 取负数
 * 把起始相位错开，浮层一打开整条轨道就已经铺满粒子；`bob` 是各自的上下摆动幅度，
 * 让相邻轨道不会同步起伏。
 */
const FLOW_PARTICLES = [
  { lane: 26, size: 2.6, speed: 2.9, delay: -0.2, bob: 1.3, peak: 0.9 },
  { lane: 58, size: 1.7, speed: 4.4, delay: -2.3, bob: 1.9, peak: 0.55 },
  { lane: 36, size: 3.1, speed: 3.6, delay: -1.0, bob: 1.1, peak: 1 },
  { lane: 72, size: 2.0, speed: 5.1, delay: -3.6, bob: 2.2, peak: 0.5 },
  { lane: 46, size: 1.5, speed: 2.6, delay: -2.2, bob: 0.9, peak: 0.75 },
  { lane: 18, size: 2.2, speed: 3.3, delay: -1.3, bob: 1.6, peak: 0.65 },
  { lane: 80, size: 2.5, speed: 4.8, delay: -0.9, bob: 1.4, peak: 0.85 },
  { lane: 52, size: 2.8, speed: 3.9, delay: -2.5, bob: 2.1, peak: 0.7 },
  { lane: 30, size: 1.4, speed: 3.1, delay: -1.0, bob: 0.8, peak: 0.95 },
  { lane: 66, size: 2.3, speed: 4.2, delay: -0.4, bob: 1.5, peak: 0.6 },
  { lane: 42, size: 2.9, speed: 5.3, delay: -4.1, bob: 1.8, peak: 0.55 },
  { lane: 22, size: 1.8, speed: 3.7, delay: -1.7, bob: 1.2, peak: 0.8 },
  { lane: 62, size: 1.9, speed: 2.8, delay: -2.6, bob: 0.9, peak: 0.7 },
  { lane: 76, size: 1.5, speed: 4.6, delay: -1.2, bob: 1.7, peak: 0.9 },
]

/** 档位保持模型目录的顺序；只有关闭浮层时才更新会话配置。 */
export function ComposerEffortControl({ efforts, value, disabled, onChange }: {
  efforts: ReasoningEffortInfo[]
  value: string
  disabled?: boolean
  onChange: (effort: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState(value)
  const [dragging, setDragging] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [keyboardFocused, setKeyboardFocused] = useState(false)
  const [burst, setBurst] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const chipRef = useRef<HTMLButtonElement>(null)
  // 浮层夹取:分屏窗格窄时,贴 chip 展开的浮层会被窗格裁掉(见 hook 注释)。
  const popoverRef = useRef<HTMLDivElement>(null)
  const popoverStyle = useClampedPopover({ anchorRef: rootRef, popoverRef, open, align: 'left' })
  const thumbRef = useRef<HTMLSpanElement>(null)
  const draftRef = useRef(value)
  const dragStartRef = useRef(value)
  const wheelRef = useRef({ delta: 0, time: 0 })
  const latestRef = useRef({ efforts, value, disabled, onChange })
  latestRef.current = { efforts, value, disabled, onChange }
  const dialogId = useId()
  const descriptionId = useId()
  const reduceMotion = useReducedMotion() ?? false
  const maxIndex = Math.max(0, efforts.length - 1)
  const index = Math.max(0, efforts.findIndex((effort) => effort.id === (open ? preview : value)))
  const shown = efforts[index]
  const off = shown?.id === REASONING_EFFORT_OFF
  const atMax = maxIndex > 0 && index === maxIndex && !off
  const label = reasoningEffortLabel(shown?.id ?? value)
  // 竖线颜色按绝对强度等级映射(off=0 … max=5),跨模型的同一档位颜色一致。
  const rank = reasoningEffortRank(shown?.id ?? value)
  const description = shown?.description?.trim()
  const effortIds = efforts.map((effort) => effort.id).join('\0')
  const percentage = maxIndex > 0 ? index / maxIndex * 100 : 0
  const progress = useMotionValue(percentage)
  // 与原版一致的半径补偿：28px 滑块在轨道两端各超出 1px。
  const thumbCenter = useTransform(progress, (percent) => `calc(${percent}% + ${13 - percent * 0.26}px)`)

  const updatePreview = (id: string) => {
    const latest = latestRef.current
    const next = latest.efforts.findIndex((effort) => effort.id === id)
    if (latest.disabled || next < 0 || id === draftRef.current) return
    if (next === latest.efforts.length - 1 && id !== REASONING_EFFORT_OFF) setBurst((previous) => previous + 1)
    draftRef.current = id
    setPreview(id)
  }

  const close = (commit: boolean, restoreFocus = true) => {
    const latest = latestRef.current
    const candidate = latest.efforts.find((effort) => effort.id === draftRef.current)
    setOpen(false)
    setDragging(false)
    setHovered(false)
    if (commit && !latest.disabled && candidate && candidate.id !== latest.value) latest.onChange(candidate.id)
    else { draftRef.current = latest.value; setPreview(latest.value) }
    if (restoreFocus) chipRef.current?.focus({ preventScroll: true })
  }

  useEffect(() => {
    draftRef.current = value
    setPreview(value)
    setDragging(false)
  }, [value, effortIds])

  useEffect(() => {
    if (!disabled) return
    setOpen(false)
    draftRef.current = latestRef.current.value
    setPreview(latestRef.current.value)
    setDragging(false)
    setHovered(false)
  }, [disabled])

  useEffect(() => {
    wheelRef.current = { delta: 0, time: 0 }
    if (!open) return
    // 等 Radix 完成 Thumb 注册，再聚焦；否则首个方向键可能读到未注册的索引。
    const frame = requestAnimationFrame(() => thumbRef.current?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(frame)
  }, [open])

  useEffect(() => {
    if (!open || reduceMotion) { progress.jump(percentage); return }
    const animation = animate(progress, percentage, {
      duration: dragging ? 0.15 : 0.3, ease: [0.23, 1, 0.32, 1],
    })
    return () => animation.stop()
  }, [progress, percentage, dragging, open, reduceMotion])

  // 非 passive 监听阻止浮层滚轮同时滚动聊天记录。
  useEffect(() => {
    if (!open) return
    const slider = rootRef.current?.querySelector<HTMLElement>('.effort-slider')
    if (!slider) return
    const onWheel = (event: WheelEvent) => {
      const latest = latestRef.current
      if (event.ctrlKey || latest.disabled || latest.efforts.length < 2) return
      event.preventDefault()
      event.stopPropagation()
      let delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : -event.deltaY
      if ('webkitDirectionInvertedFromDevice' in event && event.webkitDirectionInvertedFromDevice) delta *= -1
      if (event.deltaMode !== 0) delta = Math.sign(delta) * 30
      if (!delta) return
      const wheel = wheelRef.current
      if (event.timeStamp - wheel.time > 160 || Math.sign(delta) !== Math.sign(wheel.delta)) wheel.delta = 0
      wheel.time = event.timeStamp
      wheel.delta += delta
      if (Math.abs(wheel.delta) < 30) return
      const direction = Math.sign(wheel.delta)
      wheel.delta -= direction * 30
      const current = Math.max(0, latest.efforts.findIndex((effort) => effort.id === draftRef.current))
      const next = Math.min(latest.efforts.length - 1, Math.max(0, current + direction))
      if (next === current) wheel.delta = 0
      updatePreview(latest.efforts[next].id)
    }
    slider.addEventListener('wheel', onWheel, { passive: false })
    return () => slider.removeEventListener('wheel', onWheel)
  }, [open])

  if (maxIndex === 0) {
    return <div className="effort-control">
      <span className={`effort-chip-static${off ? ' off' : ''}`} title={off ? t('effortControlOffHint') : label}>
        <span className="effort-meter" data-rank={rank} aria-hidden="true" />
      </span>
    </div>
  }

  return (
    <div
      className={`effort-control${open ? ' open' : ''}`} ref={rootRef}
      onBlur={(event) => {
        if (open && event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) close(true, false)
      }}
      onKeyDown={(event) => {
        if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(false) }
      }}
    >
      <button
        ref={chipRef} type="button"
        className={`effort-chip${open ? ' open' : ''}${off ? ' off' : ''}`}
        disabled={disabled} aria-haspopup="dialog" aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        aria-label={`${t('effortControlHint')}: ${label}`}
        title={off ? t('effortControlOffHint') : t('effortControlHint')}
        onClick={() => {
          if (open) { close(true); return }
          draftRef.current = value
          setPreview(value)
          setBurst(0)
          setOpen(true)
        }}
      >
        <span className="effort-meter" data-rank={rank} aria-hidden="true" />
      </button>
      {open && <>
        <div className="menu-backdrop" onClick={() => close(true)} />
        <div className="effort-popover" id={dialogId} role="dialog" aria-label={t('effortControlHint')} ref={popoverRef} style={popoverStyle}>
          <div className="effort-popover-head">
            <span className="effort-popover-value">{label}</span>
            <span className="effort-popover-title">{t('reasoningLabel')}</span>
          </div>
          <div className="effort-slider-container" data-keyboard-focused={keyboardFocused}>
            <Slider.Root
              className="effort-slider" dir="ltr" min={0} max={maxIndex} step={1} value={[index]} disabled={disabled}
              data-max={atMax} data-off={off} data-dragging={dragging} data-reduced-motion={reduceMotion}
              onValueChange={([next]) => { if (efforts[next]) updatePreview(efforts[next].id) }}
              onKeyDown={(event) => event.stopPropagation()}
              onPointerDown={(event) => {
                if (event.button !== 0 || disabled) { event.preventDefault(); return }
                dragStartRef.current = draftRef.current
                setKeyboardFocused(false)
                setDragging(true)
              }}
              onPointerUp={() => setDragging(false)}
              onLostPointerCapture={() => setDragging(false)}
              onPointerCancel={() => {
                draftRef.current = dragStartRef.current
                setPreview(dragStartRef.current)
                setDragging(false)
              }}
            >
              <Slider.Track className="effort-track">
                {/* 填充只到圆钮中心，直角端面始终由圆钮遮住；两者共用同一动画值。 */}
                <motion.span className="effort-range" style={{ width: thumbCenter }}>
                  <AnimatePresence>
                    {atMax && <motion.span key="max-fill" className="effort-max-effects"
                      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                      transition={{ duration: reduceMotion ? 0 : 0.3 }}>
                      <EffortMaxFill reducedMotion={reduceMotion} reveal={burst > 0} />
                      {!reduceMotion && <span className="effort-particles" aria-hidden="true">
                        {FLOW_PARTICLES.map((particle, at) => <span className="effort-particle" key={at} style={{
                          '--particle-lane': `${particle.lane}%`,
                          '--particle-size': `${particle.size}px`,
                          '--particle-speed': `${particle.speed}s`,
                          '--particle-delay': `${particle.delay}s`,
                          '--particle-bob': `${particle.bob}px`,
                          '--particle-peak': particle.peak,
                        } as CSSProperties}>
                          <span />
                        </span>)}
                      </span>}
                    </motion.span>}
                  </AnimatePresence>
                </motion.span>
                <span className="effort-tick-rail" aria-hidden="true">
                  {efforts.map((effort, at) => {
                    const percent = at / maxIndex * 100
                    return <span key={effort.id} className="effort-tick" data-selected={at <= index}
                      title={reasoningEffortLabel(effort.id)}
                      style={{ left: `calc(${percent}% + ${13 - percent * 0.26}px)` }} />
                  })}
                </span>
              </Slider.Track>
              <span className="effort-visual-rail" aria-hidden="true">
                <motion.span className="effort-knob-position" style={{ left: thumbCenter }}>
                  {atMax && burst > 0 && !reduceMotion && <span className="effort-max-burst" key={burst}>
                    {BURST_POINTS.map(([x, y], at) => <span key={at} style={{ '--particle-x': `${x}px`, '--particle-y': `${y}px`, animationDelay: `${at % 4 * 4}ms` } as CSSProperties} />)}
                  </span>}
                  <motion.span className="effort-knob-spring" initial={false}
                    animate={{ scale: !reduceMotion && (hovered || dragging) ? 32 / 28 : 1 }}
                    transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: hovered || dragging ? 420 : 220, damping: hovered || dragging ? 38 : 26, mass: 1 }}>
                    <span className="effort-knob" />
                  </motion.span>
                </motion.span>
              </span>
              <Slider.Thumb
                ref={thumbRef} className="effort-input" aria-label={t('effortSliderAria')} aria-valuetext={label}
                aria-describedby={description ? descriptionId : undefined}
                onFocus={(event) => setKeyboardFocused(event.currentTarget.matches(':focus-visible'))}
                onBlur={() => setKeyboardFocused(false)}
                onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === 'Escape') {
                    event.preventDefault(); event.stopPropagation(); close(event.key === 'Enter')
                  }
                  if (event.key.startsWith('Arrow') || ['Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) setKeyboardFocused(true)
                }}
              />
            </Slider.Root>
          </div>
          <span className="effort-announcement" role="status" aria-live="polite">
            {t('effortSliderStatus', { value: label, position: index + 1, total: efforts.length })}
          </span>
          {description && <div className="effort-popover-desc" id={descriptionId}>{description}</div>}
        </div>
      </>}
    </div>
  )
}
