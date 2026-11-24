# Denia

Electron + TypeScript 的本地 agent 桌面端，复用 `web/` 的 React 控制台。
宿主在进程内启动 HTTP/SSE 服务，窗口加载 `http://127.0.0.1:<port>`；前端只通过
相对 `/api` 与事件流通信，构建产物由宿主同源提供。

## 目录

- `electron/`：主进程、HTTP/SSE 宿主、pi agent 内核、工具、MCP、子代理、
  浏览器、会话存储与桌面打包
- `web/`：React 控制台；Vite 开发服务器把 `/api` 代理到本地宿主
- `scripts/`：本地检查与联调脚本

权威的宿主说明、能力范围与目录细节见 [electron/README.md](electron/README.md)。
远程访问与移动端接入的接口契约见
[electron/REMOTE-ACCESS.md](electron/REMOTE-ACCESS.md)。

## 开发

要求 Node.js 22+。

```bash
cd electron
npm install
npm run dev        # 启动宿主 + Vite HMR + Electron，前端改动即时生效
```

`npm run dev` 会自行在 `127.0.0.1:5173` 启动 Vite，并让 Electron 直接加载它；
`DENIA_VITE_PORT` 可换端口，已有前端地址时可用 `DENIA_WEB_URL` 跳过内置 Vite。

只跑宿主（不启动 Electron，适合浏览器联调）：

```bash
cd electron
node scripts/serve.ts
```

前端单独开发（需要另开宿主）：

```bash
cd web
pnpm install
pnpm dev           # http://127.0.0.1:5173
```

宿主默认监听 `127.0.0.1:43655`，Vite 默认把 `/api` 代理到同一端口；
可用 `DENIA_API_URL` 覆盖。`DENIA_HOME` 默认为 `~/.denia`，会话、设置、凭据、
项目记录与记忆都存放在这里。

## 检查与构建

```bash
powershell -NoProfile -File scripts/check.ps1             # Electron 类型检查 + 测试；前端测试 + 类型检查 + 构建
powershell -NoProfile -File scripts/check.ps1 -SkipBuild  # 跳过前端构建
```

Windows 安装包：

```bash
cd web
pnpm build                          # 测试、类型检查、Vite 构建与预压缩
cd ../electron
npm run dist                        # esbuild 打包宿主 + NSIS 安装器
```

产物在 `electron/release/Denia-v<version>-windows-x64-setup.exe`。
发布流程见 `.github/workflows/electron-release.yml`：手动 dispatch，或推送与
`electron/package.json` 版本一致的 `v*` 标签。

测试网关：`node scripts/mock-gateway.mjs` 在 `127.0.0.1:8788` 提供 OpenAI
兼容接口，注册 `http://127.0.0.1:8788/v1` 即可在没有真实密钥的情况下跑通
agent loop。
