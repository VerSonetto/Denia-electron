// `browser` 工具:控制本机 Chrome/Edge(Playwright/Patchright 驱动)。
//
// 命令面按 js-reverse-mcp 的 agent-first 设计组织:页面/帧选择、严格匹配的
// 点击、脚本与断点、网络与 WebSocket、Console、站点状态;同时保留控制台
// 侧栏需要的坐标类命令。工具本体只做参数整形与结果渲染,状态在 BrowserManager。

import type { CommandOutcome } from '../browser/types.ts'
import type { Tool, ToolContext } from './types.ts'
import type { ToolOutput } from '../core/wire.ts'
import { schema, textOutput, toolError } from './types.ts'

export interface BrowserBackend {
  execute(command: Record<string, unknown>): Promise<CommandOutcome>
  requestVisualMode(): void
}

const METHODS = [
  'list',
  'getState',
  'newTab',
  'activate',
  'close',
  'selectPage',
  'frames',
  'selectFrame',
  'navigate',
  'back',
  'forward',
  'reload',
  'viewportSet',
  'viewportReset',
  'screenshot',
  'snapshot',
  'clickElement',
  'click',
  'fill',
  'type',
  'press',
  'scroll',
  'hover',
  'select',
  'check',
  'drag',
  'elementInfo',
  'evaluate',
  'waitFor',
  'getDialog',
  'handleDialog',
  'networkList',
  'networkDetail',
  'networkGetBody',
  'getRequestInitiator',
  'clearNetworkRequests',
  'listConsoleMessages',
  'listScripts',
  'getScriptSource',
  'saveScriptSource',
  'searchInSources',
  'setBreakpointOnText',
  'breakOnXhr',
  'removeBreakpoint',
  'listBreakpoints',
  'getPausedInfo',
  'pauseOrResume',
  'step',
  'clearSiteData',
  'fingerprint',
  'shutdownBrowser',
] as const

const DESCRIPTION = `控制本机浏览器(Chrome/Edge,默认后台)。一个 method 一个动作;全部命令、参数与语义见 skill browser-guide,调用前先 load(未在 schema 声明的参数按手册直接传)。

必守:ref 只在同标签页最近一次 snapshot 后有效;clickElement 必须 confirm=true;弹窗必须处置;结束必须显式 shutdownBrowser。`

function renderValue(value: unknown): string {
  if (value === undefined || value === null) return ''
  let text: string
  if (typeof value === 'string') {
    text = value
  } else {
    try {
      text = JSON.stringify(value, null, 2)
    } catch {
      text = String(value)
    }
  }
  if (text.length <= 12_000) return text
  return `${text.slice(0, 12_000)}\n...(已截断,共 ${text.length} 字符;用更小的 max/pageSize 或导出到文件)`
}

function renderTabs(tabs: { tabId: string; url: string; title: string; active: boolean }[] | undefined): string {
  if (!tabs || tabs.length === 0) return ''
  const lines = tabs.map((tab) => `${tab.active ? '*' : ' '} ${tab.tabId}  ${tab.url || 'about:blank'}${tab.title ? `  ${tab.title}` : ''}`)
  return `标签页:\n${lines.join('\n')}`
}

function renderOutcome(outcome: CommandOutcome): string {
  const parts: string[] = []
  parts.push(outcome.ok ? 'ok' : `error[${outcome.error?.code ?? 'unknown'}]: ${outcome.error?.message ?? ''}`)
  if (outcome.state) parts.push(`state: ${renderValue(outcome.state)}`)
  if (outcome.dialog !== undefined) parts.push(`dialog: ${renderValue(outcome.dialog)}`)
  if (outcome.value !== undefined) parts.push(renderValue(outcome.value))
  const tabs = renderTabs(outcome.tabs)
  if (tabs !== '') parts.push(tabs)
  if (outcome.image) parts.push(`截图已注入为视觉输入(${outcome.image.mimeType})`)
  return parts.filter((part) => part !== '').join('\n')
}

export function createBrowserTool(backend: BrowserBackend): Tool {
  return {
    schema: schema(
      'browser',
      DESCRIPTION,
      {
        type: 'object',
        properties: {
          method: { type: 'string', enum: [...METHODS], description: '命令名;各命令参数见 skill browser-guide' },
          tabId: { type: 'string' },
          url: { type: 'string' },
          pageIdx: { type: 'integer', minimum: 0 },
          frameIdx: { type: 'integer', minimum: 0 },
          selector: { type: 'string' },
          ref: { type: 'string' },
          index: { type: 'integer', minimum: 0 },
          confirm: { type: 'boolean', description: 'clickElement 必须 true' },
          x: { type: 'number' },
          y: { type: 'number' },
          value: { type: 'string' },
          text: { type: 'string' },
          key: { type: 'string' },
          expression: { type: 'string' },
          mainWorld: { type: 'boolean' },
          timeoutMs: { type: 'integer' },
          maxElements: { type: 'integer' },
          accept: { type: 'boolean' },
          promptText: { type: 'string' },
          urlFilter: { type: 'string' },
          max: { type: 'integer' },
          requestId: { type: 'integer' },
          bodyKind: { type: 'string', enum: ['response', 'request'] },
          query: { type: 'string' },
          path: { type: 'string' },
          action: { type: 'string', enum: ['pause', 'resume'] },
          kind: { type: 'string', enum: ['over', 'into', 'out'] },
          humanize: { type: 'boolean', description: '缺省 true;false 一次到位' },
          visualMode: { type: 'boolean', description: '展开控制台侧栏给用户看' },
          all: { type: 'boolean' },
        },
        required: ['method'],
      },
    ),
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
      if (typeof args.method !== 'string' || args.method.trim() === '') {
        return toolError('browser 需要 method', '先用 list 或 getState 查看当前状态')
      }
      if (ctx.cancel.aborted) {
        return {
          content: '[工具错误] 命令被用户中断',
          isError: true,
          errorIdentity: { name: 'browser', code: 'cancelled' },
        }
      }
      if (args.visualMode === true) {
        try {
          backend.requestVisualMode()
        } catch {
          /* 侧栏不可用不影响命令 */
        }
      }
      let outcome: CommandOutcome
      try {
        outcome = await backend.execute(args)
      } catch (error) {
        return toolError(
          `浏览器命令失败:${error instanceof Error ? error.message : String(error)}`,
          '先用 list 确认浏览器状态',
        )
      }
      if (outcome.image) {
        const data = outcome.image.base64
        ctx.emit({
          type: 'user-message',
          text: `[harness] 浏览器截图已注入为视觉输入(${outcome.image.mimeType})`,
          injected: true,
          channel: 'image',
          images: [{ mime: outcome.image.mimeType, data }],
        })
      }
      const content = renderOutcome(outcome)
      if (!outcome.ok) {
        return {
          content: `[浏览器错误] ${outcome.error?.code ?? 'unknown'}: ${outcome.error?.message ?? ''}`,
          isError: true,
          errorIdentity: { name: 'browser', code: outcome.error?.code ?? 'unknown' },
          meta: { browser: { method: args.method, elapsedMs: outcome.elapsedMs } },
        }
      }
      return textOutput(content, { browser: { method: args.method, elapsedMs: outcome.elapsedMs } })
    },
  }
}