/**
 * 配对二维码。
 *
 * 二维码必须始终是「白底黑点」——主题是深色时用界面色会把对比度压到手机
 * 扫不出来,所以这里的颜色写死不跟随主题。
 *
 * 渲染成内联 SVG 而不是 canvas:缩放不糊,打印或截图清楚,也不用等图片解码。
 */
import { useMemo } from 'react'

import { buildQrMatrix } from '../lib/qr'

const QUIET_MODULES = 4

export function PairingQr({
  value,
  size = 176,
  className,
}: {
  value: string
  size?: number
  className?: string
}) {
  const matrix = useMemo(() => buildQrMatrix(value), [value])

  if (!matrix) {
    // 内容超出容量时不画半张码——半张码比没有更糟。调用方保留链接可复制。
    return null
  }

  const total = matrix.size + QUIET_MODULES * 2
  // 每个深色模块一条子路径;比几百个 <rect> 小得多,渲染也更快。
  let path = ''
  for (let row = 0; row < matrix.size; row += 1) {
    const line = matrix.cells[row]!
    for (let col = 0; col < matrix.size; col += 1) {
      if (!line[col]) continue
      const x = col + QUIET_MODULES
      const y = row + QUIET_MODULES
      path += `M${x} ${y}h1v1h-1z`
    }
  }

  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox={`0 0 ${total} ${total}`}
      role="img"
      aria-label="pairing-qr"
      shapeRendering="crispEdges"
      style={{ display: 'block', background: '#fff', borderRadius: 8 }}
    >
      <rect width={total} height={total} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  )
}
