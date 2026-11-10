// 伪装层与人类化输入的行为契约。
//
// 这些断言锁定两条容易被无意破坏的性质:
// 1. 伪装只纠正实测有差异的项,不能顺手改动本来正常的属性;
// 2. 人类化生成的是「有过程」的序列,而不是换了名字的一次到位。

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  keyGap,
  keyPressDelay,
  mousePath,
  mouseStepDelay,
  scrollStepDelay,
  scrollSteps,
} from '../src/browser/humanize.ts'
import {
  auditFingerprint,
  buildProfile,
  isHeadlessUserAgent,
  sanitizeUserAgent,
  stealthArgs,
  stealthScript,
  WINDOW_CHROME,
} from '../src/browser/stealth.ts'

/** 固定种子的伪随机,让轨迹与节奏断言可复现。 */
function seeded(seed = 1) {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    return state / 0x7fffffff
  }
}

const EDGE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/157.0.0.0 Safari/537.36 Edg/157.0.0.0'

test('sanitizeUserAgent strips only the headless marker', () => {
  const clean = sanitizeUserAgent(EDGE_UA)
  assert.equal(isHeadlessUserAgent(clean), false)
  assert.ok(clean.includes('Chrome/157.0.0.0'))
  assert.ok(clean.includes('Edg/157.0.0.0'))
  // 除标记外逐字保留:版本号必须与浏览器自报的一致。
  assert.equal(clean.replace('Chrome/157', 'HeadlessChrome/157'), EDGE_UA)
})

test('a real user agent is left untouched', () => {
  const real = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36 Edg/157.0.0.0'
  assert.equal(sanitizeUserAgent(real), real)
  assert.equal(isHeadlessUserAgent(real), false)
})

test('a probed user agent keeps its exact browser version', () => {
  // 版本号必须原样保留:UA-CH 由内核直接给出,改版本会让两者互相矛盾。
  const probed =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/157.0.4341.42 Safari/537.36 Edg/157.0.4341.42'
  const profile = buildProfile({ userAgent: probed })
  assert.ok(profile.userAgent.includes('Chrome/157.0.4341.42'))
  assert.ok(profile.userAgent.includes('Edg/157.0.4341.42'))
})

test('stealthArgs never lets the headless flag leak into the UA', () => {
  const profile = buildProfile({ userAgent: EDGE_UA, viewport: { width: 1440, height: 900 } })
  const args = stealthArgs(profile)
  const ua = args.find((arg) => arg.startsWith('--user-agent='))
  assert.ok(ua, 'the UA override is present')
  assert.ok(!/HeadlessChrome/i.test(ua), 'the override carries no headless marker')
  // 窗口比视口大,才能给出真实的 outer - inner。
  assert.ok(args.includes(`--window-size=${1440 + WINDOW_CHROME.x},${900 + WINDOW_CHROME.y}`))
  assert.ok(args.includes('--lang=zh-CN'))
})

test('the stealth script only patches values that look wrong', () => {
  const profile = buildProfile({ userAgent: EDGE_UA })
  const script = stealthScript(profile)
  // 每项纠正都必须先比较现值,否则会把真机的正确值也覆盖掉。
  assert.match(script, /if \(window\.outerWidth === window\.innerWidth\)/)
  assert.match(script, /if \(window\.outerHeight === window\.innerHeight\)/)
  assert.match(script, /if \(screen\.width === window\.innerWidth && screen\.height === window\.innerHeight\)/)
  assert.match(script, /if \(window\.devicePixelRatio === 1 && cfg\.deviceScaleFactor !== 1\)/)
  // 已经正常的属性不该出现在补丁里。
  for (const untouched of ['webdriver', 'chrome.app', 'permissions', 'plugins']) {
    assert.ok(!script.includes(untouched), `the script must not rewrite ${untouched}`)
  }
  assert.ok(script.includes(String(profile.screen.width)))
  assert.ok(script.includes(String(profile.deviceScaleFactor)))
})

test('mousePath lands exactly on target and bends away from the straight line', () => {
  const random = seeded(7)
  const from = { x: 40, y: 60 }
  const to = { x: 880, y: 520 }
  const path = mousePath(from, to, random)
  assert.ok(path.length > 10, 'the path is sampled')
  assert.deepEqual(path.at(-1), to, 'the last sample is the target')

  const straight = Math.hypot(to.x - from.x, to.y - from.y)
  let travelled = 0
  let previous = from
  for (const point of path) {
    travelled += Math.hypot(point.x - previous.x, point.y - previous.y)
    previous = point
  }
  // 曲线一定比直线长,但不应夸张到绕路。
  assert.ok(travelled > straight, 'the gesture is an arc, not a line')
  assert.ok(travelled < straight * 1.5, 'the arc stays plausible')

  // 采样点不能全落在直线上,否则等于没做曲线。
  const offsets = path.map((point) => {
    const cross = (to.x - from.x) * (point.y - from.y) - (to.y - from.y) * (point.x - from.x)
    return Math.abs(cross / straight)
  })
  assert.ok(Math.max(...offsets) > 1, 'samples deviate from the chord')
})

test('mousePath on a tiny move does not fabricate a long gesture', () => {
  const path = mousePath({ x: 10, y: 10 }, { x: 10.5, y: 10.5 }, seeded(3))
  assert.equal(path.length, 1)
  assert.deepEqual(path[0], { x: 10.5, y: 10.5 })
})

test('mouse sampling stays near real pointer frequency instead of per-pixel', () => {
  // 600px 移动不该产生上千个事件:那是机器特征,不是更真实。
  const path = mousePath({ x: 0, y: 0 }, { x: 600, y: 0 }, seeded(11))
  assert.ok(path.length <= 64, `too many samples: ${path.length}`)
  const delays = path.map((point, index) => mouseStepDelay(index === 0 ? 0 : 8, seeded(index + 1)))
  assert.ok(Math.max(...delays) < 40, 'per-step delay stays in the frame budget')
})

test('key timing varies and pauses longer at word breaks', () => {
  const random = seeded(5)
  const letters = Array.from({ length: 40 }, (_, index) => keyGap('a', () => ((random() + index) % 100) / 100))
  assert.ok(new Set(letters).size > 5, 'inter-key gaps are not constant')
  const pressDelays = Array.from({ length: 20 }, () => keyPressDelay(random))
  assert.ok(Math.max(...pressDelays) > Math.min(...pressDelays))
  // 标点/空格前后通常有更长的停顿。
  const word = Array.from({ length: 50 }, () => keyGap(' ', seeded(9)))
  const char = Array.from({ length: 50 }, () => keyGap('z', seeded(9)))
  assert.ok(Math.min(...word) >= Math.min(...char), 'word breaks are not faster than letters')
})

test('scrollSteps conserves the requested distance', () => {
  for (const delta of [240, -640, 1200, 37]) {
    const steps = scrollSteps(delta, seeded(13))
    assert.equal(steps.reduce((sum, step) => sum + step, 0), delta, `delta ${delta} must be preserved`)
    assert.ok(steps.every((step) => Math.sign(step) === Math.sign(delta) || step === 0))
    assert.equal(scrollSteps(0).length, 1)
  }
  const long = scrollSteps(1200, seeded(17))
  assert.ok(long.length > 1, 'a long scroll is broken into stages')
  assert.ok(Math.abs(long[0] ?? 0) >= Math.abs(long.at(-1) ?? 0), 'the first stage is the largest')
  assert.ok(scrollStepDelay() >= 0)
})

test('buildProfile defaults to a screen larger than the viewport', () => {
  const profile = buildProfile({ userAgent: EDGE_UA })
  assert.ok(profile.screen.width > profile.viewport.width)
  assert.ok(profile.screen.height > profile.viewport.height)
  assert.equal(isHeadlessUserAgent(profile.userAgent), false)
  assert.equal(buildProfile({ userAgent: EDGE_UA, locale: ' en-US ' }).locale, 'en-US')
})

test('auditFingerprint flags the headless markers and passes a clean sample', () => {
  const viewport = { width: 1440, height: 900 }
  const profile = buildProfile({ userAgent: EDGE_UA, viewport })
  const clean = {
    userAgent: profile.userAgent,
    webdriver: false,
    chrome: ['loadTimes', 'csi', 'app'],
    window: {
      outerWidth: viewport.width + WINDOW_CHROME.x,
      outerHeight: viewport.height + WINDOW_CHROME.y,
      innerWidth: viewport.width,
      innerHeight: viewport.height,
      devicePixelRatio: profile.deviceScaleFactor,
    },
    screen: { width: profile.screen.width, height: profile.screen.height },
    webgl: { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU)' },
  }
  const passing = auditFingerprint(clean, profile, true)
  assert.ok(passing.every((check) => check.ok), `unexpected failures: ${JSON.stringify(passing.filter((c) => !c.ok))}`)

  const broken = auditFingerprint(
    {
      ...clean,
      userAgent: EDGE_UA,
      webdriver: true,
      chrome: ['loadTimes', 'csi'],
      window: { ...clean.window, outerWidth: viewport.width, outerHeight: viewport.height },
      screen: { width: viewport.width, height: viewport.height },
      webgl: { vendor: 'Google Inc.', renderer: 'Google SwiftShader' },
    },
    profile,
    false,
  )
  const failing = new Set(broken.filter((check) => !check.ok).map((check) => check.name))
  for (const expected of ['userAgent', 'windowFrame', 'screen', 'webdriver', 'chromeObject', 'webgl', 'humanize']) {
    assert.ok(failing.has(expected), `missing failure: ${expected}`)
  }
})
