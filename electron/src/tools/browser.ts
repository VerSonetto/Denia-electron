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

const DESCRIPTION = `控制本机浏览器(Chrome/Edge,持久 profile,默认无窗口后台运行;控制台侧栏可实时看到画面)。面向真实页面的操作与 JS 逆向分析,一个 method 一个动作。

页面与导航:
- list{} 列出标签页(不启动浏览器);getState{} 返回当前状态(未运行时拉起实例)
- newTab{url?}、activate{tabId}、close{tabId?}、selectPage{pageIdx?}、navigate{url}(仅 http/https)、back/forward/reload
- frames{} / selectFrame{frameIdx}(0=主文档);后续 clickElement/fill/evaluate 都在选中的 frame 里执行

读取与交互:
- snapshot{maxElements?} 返回无障碍树文本,可交互元素带 [ref=eN];ref 只在同一标签页最近一次 snapshot 后有效,导航后必须重取
- clickElement{selector, index?, confirm} 严格匹配当前 frame 里的元素:匹配多个必须给 index,元素必须可见;confirm 必须为 true
- click{ref?|x,y, button?, doubleClick?}、fill{ref?|selector, value}、type{text, ref?|selector?}、press{key, ref?}、scroll{deltaX?, deltaY?, ref?|x,y}、hover、select{values}、check{checked?}、drag{fromRef?,toRef?,fromX...}
- elementInfo{x,y} 返回该坐标元素的 tag/id/class/文本/矩形
- evaluate{expression, frameIdx?, mainWorld?} 求值:默认隔离世界(读不到页面全局变量,更接近普通浏览);需要读 window 上的全局变量、hook 后的函数时传 mainWorld=true(仅主文档)。若停在断点,传 callFrameId 在调用帧求值
- waitFor{selector?|text?|textGone?, timeoutMs?};getDialog{} / handleDialog{accept, promptText?}(弹窗会挂起页面,必须处理)
- screenshot{fullPage?, clip?, format?} 截图会作为视觉输入自动注入会话

网络与 WebSocket:
- networkList{urlFilter?, max?} 列出当前标签页捕获的请求(带 requestId/status/pending)
- networkDetail{requestId} 请求/响应头、postData、initiator;networkGetBody{requestId, bodyKind?} 取响应体(缺省)或请求体
- getRequestInitiator{requestId} 取 JS 调用栈(依赖 CDP Network 域,首次调用才启用,需重新触发请求)
- getRequestInitiator{requestId} 取 JS 调用栈(依赖 CDP Network 域,首次调用才启用,需重新触发请求)
- websocketMessages{wsId?, max?} 列出 WebSocket 连接;传 wsId 看该连接的收发帧
- clearNetworkRequests{}

脚本与断点(首次调用会启用 Debugger 域,只覆盖当前页/当前帧):
- listScripts{filter?, pageSize?, pageIdx?}、getScriptSource{url?|scriptId, startLine?, endLine?, offset?, length?}、saveScriptSource{path, confirmOverwrite?}、searchInSources{query, isRegex?, caseSensitive?, urlFilter?}
- setBreakpointOnText{text, urlFilter?, occurrence?} 在压缩代码里按文本定位断点;breakOnXhr{urlPattern}
- listBreakpoints{} / removeBreakpoint{breakpointId?|url?|all?}
- getPausedInfo{includeScope?} 暂停状态、调用栈、作用域变量;pauseOrResume{action};step{kind:over|into|out}

状态与收尾:
- clearSiteData{origin?, cache?} 清理当前站点 cookies/storage(以及缓存)
- fingerprint{} 在主世界采一份指纹(UA、窗口/屏幕、webdriver、chrome 对象、WebGL),并逐项对照当前伪装档位报告异常。怀疑被识别成自动化时先跑它
- shutdownBrowser{} 结束浏览器进程、释放 profile 锁。任务结束必须显式调用:只 close 标签页不算收尾,浏览器实例会占住 profile 目录锁,残留会让下次启动失败

注意事项:交互命令会按需拉起浏览器;list/shutdownBrowser 在未运行时原地返回。网络/Console 采集只覆盖当前标签页且只保留最近 200 条。click/clickElement/type/scroll/hover/drag 默认走人类化轨迹(贝塞尔移动、逐字符键入、衰减滚动),需要一次到位时传 humanize=false。`

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
          method: { type: 'string', enum: [...METHODS], description: '命令名' },
          tabId: { type: 'string', description: '目标标签页;缺省 = 当前活动标签页' },
          url: { type: 'string', description: 'navigate/newTab:目标地址(仅 http/https)' },
          pageIdx: { type: 'integer', minimum: 0, description: 'selectPage:标签页序号;缺省只列出' },
          frameIdx: { type: 'integer', minimum: 0, description: 'selectFrame/evaluate:frame 序号(0=主文档)' },
          selector: { type: 'string', description: 'CSS 选择器(只在当前选中 frame 内解析)' },
          ref: { type: 'string', description: 'snapshot 给出的元素引用(如 e12);也接受 @e12' },
          index: { type: 'integer', minimum: 0, description: 'clickElement:选择器命中多个时的序号' },
          confirm: { type: 'boolean', description: 'clickElement 必须为 true' },
          button: { type: 'string', enum: ['left', 'right', 'middle'] },
          doubleClick: { type: 'boolean' },
          x: { type: 'number' },
          y: { type: 'number' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          value: { type: 'string', description: 'fill:输入内容' },
          text: { type: 'string', description: 'type/handleDialog:文本;waitFor:等待出现的文本' },
          textGone: { type: 'string', description: 'waitFor:等待消失的文本' },
          key: { type: 'string', description: 'press:键名(Enter/Tab/ArrowDown/a…)' },
          deltaX: { type: 'number', description: 'scroll:横向增量,缺省 0' },
          deltaY: { type: 'number', description: 'scroll:纵向增量,缺省 360' },
          values: { type: 'array', items: { type: 'string' }, description: 'select:选中值' },
          checked: { type: 'boolean', description: 'check:目标状态;缺省切换' },
          fromRef: { type: 'string' },
          toRef: { type: 'string' },
          fromX: { type: 'number' },
          fromY: { type: 'number' },
          toX: { type: 'number' },
          toY: { type: 'number' },
          expression: { type: 'string', description: 'evaluate:页面 JS 表达式' },
          mainWorld: { type: 'boolean', description: 'evaluate:在主世界求值(可读页面全局变量;仅主文档,缺省 false)' },
          callFrameId: { type: 'string', description: 'evaluate:暂停时在调用帧上求值' },
          timeoutMs: { type: 'integer', description: '导航/等待超时(毫秒)' },
          fullPage: { type: 'boolean', description: 'screenshot:整页截图' },
          format: { type: 'string', enum: ['png', 'jpeg'], description: 'screenshot:格式,缺省 png' },
          quality: { type: 'integer', minimum: 0, maximum: 100, description: 'screenshot:jpeg 质量' },
          clip: {
            type: 'object',
            properties: {
              x: { type: 'number' },
              y: { type: 'number' },
              width: { type: 'number' },
              height: { type: 'number' },
            },
            required: ['x', 'y', 'width', 'height'],
          },
          maxElements: { type: 'integer', description: 'snapshot:最多返回的元素数' },
          accept: { type: 'boolean', description: 'handleDialog:接受还是取消' },
          promptText: { type: 'string', description: 'handleDialog:prompt 回答' },
          urlFilter: { type: 'string', description: 'networkList/searchInSources:URL 子串过滤' },
          max: { type: 'integer', description: 'networkList/searchInSources/listConsoleMessages:最多返回条数' },
          requestId: { type: 'integer', description: '网络命令:networkList 给出的 requestId' },
          bodyKind: { type: 'string', enum: ['response', 'request'], description: 'networkGetBody:缺省取响应体' },
          msgId: { type: 'integer', description: 'listConsoleMessages:取单条详情' },
          wsId: { type: 'integer', description: 'websocketMessages:WebSocket 连接 id' },
          type: { type: 'string', description: 'listConsoleMessages:按类型过滤(error/warning/log…)' },
          filter: { type: 'string', description: 'listScripts:脚本 URL 子串过滤' },
          pageSize: { type: 'integer', description: 'listScripts:每页条数' },
          scriptId: { type: 'string', description: '脚本命令:scriptId' },
          startLine: { type: 'integer', description: 'getScriptSource:起始行(1-based)' },
          endLine: { type: 'integer', description: 'getScriptSource:结束行(含)' },
          offset: { type: 'integer', description: 'getScriptSource:按字符偏移读取' },
          length: { type: 'integer', description: 'getScriptSource:按字符读取的长度' },
          path: { type: 'string', description: 'saveScriptSource:保存路径(相对路径落在 $DENIA_HOME/browser/artifacts)' },
          confirmOverwrite: { type: 'boolean', description: 'saveScriptSource:覆盖已存在文件' },
          query: { type: 'string', description: 'searchInSources:搜索内容' },
          isRegex: { type: 'boolean' },
          caseSensitive: { type: 'boolean' },
          occurrence: { type: 'integer', minimum: 1, description: 'setBreakpointOnText:第几次出现' },
          urlPattern: { type: 'string', description: 'breakOnXhr:XHR/fetch URL 子串' },
          breakpointId: { type: 'string' },
          all: { type: 'boolean', description: 'removeBreakpoint:移除全部' },
          includeScope: { type: 'boolean', description: 'getPausedInfo:展开作用域变量(缺省 true)' },
          action: { type: 'string', enum: ['pause', 'resume'], description: 'pauseOrResume' },
          kind: { type: 'string', enum: ['over', 'into', 'out'], description: 'step' },
          origin: { type: 'string', description: 'clearSiteData:目标 origin' },
          cache: { type: 'boolean', description: 'clearSiteData:是否清理全局 HTTP 缓存(缺省 true)' },
          humanize: { type: 'boolean', description: 'click/clickElement/type/scroll/hover/drag:是否走人类化轨迹(缺省 true;传 false 一次到位)' },
          visualMode: { type: 'boolean', description: '展开控制台浏览器侧栏,让用户实时看到画面' },
          maxHeight: { type: 'integer' },
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