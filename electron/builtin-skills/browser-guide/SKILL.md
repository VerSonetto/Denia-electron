---
name: browser-guide
description: 需要操作浏览器或做页面 JS 逆向分析时加载：browser 工具的全部 method、参数语义、调试域开关与收尾要求。
metadata:
  short-description: browser 命令手册
---

# browser 命令手册

`browser` 工具控制本机 Chrome/Edge（Playwright/Patchright 驱动，持久 profile，默认无窗口后台运行，控制台侧栏可实时看到画面）。一个 `method` 一个动作，工具本身只做参数整形，状态在 BrowserManager。日常不需要浏览器时别加载本技能。

## 页面与导航

- `list{}` 列出标签页（**不启动浏览器**）；`getState{}` 返回当前状态（**未运行时拉起实例**，收尾时不要用它确认）。
- `newTab{url?}`、`activate{tabId}`、`close{tabId?}`、`selectPage{pageIdx?}`、`navigate{url}`（仅 http/https）、`back`/`forward`/`reload`。
- `frames{}` / `selectFrame{frameIdx}`（0 = 主文档）；之后的 `clickElement`/`fill`/`evaluate` 都在选中的 frame 里执行。

## 读取与交互

- `snapshot{maxElements?}` 返回无障碍树文本，可交互元素带 `[ref=eN]`；**ref 只在同一标签页最近一次 snapshot 后有效，导航后必须重取**。
- `clickElement{selector, index?, confirm}` 只在当前选中 frame 内严格匹配：命中多个必须给 `index`，元素必须可见，`confirm` 必须为 `true`。
- `click{ref?|x,y, button?, doubleClick?}`、`fill{ref?|selector, value}`、`type{text, ref?|selector?}`、`press{key, ref?}`、`scroll{deltaX?, deltaY?, ref?|x,y}`、`hover`、`select{values}`、`check{checked?}`、`drag{fromRef?,toRef?,fromX…}`。
- `elementInfo{x,y}` 返回该坐标元素的 tag/id/class/文本/矩形。
- `evaluate{expression, frameIdx?, mainWorld?}` 求值：默认隔离世界（更接近普通浏览）；要读 `window` 上的全局变量或 hook 后的函数时传 `mainWorld=true`（仅主文档）；停在断点时传 `callFrameId` 在调用帧求值。
- `waitFor{selector?|text?|textGone?, timeoutMs?}`；`getDialog{}` / `handleDialog{accept, promptText?}`——**弹窗会挂起页面，发现后必须处置**。
- `screenshot{fullPage?, clip?, format?}` 截图会作为视觉输入自动注入会话。

## 网络与 WebSocket

- `networkList{urlFilter?, max?}` 列出当前标签页捕获的请求（带 requestId/status/pending）；pending 请求要先 `pauseOrResume{action:'resume'}` 再等 response。
- `networkDetail{requestId}` 取请求/响应头、postData、initiator；`networkGetBody{requestId, bodyKind?}` 取响应体（缺省）或请求体。
- `getRequestInitiator{requestId}` 取 JS 调用栈：依赖 CDP Network 域，**首次调用才启用**，所以要在重新触发请求前先开一次。
- `websocketMessages{wsId?, max?}` 列出 WebSocket 连接；传 `wsId` 看该连接的收发帧。
- `clearNetworkRequests{}`。

## 脚本与断点

首次调用会启用 Debugger 域（**侵入动作**，只覆盖当前页/当前帧），只在确实需要动态分析时用。

- `listScripts{filter?, pageSize?, pageIdx?}`、`getScriptSource{url?|scriptId, startLine?, endLine?, offset?, length?}`、`saveScriptSource{path, confirmOverwrite?}`、`searchInSources{query, isRegex?, caseSensitive?, urlFilter?}`。
- `setBreakpointOnText{text, urlFilter?, occurrence?}` 在压缩代码里按文本定位断点；`breakOnXhr{urlPattern}`。
- `listBreakpoints{}` / `removeBreakpoint{breakpointId?|url?|all?}`。
- `getPausedInfo{includeScope?}` 暂停状态、调用栈、作用域变量；`pauseOrResume{action}`；`step{kind:over|into|out}`。

## 状态与收尾

- `clearSiteData{origin?, cache?}` 清理当前站点 cookies/storage（以及缓存）。
- `fingerprint{}` 在主世界采一份指纹（UA、窗口/屏幕、webdriver、chrome 对象、WebGL）并逐项对照当前伪装档位报告异常；怀疑被识别成自动化时先跑它。
- `shutdownBrowser{}` 结束浏览器进程、释放 profile 锁。**任务结束必须显式调用**：只 close 标签页不算收尾，实例占住 profile 目录锁，残留会让下次启动失败（收尾时先逐个 close 自己打开的 tab，用户原有的 tab 保留）。

## 注意

- 交互命令会按需拉起浏览器；`list`/`shutdownBrowser` 在未运行时原地返回。
- 网络/Console 采集只覆盖当前标签页，且只保留最近 200 条。
- `click`/`clickElement`/`type`/`scroll`/`hover`/`drag` 默认走人类化轨迹（贝塞尔移动、逐字符键入、衰减滚动），需要一次到位时传 `humanize=false`。
- 仅在用户明确要求观看时设 `visualMode: true`，其余保持后台。
