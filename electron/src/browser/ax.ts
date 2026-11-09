// 无障碍树快照与基于 CDP 的元素动作。
//
// 快照把 AX 树渲染成缩进文本,并给带 DOM 落点的条目分配 `[ref=eN]`;
// ref → backendNodeId 的映射由调用方按 tab 保存,页面导航后作废。
// 动作走 CDP 原语(滚动到视图、取内容四边形、Input 事件),不往页面注入全局变量。

import type { CDPSession } from '@zhizhuodemao/patchright'

export interface SnapshotResult {
  text: string
  refs: Map<string, number>
  truncated: boolean
  count: number
}

interface AxNode {
  nodeId?: string
  parentId?: string
  ignored?: boolean
  role?: { value?: unknown }
  name?: { value?: unknown }
  value?: { value?: unknown }
  backendDOMNodeId?: number
  childIds?: string[]
}

function axText(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw)
  return ''
}

function escapeName(name: string): string {
  return name.replace(/[\r\n]+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * 渲染 AX 树:ignored 节点不输出自身、子节点上提;无语义无名字的结构节点
 * 同样上提,避免快照被大量 generic 容器淹没。
 */
export async function snapshotAccessibility(
  session: CDPSession,
  options: { maxElements?: number } = {},
): Promise<SnapshotResult> {
  const result = (await session.send('Accessibility.getFullAXTree', {})) as {
    nodes?: AxNode[]
  }
  const nodes = Array.isArray(result.nodes) ? result.nodes : []
  const index = new Map<string, AxNode>()
  for (const node of nodes) {
    if (node.nodeId) index.set(node.nodeId, node)
  }
  const refs = new Map<string, number>()
  const lines: string[] = []
  let nextRef = 1
  let count = 0
  let truncated = false
  const max = options.maxElements ?? 0

  const walk = (node: AxNode, depth: number): void => {
    if (truncated) return
    if (node.ignored) {
      for (const childId of node.childIds ?? []) {
        const child = index.get(childId)
        if (child) walk(child, depth)
      }
      return
    }
    const role = axText(node.role?.value)
    const name = axText(node.name?.value)
    const value = axText(node.value?.value)
    const structural =
      ['', 'none', 'generic', 'InlineTextBox'].includes(role) &&
      name === '' &&
      node.backendDOMNodeId === undefined
    let childDepth = depth
    if (!structural) {
      if (max > 0 && count >= max) {
        truncated = true
        return
      }
      let line = `${'  '.repeat(depth)}- ${role === '' ? 'node' : role}`
      if (name !== '') line += ` "${escapeName(name)}"`
      if (node.backendDOMNodeId !== undefined) {
        const ref = `e${nextRef++}`
        refs.set(ref, node.backendDOMNodeId)
        line += ` [ref=${ref}]`
      }
      if (value !== '') line += `: ${value.replace(/[\r\n]+/g, ' ')}`
      lines.push(line)
      count += 1
      childDepth = depth + 1
    }
    for (const childId of node.childIds ?? []) {
      const child = index.get(childId)
      if (child) walk(child, childDepth)
    }
  }

  const root = nodes.find((node) => node.parentId === undefined) ?? nodes[0]
  if (root) walk(root, 0)
  return { text: lines.join('\n'), refs, truncated, count }
}

export function normalizeRef(target: string): string {
  const trimmed = target.trim()
  return trimmed.startsWith('@') ? trimmed.slice(1) : trimmed
}

export function isAriaRef(target: string): boolean {
  return /^e\d+$/.test(target.trim())
}

async function quadCenter(
  session: CDPSession,
  backendNodeId: number,
): Promise<{ x: number; y: number } | undefined> {
  const result = (await session.send('DOM.getContentQuads', { backendNodeId })) as {
    quads?: number[][]
  }
  for (const quad of result.quads ?? []) {
    if (quad.length !== 8) continue
    let area = 0
    for (let index = 0; index < 4; index += 1) {
      const x1 = quad[index * 2] ?? 0
      const y1 = quad[index * 2 + 1] ?? 0
      const next = (index + 1) % 4
      const x2 = quad[next * 2] ?? 0
      const y2 = quad[next * 2 + 1] ?? 0
      area += x1 * y2 - x2 * y1
    }
    if (Math.abs(area / 2) <= 1) continue
    return {
      x: ((quad[0] ?? 0) + (quad[2] ?? 0) + (quad[4] ?? 0) + (quad[6] ?? 0)) / 4,
      y: ((quad[1] ?? 0) + (quad[3] ?? 0) + (quad[5] ?? 0) + (quad[7] ?? 0)) / 4,
    }
  }
  return undefined
}

export async function scrollIntoView(session: CDPSession, backendNodeId: number): Promise<void> {
  await session.send('DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => undefined)
}

export async function elementCenter(
  session: CDPSession,
  backendNodeId: number,
): Promise<{ x: number; y: number }> {
  await scrollIntoView(session, backendNodeId)
  const center = await quadCenter(session, backendNodeId)
  if (!center) throw new Error('元素不可见或没有布局尺寸')
  return center
}

interface MouseOptions {
  button?: 'left' | 'right' | 'middle'
  clickCount?: number
}

function buttonMask(button: 'left' | 'right' | 'middle'): number {
  if (button === 'right') return 2
  if (button === 'middle') return 4
  return 1
}

export async function clickPoint(
  session: CDPSession,
  x: number,
  y: number,
  options: MouseOptions = {},
): Promise<void> {
  const button = options.button ?? 'left'
  const clickCount = options.clickCount ?? 1
  const base = { x, y, button, clickCount }
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base })
  await session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    ...base,
    buttons: buttonMask(button),
  })
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base })
}

export async function hoverPoint(session: CDPSession, x: number, y: number): Promise<void> {
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
}

/** 带可操作性重试的引用点击:元素刚出现/布局未稳定时滚动后重取坐标。 */
export async function clickBackend(
  session: CDPSession,
  backendNodeId: number,
  options: MouseOptions = {},
): Promise<void> {
  let lastError = ''
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const center = await elementCenter(session, backendNodeId)
      await clickPoint(session, center.x, center.y, options)
      return
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw new Error(`元素不可见或不可点击:${lastError}`)
}

async function objectIdOf(session: CDPSession, backendNodeId: number): Promise<string> {
  const result = (await session.send('DOM.resolveNode', { backendNodeId })) as {
    object?: { objectId?: string }
  }
  const objectId = result.object?.objectId
  if (!objectId) throw new Error('元素节点已失效')
  return objectId
}

async function callOn(
  session: CDPSession,
  backendNodeId: number,
  functionDeclaration: string,
  args: { value?: unknown }[] = [],
): Promise<unknown> {
  const objectId = await objectIdOf(session, backendNodeId)
  const result = (await session.send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration,
    arguments: args,
    returnByValue: true,
    awaitPromise: true,
  })) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } }
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? '页面脚本执行失败')
  return result.result?.value
}

export async function fillBackend(session: CDPSession, backendNodeId: number, value: string): Promise<void> {
  await callOn(
    session,
    backendNodeId,
    `function(value) {
      this.focus();
      if ('value' in this) this.value = value;
      else this.textContent = value;
      this.dispatchEvent(new Event('input', { bubbles: true }));
      this.dispatchEvent(new Event('change', { bubbles: true }));
    }`,
    [{ value }],
  )
}

export async function selectBackend(
  session: CDPSession,
  backendNodeId: number,
  values: string[],
): Promise<void> {
  await callOn(
    session,
    backendNodeId,
    `function(values) {
      const wanted = new Set(values);
      for (const option of this.options ?? []) option.selected = wanted.has(option.value) || wanted.has(option.text);
      this.dispatchEvent(new Event('input', { bubbles: true }));
      this.dispatchEvent(new Event('change', { bubbles: true }));
    }`,
    [{ value: values }],
  )
}

export async function checkBackend(
  session: CDPSession,
  backendNodeId: number,
  checked: boolean | undefined,
): Promise<void> {
  await callOn(
    session,
    backendNodeId,
    `function(checked) {
      const current = 'checked' in this ? this.checked : undefined;
      if (checked !== undefined && current === checked) return;
      this.click();
    }`,
    checked === undefined ? [] : [{ value: checked }],
  )
}

export async function focusBackend(session: CDPSession, backendNodeId: number): Promise<void> {
  await session.send('DOM.focus', { backendNodeId })
}

/** 坐标处的元素信息(控制台拾取)。 */
export async function elementInfoAt(
  session: CDPSession,
  x: number,
  y: number,
): Promise<Record<string, unknown>> {
  const located = (await session.send('DOM.getNodeForLocation', {
    x,
    y,
    includeUserAgentShadowDOM: true,
  })) as { backendNodeId?: number }
  const backendNodeId = located.backendNodeId
  if (backendNodeId === undefined) throw new Error('该坐标没有元素')
  const described = (await session.send('DOM.describeNode', { backendNodeId, depth: 0 })) as {
    node?: {
      nodeName?: string
      attributes?: string[]
      backendNodeId?: number
    }
  }
  const node = described.node ?? {}
  const attributes: Record<string, string> = {}
  const raw = node.attributes ?? []
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const name = raw[index]
    const value = raw[index + 1]
    if (name && value !== undefined) attributes[name] = value
  }
  const resolved = (await session.send('DOM.resolveNode', { backendNodeId })) as {
    object?: { objectId?: string }
  }
  const objectId = resolved.object?.objectId
  let rect: unknown
  let text = ''
  if (objectId) {
    const evaluated = (await session.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function() {
        const r = this.getBoundingClientRect();
        return {
          rect: { x: r.x, y: r.y, width: r.width, height: r.height },
          text: (this.textContent ?? '').trim().slice(0, 200),
        };
      }`,
      returnByValue: true,
    })) as { result?: { value?: { rect?: unknown; text?: string } } }
    rect = evaluated.result?.value?.rect
    text = evaluated.result?.value?.text ?? ''
  }
  return {
    tag: (node.nodeName ?? '').toLowerCase(),
    id: attributes.id ?? '',
    cls: attributes.class ? attributes.class.split(/\s+/).filter(Boolean) : [],
    text,
    rect,
    backendNodeId,
  }
}