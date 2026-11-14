# 远程访问与移动端接入

这份文档是**服务端**对外契约，供 Android / iOS 原生客户端实现时对照。网页端也会用同一套接口，但网页只是顺带支持，不是目标形态。

## 1. 形态

宿主（桌面 Electron 进程）在自己的回环端口之外，额外监听一个对外端口。手机与另一台电脑连这个端口，用配对换来的设备令牌访问同一套 `/api/*`。

```
手机 App ──HTTP/HTTPS──► 宿主远程端口 ──► 同一套 handler ──► 与桌面完全相同的 API
桌面窗口 ──回环──────► 宿主主端口   ──┘（免鉴权）
```

远程端口默认是主端口 + 1（主端口 43655 → 远程 43656）。两个端口分开是因为 Windows 上 `0.0.0.0:43655` 与 `127.0.0.1:43655` 会争用同一地址。

## 2. 认证

| 场景 | 凭证 |
|---|---|
| 回环来源（桌面窗口、本机浏览器） | 无 |
| 远程来源 | `Authorization: Bearer denia_client_…`，或等值的 `denia_remote_session*` Cookie |

**原生 App 一律用 Bearer**：把令牌放进系统安全存储（Android Keystore / iOS Keychain），不要用 Cookie。

判定「是不是本机」看三件事同时成立：对端地址是回环、`Host` 头是回环名、且没有非回环的 `X-Forwarded-For`。所以反向代理从本机转发进来的请求仍然要令牌。

## 3. 配对流程

```
宿主                          手机 App
 │  POST /api/remote/pairing    │        （仅本机可调）
 │  ← 配对码 / 链接 / 指纹       │
 │ ─────── 二维码或手输 ───────► │
 │                              │  POST /api/remote/redeem   （无需认证）
 │                              │  ← { clientToken, client }
```

宿主设置页会把链接渲染成二维码（纠错等级 L，自动选版本），旁边同时给出 8 位配对码与
指纹。二维码始终是白底黑点，不跟随深色主题——否则对比度不够，手机扫不出来。

### 3.1 配对载荷（v2）

`denia://connect?v=2&p=<base64url(JSON)>`

```json
{
  "v": 2,
  "pairingId": "pair_…",
  "secret": "<32 字节 base64url>",
  "serverId": "<32 hex>",
  "fingerprint": "A1B2-C3D4",
  "label": "书房电脑",
  "expiresAt": "2026-11-11T05:50:01.668Z",
  "candidates": [
    { "type": "tunnel", "url": "https://denia.example.com", "priority": 10 },
    { "type": "lan",    "url": "http://192.168.1.8:43656",  "priority": 20 }
  ]
}
```

- `candidates` 按 `priority` 升序尝试，第一个 `/api/remote/status` 通的就用。
- `secret` 是一次性凭证，**只能出现在内存与安全存储里**，不要写日志、不要拼进 URL query。
- `fingerprint` 供带外核对（显示在宿主屏幕上，也显示在配对待确认页）。
- `serverId` 用于钉住服务器：**先把 `/api/remote/status` 返回的 `serverId` 与它比对，一致才发送令牌**。局域网地址可能被 DHCP 换给另一台机器。

### 3.2 兑换

```
POST /api/remote/redeem
{ "link": "denia://connect?v=2&p=…",          // 或 pairingId + secret
  "clientKind": "mobile",
  "deviceName": "Pixel 9",
  "devicePlatform": "android",
  "appVersion": "1.0.0",
  "dedupeKey": "install:<本地安装 id>" }
```

成功：

```json
{ "ok": true, "clientToken": "denia_client_…",
  "client": { "id": "…", "label": "我的手机", "clientKind": "mobile" },
  "server": { "label": "书房电脑" } }
```

- `dedupeKey` 用同一台设备的稳定安装 id：重复配对只保留一条设备记录，不会堆出幽灵设备。
- 也支持 `{ "code": "YURA-AS2M" }` 手输 8 位码（大小写、连字符不敏感）。
- 失败统一返回 `配对码无效或已过期`，不区分「不存在 / 已过期 / 已被用 / 密钥错」。**不要靠错误文案区分原因**。
- 同一来源 5 分钟最多 10 次，超出返回 429。

## 4. 接口

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/remote/status` | 公开 | 探活 + `serverId` 核对；已认证时 `authenticated: true` |
| POST | `/api/remote/redeem` | 公开（限流） | 兑换配对码 |
| POST | `/api/remote/logout` | 公开 | 清除会话 Cookie |
| GET | `/api/remote/clients` | 本机 | 设备清单 |
| DELETE | `/api/remote/clients/:id` | 本机，或设备吊销自己 | 吊销 |
| POST | `/api/remote/clients/purge` | 本机 | 清除已吊销记录 |
| POST | `/api/remote/enable` / `disable` | 本机 | 开关监听 |
| POST | `/api/remote/pairing` | 本机 | 生成一次性配对码 |
| GET | `/api/remote/pairings` | 本机 | 待配对会话 |
| DELETE | `/api/remote/pairings/:id` | 本机 | 取消配对 |

`/api/remote/status` 给未认证远程返回的最小集：

```json
{ "local": false, "authenticated": false, "enabled": true,
  "listenPort": 43656, "listening": true, "listenerError": null,
  "serverLabel": "书房电脑", "serverId": "…",
  "addresses": { "lan": [], "publicUrl": null } }
```

内网地址清单只发给本机 —— 那等于一份内网拓扑。

## 5. 远程被禁用的能力

以下端点对远程来源一律 403，与令牌无关（判定在鉴权之后、路由之前）：

- `/api/fs/pick`、`/api/fs/pick-files` —— 原生文件选择器会弹在宿主屏幕上
- `/api/open-in-app/*` —— 在宿主机上拉起 GUI 应用
- `/api/update/install` —— 改写宿主机上的程序文件
- `/api/browser/*` —— 宿主机的 CDP 浏览器实例

## 6. 原生客户端的实现要点

1. **令牌存储**：Android Keystore（如 `EncryptedSharedPreferences`）、iOS Keychain（`kSecAttrAccessibleAfterFirstUnlock`）。不要放 SharedPreferences / UserDefaults 明文。
2. **多候选地址**：把整组 `candidates` 存下来，连不上就逐个降级；同时定期用 `/api/remote/status` 复核 `serverId`。
3. **明文传输**：局域网 HTTP 是可用但**不保密**的。跨公网必须走 HTTPS（反向代理或隧道），否则令牌在链路上是明文。Android 需要在网络安全配置里为局域网地址开 `cleartextTrafficPermitted`；iOS 需要 `NSAllowsLocalNetworking`。
4. **事件流**：`/api/events` 是 SSE，用支持自定义请求头的 HTTP 客户端（OkHttp / URLSession）而不是平台 EventSource —— 后者不能加 `Authorization`。
5. **重连**：令牌被吊销会直接 401，不要重试；其余失败按指数退避重试。
6. **配对二维码**：扫码后只需解析 `denia://connect?v=2&p=…`，不要自己拆 payload —— 把整条链接交给 `/api/remote/redeem` 的 `link` 字段，格式只由服务端定义。

## 7. 服务端文件

| 文件 | 职责 |
|---|---|
| `electron/src/host/remote.ts` | 设备台账、配对会话、令牌摘要、来源判定、链接编解码 |
| `electron/src/host/remote-api.ts` | `/api/remote/*` 的 HTTP 面 |
| `electron/src/host/server.ts` | 第二个监听器 + 每个请求的鉴权门 |
| `web/src/components/settings/RemoteAccessSettings.tsx` | 宿主侧的开关与配对面板 |
| `web/src/components/RemoteGate.tsx` | 浏览器访问时的解锁门（原生 App 不用） |

状态文件都在 `DENIA_HOME` 下：`remote-clients.json`（设备与配对，0600）、`remote.json`（监听配置）、`remote-identity.json`（服务器身份，0600）。
