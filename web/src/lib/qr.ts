/**
 * 配对二维码的模块矩阵。
 *
 * 只做「链接字符串 → 黑白点阵」这一件事,渲染交给调用方:二维码要按像素画,
 * 但它的正确性(定位图案、纠错码、掩码)全部由 qrcode-generator 负责,不自己实现。
 *
 * 纠错等级选 L:配对链接带两三个候选地址后接近 600 字节,用 L 才能把版本压在
 * 20 以内,点阵不至于密到手机对不上。二维码只显示在宿主屏幕上、尺寸可控,
 * 低纠错等级的代价可以接受。
 */

import * as qrcodeModule from 'qrcode-generator'

interface QrCode {
  addData(data: string): void
  make(): void
  getModuleCount(): number
  isDark(row: number, col: number): boolean
}

type QrFactory = (typeNumber: number, level: 'L' | 'M' | 'Q' | 'H') => QrCode

/**
 * 取工厂函数。
 *
 * 这个包是 `export =` 的 CommonJS 形态,而它的 ESM 入口导出了 default;
 * `verbatimModuleSyntax` 下不能用默认导入取到它,所以按命名空间拿再回退。
 */
const factory: QrFactory = ((qrcodeModule as unknown as { default?: QrFactory }).default
  ?? (qrcodeModule as unknown as QrFactory))

export interface QrMatrix {
  size: number
  /** `cells[row][col]` 为真表示该模块是深色。 */
  cells: boolean[][]
}

/**
 * 生成点阵;内容超出容量时返回 null(调用方回退到链接文本)。
 * 版本号传 0 让库自己挑最小的可用版本。
 */
export function buildQrMatrix(value: string): QrMatrix | null {
  if (!value) return null
  try {
    const qr = factory(0, 'L')
    qr.addData(value)
    qr.make()
    const size = qr.getModuleCount()
    const cells: boolean[][] = []
    for (let row = 0; row < size; row += 1) {
      const line: boolean[] = []
      for (let col = 0; col < size; col += 1) line.push(qr.isDark(row, col))
      cells.push(line)
    }
    return { size, cells }
  } catch {
    return null
  }
}
