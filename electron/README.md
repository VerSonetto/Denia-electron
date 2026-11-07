# Denia Electron（进行中）

Rust 后端向 Electron + TypeScript 迁移的工作树。前端 `web/` 原样复用：它只通过
HTTP/SSE 与宿主通信，因此新宿主在进程内起一个本地 HTTP 服务，窗口直接加载
`http://127.0.0.1:<port>`，相对 `/api` 路径与事件流都不需要改。

## 当前范围（首期）

已经跑通的最小闭环：

- **agent loop**：turn/step、流式 chunk、工具调用、并行执行、取消、死循环检测
- **LLM 适配器**：`openai-completions`、`openai-responses`、`anthropic-messages`，
  共享 `StreamAssembler` 保证三条流发出同一套 `StreamChunk`
- **会话存储**：与 Rust 版共用 `~/.denia`，`sessions/<id>/session.jsonl` 格式
  对齐（header version 0 / UUID id / seq 连续）；崩溃遗留轮次加载时补
  `turn-end {aborted, disposed}`
- **共享配置**：读取 `settings.yaml` 的 `llm-openai.providers`、从
  `.credentials.yaml` / 环境变量解析 `apiKeyEnv`；工作区读写 `workspaces.json`
  的 map+order 结构；随附 preset（standard / creator / minimal）与 Rust 对齐
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

宿主默认监听 `127.0.0.1:43655`（Rust 版占用 43654，两个版本可同时运行），home 为
`~/.denia`，与 Rust 版共用同一份会话、设置、凭据与工作区。可用环境变量覆盖：

- `DENIA_HOME`：会话、配置、工作区记录的根目录
- `DENIA_PORT`：监听端口（`0` 表示随机）
- `DENIA_WEB_DIR`：前端构建产物目录（默认 `../web/dist`）
- `DENIA_WEB_URL`：开发时改加载 Vite 地址（`web/` 的 `/api` 代理需指向本宿主）
- `DENIA_OPENAI_BASE_URL` / `DENIA_OPENAI_API_KEY` / `DENIA_OPENAI_MODELS`：
  在既没有 `settings.yaml` 也没有 `config.json` 时构造默认提供商

提供商解析顺序：`<home>/config.json`（本地覆盖，测试/联调用）→
`<home>/settings.yaml` 的 `llm-openai.providers` → 环境变量/内置默认。密钥按
`apiKeyEnv` 先查进程环境、再查 `<home>/.credentials.yaml` 的 `refs`。

本地覆盖文件示例（不存在时不需要创建）：

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

## 构建安装包

```bash
# 1) 构建前端产物（在 web/ 下）
cd web
pnpm install
pnpm typecheck
pnpm exec vite build
node scripts/precompress.mjs

# 2) 打包 Windows NSIS 安装器
cd ../electron
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
npm run dist
```

产物：`electron/release/Denia-Electron-<version>-setup.exe`。

说明：

- 应用身份是 `Denia Electron` / `dev.denia.electron`，与 Rust 版 `Denia` /
  `dev.denia.desktop` 相互独立，不会覆盖旧安装。
- `pnpm build` 会先跑前端 QA 套件；本机 `check-follow` 在无联调环境时会失败，
  它不参与产物，直接跑上面三条构建命令即可。
- 打包使用 `build/icon.ico`（由 `128x128@2x.png` 生成的 256×256 图标）。
- 静默安装：`Denia-Electron-0.2.0-setup.exe /S`（默认按用户安装，无需管理员）。

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