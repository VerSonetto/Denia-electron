# Denia Electron（进行中）

Electron + TypeScript 版的 Denia。前端 `web/` 原样复用：它只通过
HTTP/SSE 与宿主通信，因此宿主在进程内起一个本地 HTTP 服务，窗口直接加载
`http://127.0.0.1:<port>`，相对 `/api` 路径与事件流都不需要改。

## 当前范围

已经跑通的主链路：

- **agent loop**：turn/step、流式 chunk、工具调用、并行执行、取消、死循环检测
- **LLM 适配器**：`openai-completions`、`openai-responses`、`anthropic-messages`，
  共享 `StreamAssembler` 保证三条流发出同一套 `StreamChunk`
- **会话存储**：沿用旧版的 `~/.denia`，`sessions/<id>/session.jsonl` 格式
  对齐（header version 0 / UUID id / seq 连续）；崩溃遗留轮次加载时补
  `turn-end {aborted, disposed}`
- **共享配置**：读取 `settings.yaml` 的 `llm-openai.providers`、从
  `.credentials.yaml` / 环境变量解析 `apiKeyEnv`；项目读写 `projects.json` 的 map+order 结构（一个项目可包含多个目录）；随附 preset（standard / creator / minimal）与旧版对齐
- **工具**：`bash`、`read_file`、`write_file`、`edit`、`ls`、`glob`、`grep`、
  `todo_write`、`exit_plan`、`skill`
- **shell 选择**：`bash` 工具与后台任务跟随系统默认终端——Windows 读取
  Windows Terminal 默认 profile 的 commandline（PowerShell / cmd / Git Bash /
  WSL 都识别），Windows Terminal 不是默认终端或配置不可读时回退 `ComSpec`；
  PowerShell 命令自动加 UTF-8 前导，避免 `>` 写出 UTF-16
- **权限（三层模型）**：四个预设 = 沙箱档案 × 审批策略 × 审批人——
  只读 / 项目编辑 / 自动审批（Approve for me）/ 完全访问；四值决策
  （allow / prompt / prompt-user / forbid）；五值审批（accept、accept-for-session、
  accept-with-rule、decline、cancel）；execpolicy 命令前缀规则
  （`<home>/execpolicy.json`，批准时可持久化 allow 规则）；自动审批用模型
  按严格 JSON 审查，超时/失败一律拒绝；项目记忆写入是独立的 memory-write 类
- **审查面板**：按项目目录聚合 Git 状态；同一仓库自动去重；可切单个目录审查、Diff、提交与推送，也可对全部目录批量提交/推送；非 Git 目录显式标注
- **HTTP/SSE 宿主**：会话列表/创建/快照/分页/发消息/取消/引导、follow SSE、
  全局事件 SSE、模型目录与流式 chat（提示词优化 / 连通性探测）、设置、项目、
  文件树/文件读取、审批应答
- **MCP**：stdio / Streamable HTTP / HTTP+SSE 三种传输；`mcp__<server>__<tool>`
  命名与冲突过滤；已连接工具的完整参数定义直接声明在工具面上（首次调用即执行），
  `mcp_list` 仅作清单发现；`tools/list` 游标翻页、按字符分页与
  `result_id` 续读（续读不重新执行外部工具）；`/api/mcp` 管理端点（增删改、
  启停、重连、逐工具开关）与 `settings.yaml` 的 `mcp` 命名空间持久化
- **子代理 / 后台任务**：内置 explore / develop / verify + 用户级/项目级定义
  （YAML frontmatter + Markdown）；`spawn_agent` / `fork_agent` /
  `create_subagent` / `send_message` / `list_agents` / `wait_agent` /
  `interrupt_agent` / `session_trace`；冻结工具授权、只读权限上限、禁止再派遣、
  后台执行；两者共用同一完成生命周期：结果先落 `agent-inbox`，模型动作中
  等待、`step` 边界转 `agent-delivery`，模型空闲则立即唤醒；
  fork 只复制已闭合历史；`/api/subagent-profiles`、`/api/subagent-tools`
  与 `/api/sessions/:id/agents`
- **技能**：项目/用户/内置分层发现，`SKILL.md` + 资源读取，`skill` 工具，
  `<available_skills>` 目录注入，`/api/skills` 管理端点与 `disabled-skills.json`
- **项目记忆**：`<home>/memories/projects/<slug>-<sha16>/memory/` 桶；
  `MEMORY.md` 索引注入（剔除历史区、行/字节预算）；memory-write 权限类；
  `/api/memories/projects` 列表/读写/检索/重建/体检
- **项目指令**：`AGENTS.md` 每个所选项目目录根各读一个（外加全局 `~/AGENTS.md`），
  子代理仅项目级；按正文变化幂等注入；`/api/global-rules` 读写
- **标题 / 上下文**：首轮后后台生成 `session-title`；`/context-breakdown`
  近似 token 拆分与压力；手动压缩按整轮摘要并落 `compaction-summary`
- **终端**：右侧面板交互式 PTY（Windows ConPTY / Unix pty）；`/api/terminals`
  管生命周期、WebSocket 双向传字节；回滚缓冲、重连 replay、尺寸同步、
  退出码、32 个上限，服务端代答 shell 的光标位置查询
- **Electron 壳**：主进程起宿主，窗口加载 UI
- **窗口**：无边框自绘标题栏；`preload.cjs` 只暴露最小化 / 最大化 / 关闭与
  最大化状态，拖动走 `-webkit-app-region`，最大化状态由主进程窗口事件回推

尚未迁移：渠道（微信 / QQ Bot）；真实 OS 沙箱仍未实现（只读档靠命令
证明 + 工具层路径限制兜底）。渠道端点返回空状态或 501，不影响已迁移的能力。

远程访问（局域网直连 / 设备配对）已实现，接口契约见
[REMOTE-ACCESS.md](REMOTE-ACCESS.md)。对外地址由设置中的 `publicUrl` 提供，
可用于反向代理或隧道；宿主本身不内置隧道进程。

## agent 内核

agent 内核是 Denia 自己的 turn/step 循环，不依赖外部 agent 框架：

- `agent/loop.ts`：从会话日志重建模型可见历史，执行注入、microcompact、
  自动摘要、冻结 system 前缀、工具调用、并行执行、权限 gate、审批、
  loop guard 与最大步数收束；
- `llm/`：三套协议适配器共享 `StreamAssembler`，把 provider 事件统一成
  `StreamChunk`；
- `agent/prefix.ts`：冻结 system 前缀；提示词变化以注入消息追加，避免破坏
  provider 的前缀缓存。

关键设计：

- **日志是唯一事实源**：每个 turn 从 `sessions/<id>/session.jsonl` 重建上下文，
  rewind、重启和子代理投影都沿用同一规则。
- **工具面与执行面分离**：只向模型声明当前权限可见的 schema；执行期仍保留
  隐藏工具，越权调用会得到 Denia 的可读拒绝，而不是“工具不存在”。
- **MCP 工具面**：已连接、已启用的 MCP 工具带完整参数定义进入工具面，模型第一次
  调用就真正执行；连接快照变化（重连、启停、逐工具开关）时重建工具包装。
- **Prompt cache**：OpenAI 发送 `prompt_cache_key`；Anthropic 在 system、最后一个
  tool、消息尾部与历史检查点放置 `cache_control`，并尽量冻结 system 与工具前缀。
- **提供商兼容**：继续读 `settings.yaml` 的 `llm-openai.providers`；自定义
  OpenAI 兼容端点只在 `defaultMaxTokens` 显式配置时发送 `max_tokens`
  （Anthropic 的 `max_tokens` 必填，保留默认值），不主动发送 `store`，避免
  严格网关拒绝请求。

## 权限模型

每个会话存一份权限状态（`permission-selection` 事件），它是三个正交字段：

| 预设 | 沙箱档案 | 审批策略 | 审批人 |
| --- | --- | --- | --- |
| `read-only` | `read-only` | `on-request` | 用户 |
| `project-write` | `project-write` | `on-request` | 用户 |
| `approve-for-me` | `project-write` | `on-request` | 自动审查 |
| `full-access` | `danger-full-access` | `never` | 用户 |

- **沙箱档案决定“能做到什么”**：只读档拒绝一切写与网络，命令必须能被静态证明只读；
  项目档目录内写直接执行，区外写、删除、有写副作用的命令与网络访问走审批；
  完全访问无限制。没有真实 OS 沙箱，只读档由命令证明 + 工具层路径限制兵底。
- **审批策略决定“问了怎么办”**：`never` 不再询问，需审批的动作直接拒绝；
  计划模式（collaboration = plan）禁止一切写，`exit_plan` 必须人审。
- **审批人决定“谁答”**：`user` 走审批卡；`auto-review` 先给审查子代理，
  只把高风险/不确定的升级给用户。自动审批的审查请求不落 `approval-asked`
  （不弹审批卡），而是落 `auto-review` 事件（含风险等级、授权评分、理由）。
- **规则引擎**：`<home>/execpolicy.json` 可放命令前缀规则（allow / prompt /
  prompt-user / forbidden），多条命中取最严；批准时选“以后同类都允许”
  会把 allow 前缀写回该文件。
- **项目记忆写入**：`write_file` / `edit` 落在记忆目录内的 `.md` 归为
  memory-write，四档权限均放行；这些调用不受 `confined` 限制，也不触发审批。

旧的三档事件 `permission-mode`（read-only / auto-edit / plan / full）仍然写入，
现有 Web UI 不改也能正常工作；`approve-for-me` 在旧 UI 中显示为“自动编辑”。

## 上下文注入

模型看到的自动上下文走 `user-message {injected:true, channel}`，每个 step
开始时按通道刷新，内容未变则不重复发送：

- `project-instructions`：`AGENTS.md` 全文（system-reminder 框架）
- `skill-catalog`：`<available_skills>` 摘要列表
- `project-memory`：`MEMORY.md` 索引（仅主代理；子代理不注入）
- `agent-delivery`：子代理 / 后台任务完成通知、父子消息

`deriveHistory` 对上述基线通道只保留最新一条进入模型面；日志仍 append-only。
子代理目录与 MCP 纪律段在系统提示里，不占注入通道。

## 运行

```bash
cd electron
npm install
npm run typecheck
npm test
npm run build
npm start
```

开发模式用 `npm run dev`：它会构建宿主、启动 Vite（默认 5173）并让窗口加载
Vite 地址，前端热更新直接生效。`DENIA_VITE_PORT` 可换 Vite 端口，
`DENIA_WEB_URL` 可复用已有前端地址；宿主端口由 `DENIA_PORT` 决定，默认 43655。

宿主默认监听 `127.0.0.1:43655`，home 为 `~/.denia`；项目注册表首次启动会把旧的 `workspaces.json` 迁移为 `projects.json`。可用环境变量覆盖：

- `DENIA_HOME`：会话、配置、项目记录的根目录
- `DENIA_INSTALL_DIR`：程序安装目录（打包版默认取 Denia.exe 所在目录；开发版取应用包目录）
- `DENIA_PROJECTS_ROOT`：未选择目录的项目的默认根目录（默认 `<DENIA_INSTALL_DIR>/projects`）
- `DENIA_PORT`：监听端口（`0` 表示随机）
- `DENIA_WEB_DIR`：前端构建产物目录（默认 `../web/dist`）
- `DENIA_WEB_URL`：开发时改加载 Vite 地址（`web/` 的 `/api` 代理需指向本宿主）
- `DENIA_SHELL`：覆盖 `bash` 工具与后台任务使用的 shell（默认跟随 Windows
  Terminal 的默认 profile；Windows Terminal 不可用时回退到 `ComSpec`，
  macOS/Linux 用 `bash -c`）
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

MCP 服务器配置写在 `settings.yaml` 的 `mcp.servers`（也可在设置页编辑）：

```yaml
mcp:
  servers:
    - id: fs
      transport: stdio
      command: npx
      args: ["-y", "@modelcontextprotocol/server-filesystem", "D:/work"]
      enabled: true
      disabledTools: []
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

产物：`electron/release/Denia-v<version>-windows-x64-setup.exe`。

安装器行为由 `build.nsis` 与 `build/installer.nsh` 控制:

- 全新安装显示目录选择页;已有安装记录时跳过目录页,覆盖到原来的位置。
- 安装/卸载前自动结束正在运行的 Denia(含内置服务)。
- 应用内更新静默安装并自动拉起新版本;手动安装由完成页启动。

说明：

- 应用身份是 `Denia` / `dev.denia.app`，安装到 `%LOCALAPPDATA%\Programs\Denia`。
  用户数据仍在 `~/.denia`，与旧版共用。
- 更新检查指向本仓库的 Release（`VerSonetto/Denia-electron`）：拉最新版本、
  校对 `SHA256SUMS.txt`，然后启动安装包。
- `pnpm build` 会先跑前端 QA 套件；若本机缺少联调环境导致个别套件失败，
  直接跑 `pnpm exec vite build && node scripts/precompress.mjs` 仍可生成产物。
- 打包使用 `build/icon.ico`（由 `128x128@2x.png` 生成的 256×256 图标）。
- 静默安装：`Denia-v0.6.1-windows-x64-setup.exe /S`（默认按用户安装，无需管理员）。

## 目录

```
src/
  main.ts                 Electron 主进程（起宿主 + 开窗口）
  host/server.ts          本地 HTTP/SSE 宿主与静态资源
  host/services.ts        loop ↔ MCP / 子代理 / 技能 / 记忆 / 注入的接缝
  agent/loop.ts           turn/step 主循环
  agent/history.ts        会话事件 → 模型消息（基线通道折叠、压缩区间）
  agent/system-prompt.ts  基础提示 + 子代理角色/约束 + 额外段
  agent/session-title.ts  标题生成
  agent/compact.ts        手动压缩摘要
  mcp/                    协议、三种传输、客户端、进程池、设置
  subagents/              定义仓库、派遣解析、后台运行时
  skills/                 分层发现、解析、管理、内置技能
  context/                项目记忆、项目指令
  llm/                    三个协议适配器 + 共享 SSE/块组装
  terminal/               交互式 PTY 会话、回滚缓冲与事件流
  session/store.ts        JSONL 会话日志
  tools/                  bash / 文件 / 搜索 / todo / mcp / skill
  config.ts               提供商、home、设置描述
builtin-skills/           随包内置技能（skill-creator / denia-guide / browser-guide）
scripts/
  build.mjs               esbuild 打包
  dev.mjs                 打包后启动 Electron
  serve.ts                只跑宿主（浏览器联调用）
  mock-gateway.ts         UI 联调用的 OpenAI 兼容 mock
```

## 验证现状

- `npm run typecheck` 通过
- `npm test`：264 个用例全部通过，覆盖 turn/step 主循环、三种协议的
  桥接、权限/审批、MCP 三种传输、父子代理派遣/完成投递/fork、技能、
  项目记忆、项目指令、标题与手动压缩、shell 解析、交互式终端与取消收尾
- 前端 `cd web && npx tsc -b && npx vite build` 通过
- `DENIA_SMOKE_SHOT=<png>`：Electron 启动后自动截图退出，用于验证真实窗口
  加载（本次迁移已用真实构建产物截图确认）

## 下一步建议

1. 渠道（微信 / QQ Bot）
2. 真实 OS 沙箱