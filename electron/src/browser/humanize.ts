// 人类化输入:把「一步到位」的合成事件改成带过程、带抖动的操作序列。
//
// 检测方区分人机的主要依据不是事件本身,而是事件的**过程**:
// - 鼠标从 A 瞬移到 B 且匀速,`mousemove` 序列长度还会随距离线性变化;
// - 每次按键间隔恒定、`keydown/keyup` 之间没有按压时长;
// - 滚动是一帧到位的位移,没有惯性衰减。
//
// 这里只生成参数序列,事件的派发仍由调用方负责(Playwright 鼠标或
// CDP `Input.dispatch*`),因此有头/无头、主页面/iframe 都能复用。

/** 可注入的随机源,便于测试时固定。 */
export type Random = () => number

const defaultRandom: Random = Math.random

export interface Point {
  x: number
  y: number
}

/** 三次贝塞尔求值。 */
function cubicAt(t: number, p0: number, p1: number, p2: number, p3: number): number {
  const inv = 1 - t
  return inv * inv * inv * p0 + 3 * inv * inv * t * p1 + 3 * inv * t * t * p2 + t * t * t * p3
}

/**
 * 生成一条从起点到终点的鼠标轨迹。
 *
 * 用两个随机控制点的三次贝塞尔:起点与终点的切线方向因此自然,轨迹会像
 * 手臂带出来的弧线,而不是直线插值。步长按距离与曲率自适应,并叠加微小
 * 抖动 —— 真实的鼠标采样点在慢速段更密。
 */
export function mousePath(from: Point, to: Point, random: Random = defaultRandom): Point[] {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const distance = Math.hypot(dx, dy)
  if (distance < 1) return [{ ...to }]

  // 控制点落在法线方向的两侧,偏移量随距离增长但有上限;
  // 太规则的弧线同样可识别。
  const nx = -dy / distance
  const ny = dx / distance
  const bend = Math.min(distance * 0.32, 140) * (0.35 + random() * 0.5)
  const lift = 0.2 + random() * 0.3
  const c1: Point = {
    x: from.x + dx * lift + nx * bend,
    y: from.y + dy * lift + ny * bend,
  }
  const c2: Point = {
    x: from.x + dx * (1 - lift) + nx * bend * 0.6,
    y: from.y + dy * (1 - lift) + ny * bend * 0.6,
  }

  // 采样点数按真鼠标的轮询频率估:约 125Hz,一次 600px 的移动耗时
  // 500–700ms,对应 60–80 个采样点。点太密会让「每秒事件数」异常偏高。
  const steps = Math.max(10, Math.min(64, Math.round(distance / 8)))
  const points: Point[] = []
  for (let index = 1; index <= steps; index += 1) {
    // 缓入缓出:末段减速是真人最明显的手感。
    const raw = index / steps
    const t = raw * raw * (3 - 2 * raw)
    const jitter = distance > 24 ? (random() - 0.5) * 1.6 : 0
    points.push({
      x: cubicAt(t, from.x, c1.x, c2.x, to.x) + jitter,
      y: cubicAt(t, from.y, c1.y, c2.y, to.y) + jitter * 0.6,
    })
  }
  // 最后一个点对齐目标,避免抖动让点击落到元素边缘外。
  points[points.length - 1] = { ...to }
  return points
}

/** 两个采样点之间的等待毫秒数。
 *
 * 真鼠标的采样间隔基本恒定在 8–16ms(浏览器按帧合并事件),
 * 慢速段的「密」来自移动距离小,而不是停顿变长。所以这里的基线
 * 与距离无关,只做小幅抖动 —— 用距离乘系数会把一次点击拖成秒级。
 */
export function mouseStepDelay(distance: number, random: Random = defaultRandom): number {
  // 距离大的段落略微放慢,但系数要小,保证整体手感而不是总延迟。
  const base = 6 + Math.min(distance * 0.5, 8)
  return Math.round(base + (random() - 0.5) * 4)
}

/** 悬停后到按下之间的思考延迟。 */
export function hoverDelay(random: Random = defaultRandom): number {
  return Math.round(30 + random() * 70)
}

/** 单次按键的按住时长(毫秒)。真人的按压时长有明显离散度。 */
export function keyPressDelay(random: Random = defaultRandom): number {
  return Math.round(30 + random() * 70)
}

/** 相邻两次按键之间的间隔:常见词是快速连打,生疏处会停顿。 */
export function keyGap(char: string, random: Random = defaultRandom): number {
  const isWordBreak = /[\s,.;:!?，。；：！？]/.test(char)
  const base = isWordBreak ? 90 + random() * 160 : 45 + random() * 110
  // 偶发的长停顿,模拟思考或找键位。
  const hesitation = random() < 0.06 ? 180 + random() * 320 : 0
  return Math.round(base + hesitation)
}

/** 滚动拆解:把一次目标位移拆成若干逐步衰减的增量。 */
export function scrollSteps(delta: number, random: Random = defaultRandom): number[] {
  if (delta === 0) return [0]
  const direction = Math.sign(delta)
  const total = Math.abs(delta)
  const steps: number[] = []
  let remaining = total
  while (remaining > 1) {
    // 首段最大,之后按指数衰减,末段收尾 —— 惯性与阻尼的近似。
    const share = steps.length === 0 ? 0.4 + random() * 0.15 : 0.28 + random() * 0.18
    const take = Math.max(1, Math.min(remaining, Math.round(remaining * share)))
    steps.push(direction * take)
    remaining -= take
    if (steps.length > 24) break
  }
  // 兜底:剩下的零头一次补完,保证总位移与请求一致。
  if (remaining > 0) steps.push(direction * remaining)
  if (steps.length === 0) steps.push(direction * total)
  return steps
}

/** 滚动每一步之间的间隔。 */
export function scrollStepDelay(random: Random = defaultRandom): number {
  return Math.round(16 + random() * 34)
}
