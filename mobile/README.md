# Denia Mobile

Denia 的 Android 远程客户端，用 Flutter 编写。手机通过桌面端已经提供的远程访问端口，使用配对换来的设备令牌访问同一套 `/api/*`，因此会话、模型、工具执行与审批都留在电脑上，手机只负责查看、输入与确认。

服务端契约以 [`electron/REMOTE-ACCESS.md`](../electron/REMOTE-ACCESS.md) 为准；本目录是它的原生客户端实现。

## 功能

- 扫码配对：解析 `denia://connect?v=2&p=…`，按 `priority` 逐个探测候选地址，先核对 `serverId` 再兑换令牌。
- 私有中继：端到端加密的 WebSocket 隧道；中继只看到密文。手机仍用普通 HTTP/SSE 客户端访问本地回环代理。
- 候选刷新：连接成功后重读 `/api/remote/status` 的 `relayCandidate` / `publicUrl`，桌面重启或隧道换地址后自动更新。
- 手动配对：输入桌面端地址（可省略 `http://`）与 8 位配对码；大小写、连字符不敏感。
- 多台电脑：保存多组配对记录，启动时连接上次使用的一台，可随时切换或解除配对。
- 会话：最近会话列表、运行状态、新建会话（选择项目）、删除会话、下拉刷新。
- 对话：历史尾部加载、更早消息分页、SSE 实时增量、Markdown/代码块、思考过程折叠、工具调用与输出、中止与「引导当前轮次」。
- 审批：`approval-asked` 卡片直接回到手机，支持允许一次 / 本会话允许 / 拒绝。
- 权限档位：只读、自动编辑、计划、自动审批、完全访问；改动立即在桌面端生效。
- 模型：读取 `/api/llm/catalog`，按会话选择模型，也可沿用桌面端默认。
- 断线：SSE 指数退避重连；连续失败会重新探测 LAN / 私有中继 / 隧道候选；令牌被撤销时停止重试并回到配对页。
- 安全存储：设备令牌与安装 id 只写入 Android Keystore 支持的 `flutter_secure_storage`，不落 SharedPreferences。

## 目录

```
lib/
  core/           JSON 读取、错误类型、格式化
  models/         配对载荷、服务器记录、会话 DTO、事件折叠
  data/           HTTP/SSE 客户端、配对流程、私有中继 E2EE/代理、安全存储、服务器仓库
  state/          AppController（连接、列表、全局事件）
                  ChatController（单会话快照、流、审批、发送）
  ui/             配对、扫码、会话列表、聊天、设置、组件
test/             纯逻辑单测 + 本地 HttpServer 协议测试 + 首屏 widget 测试
```

关键设计：

- 对话界面沿用 Denia 的黑白配色，但借用参考项目的阅读优先层级：浮动标题件、无框正文、思考胶囊、单行工具调用、已完成回合折叠、分组工具过程和浮动输入岛。输入框只有一个主键：空闲有文字时发送；运行中无文字时停止；运行中有文字时发送引导。
- 结束的一轮会收成「已完成 · N 个工具调用 · M 条消息」一行，点开才显示思考、工具和中间消息；最终回答始终留在折叠外面。会话列表也使用同一套浮动标题和渐变页面。
- `DeniaApi` 对一个 base URL + 一个 Bearer 令牌；候选地址的探测与切换在 `PairingService` / `AppController` 中完成，不会把令牌发到身份不匹配的主机。
- `RelayTransport` 对上层暴露一个 `127.0.0.1:<随机端口>` 的本地 HTTP origin：把请求拆成加密隧道帧，
  再把响应/SSE 块写回本地 `HttpResponse`。所以会话、SSE、审批代码不需要知道中继的存在。
- `relay_crypto.dart` 与宿主 `relay-crypto.ts` 使用同一套 X25519 + HKDF-SHA256 + AES-256-GCM 帧格式；
  `test/relay_crypto_test.dart` 固定了密钥派生方向、计数器与篡改拒绝。
- `SseParser` 是增量解析器，支持分块、CRLF 跨包、多行 data、注释与 `retry:`；`/api/sessions/:id/follow` 和 `/api/events` 共用它。
- `ToolGroupView` 把连续 3 个以上工具调用收成一行，展开后以细线串联；`MarkdownView` 缓存解析树，流式重建不重复解析未变消息。
- `TranscriptFolder` 把 append-only 事件折叠为 UI 行：`assistant-chunk` 只用于实时预览，`assistant-message` 是最终权威；工具调用/结果按 `call_id` 配对；`approval-asked`/`approval-decided` 维护待审批状态。

## 开发

要求 Flutter 3.50+（Dart 3.14+）与 Android SDK（compileSdk 36）。

```bash
cd mobile
flutter pub get
flutter run                 # 连接真机或模拟器
flutter analyze
flutter test
flutter build apk --debug   # build/app/outputs/flutter-apk/app-debug.apk
flutter build apk --release # build/app/outputs/flutter-apk/app-release.apk
flutter build apk --release --split-per-abi  # 每 ABI 约 20–27MB
```

> Windows 下如果 bash 直接调用 `flutter.bat` 出现 CRLF 错误，用
> `cmd.exe /c` 包一层再执行。

## 配对

1. 桌面端打开「设置 → 远程访问」，启用监听（默认主端口 + 1，例如 `43656`）。
2. 点「开启私有中继」，等状态变成「私有中继已连接」。
3. 点「生成配对码」，得到二维码 / 8 位码 / 指纹。二维码候选里 relay 优先，LAN 作为回家后的兜底。
4. 手机打开 Denia：扫码，或粘贴链接，或输入电脑地址与配对码。
5. 首次连接会核对 `serverId` 与二维码一致，再兑换令牌；成功后手机记住候选地址，断线时按优先级回退。

私有中继通过 Cloudflare Quick Tunnel 暴露宿主中继，Cloudflare 只能看到密文。也可以不用中继：
局域网 `http://` 可用但不保密；跨公网直连需要自己配置 HTTPS 反向代理或隧道。App 为此在
manifest 中开启了 `usesCleartextTraffic`，仅用于局域网直连。

## 远程被禁用的能力

与桌面端一致，以下端点在远程来源一律 403，手机端不提供入口：

- 原生文件选择器（会弹在电脑屏幕上）
- 在电脑上打开 GUI 应用
- 安装宿主机更新
- 宿主机的 CDP 浏览器

图片/附件的**发送**暂未实现（桌面端契约支持 `images`，手机输入区只发送文本）。历史消息里的图片会显示。

## 测试覆盖

- 配对链接解析、候选排序/去重、过期与损坏载荷；relay 候选刷新与 LAN 保留
- 私有中继加密：X25519/HKDF 双向密钥、AES-GCM 往返、篡改/重放/跳号拒绝、隧道帧边界
- 磁盘/安全存储仓库的往返与损坏容忍
- SSE 分块/CRLF/多行 data/心跳/关闭冲刷
- 事件折叠：流式合并、权威消息替换、工具配对、审批、权限、失败收尾
- 本地 `HttpServer` 上的真实 HTTP/SSE：Bearer 头、状态、会话分页、prompt、401 错误映射
- 配对流程：错误身份跳过、正确身份兑换、429、手动码归一化
- 未配对首屏 widget 测试

模拟器端到端（真实 relay）：

```bash
# 宿主另开终端启动，并开启远程访问/私有中继后生成配对链接
adb install -r build/app/outputs/flutter-apk/app-x86_64-release.apk
adb shell am start -n dev.denia.mobile/.MainActivity
# 在 App 里粘贴 denia://connect?v=2&p=…；创建会话并发一条消息
```

已验证：模拟器扫码/粘贴链接配对 → 中继 E2EE → 会话列表分组 → 新建会话 → prompt →
reasoning / todo_write / bash 工具卡 → 最终回复全部经 relay 实时到达；重启 App 后从安全存储恢复并重连。

## 已知限制

- App 在后台时系统可能挂起 SSE；回到前台会重建尾部流并补齐事件。没有接入 FCM 推送。
- 一次只连接一台电脑；切换时根页面会重新连接。
- 解锁依赖设备系统锁屏；未额外加生物识别。
- release 构建目前沿用 debug 签名，正式分发前需要配置自己的 keystore。
