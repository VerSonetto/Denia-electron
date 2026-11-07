# Denia Electron（进行中）

Rust 后端向 Electron + TypeScript 迁移的工作树。前端 `web/` 原样复用：它只通过
HTTP/SSE 与宿主通信，因此新宿主在进程内起一个本地 HTTP 服务，窗口直接加载
`http://127.0.0.1:<port>`，相对 `/api` 路径与事件流都不需要改。

## 当前范围（首期）

已经跑通的最小闭环：

- **agent loop**：turn/step、流式 chunk、工具调用、并行执行、取消、死循环检测
- **LLM 适配器**：`openai-completions`、`openai-responses`、`anthropic-messages`，
  共享 `StreamAssembler` 保证三条流发出同一套 `StreamChunk`
- **会话存储**：`<home>/sessions/<id>/session.jsonl`，首行 header，之后逐条
  envelope；append 即广播，崩溃遗留轮次加载时补 `turn-end {aborted, disposed}`
- **工具**：`bash`、`read_file`、`write_file`、`edit`、`ls`、`glob`、`grep`、`todo_write`
- **HTTP/SSE 宿主**：会话列表/创建/快照/分页/发消息/取消/引导、follow SSE、
  全局事件 SSE、模型目录、设置、工作区、文件树/文件读取
- **Electron 壳**：主进程起宿主，窗口加载 UI

尚未迁移：MCP、子代理、技能、项目记忆、goal、压缩、审批策略、浏览器、渠道、
远程连接、更新、终端。这些端点目前返回 501 或空壳，UI 打开对应面板时会提示，
不影响对话主链路。

## 运行

```bash
cd electron
npm install
npm run typecheck
npm test
npm run build
npm start
```

宿主默认监听 `127.0.0.1:43654`，home 为 `~/.denia-electron`。可用环境变量覆盖：

- `DENIA_HOME`：会话、配置、工作区记录的根目录
- `DENIA_PORT`：监听端口（`0` 表示随机）
- `DENIA_WEB_DIR`：前端构建产物目录（默认 `../web/dist`）
- `DENIA_WEB_URL`：开发时改加载 Vite 地址（`web/` 的 `/api` 代理需指向本宿主）
- `DENIA_OPENAI_BASE_URL` / `DENIA_OPENAI_API_KEY` / `DENIA_OPENAI_MODELS`：
  在没有 `config.json` 时构造默认提供商

配置文件位于 `<home>/config.json`：

```json
{
  "providers": [
    {
      "id": "mock",
      "name": "Mock",
      "baseURL": "http://127.0.0.1:8787/v1",
      "protocol": "openai-completions",
      "apiKey": "",
      "models": [{ "id": "mock-1", "name": "Mock 1", "contextWindow": 128000 }]
    }
  ],
  "default": { "provider": "mock", "model": "mock-1" }
}
```

## 目录

```
src/
  main.ts                 Electron 主进程（起宿主 + 开窗口）
  host/server.ts          本地 HTTP/SSE 宿主与静态资源
  agent/loop.ts           turn/step 主循环
  agent/history.ts        会话事件 → 模型消息
  agent/system-prompt.ts  首期系统提示
  llm/                    三个协议适配器 + 共享 SSE/块组装
  session/store.ts        JSONL 会话日志
  tools/                  bash / 文件 / 搜索 / todo
  config.ts               提供商、home、设置描述
scripts/
  build.mjs               esbuild 打包
  dev.mjs                 打包后启动 Electron
  serve.ts                只跑宿主（浏览器联调用）
  mock-gateway.ts         UI 联调用的 OpenAI 兼容 mock
test/
  loop.test.ts            agent loop 端到端（mock 网关）
  adapters.test.ts        responses / anthropic 适配器
```

## 验证现状

- `npm run typecheck` 通过
- `npm test`：4 个用例通过（agent loop 工具链、follow SSE、两种协议适配器）
- 浏览器联调：真实 `web/dist` + mock 网关完成一轮 todo → bash → 文本的流式对话
- `DENIA_SMOKE_SHOT=<png>`：Electron 启动后自动截图退出，用于验证真实窗口加载

## 下一步建议

1. 把审批策略（permission mode）与 `bash`/写文件的门控接进 loop
2. 会话标题生成、context 压力统计与压缩
3. 系统提示分包（persona / 工具纪律 / AGENTS.md）
4. MCP、子代理、技能、项目记忆
5. 桌面能力：原生目录选择器、自定义标题栏（Electron 的 `app-region`）、托盘