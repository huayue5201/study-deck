# 外部客户端协议

StudyDeck 对外的能力收敛在**轮次（turn）**上。这一层是给编辑器插件、脚本、CLI 用的：
它们不需要理解会话，只需要知道「我发了一轮，它跑完了没有、结果在哪、能不能停」。

> 这份文档描述 `api: 2`。握手文件里的 `caps` 是能力自述，客户端应当先读它再调用，
> 而不是 try-and-fail。

## 1. 找到实例

桌面版把服务绑在 `127.0.0.1:0`（系统分配端口，避免和任何东西抢端口），启动后写一个
握手文件到数据目录：

| 平台 | 路径 |
|---|---|
| macOS | `~/Library/Application Support/dev.studydeck.app/port` |
| XDG | `$XDG_DATA_HOME/dev.studydeck.app/port` |

```json
{
  "port": 51619,
  "pid": 73438,
  "api": 2,
  "caps": ["turns", "events", "cancel", "sessions", "glossary", "export", "token"],
  "token": "eea045fa445f492094d4f71887650fab"
}
```

- 文件权限 `0600`（同目录还有 SQLite 数据库和密钥）。
- **`pid` 用来判活**：进程不在了，文件就是残留，客户端不应再连。
- `api` 是协议版本；`caps` 是能力集合，老客户端读新 app 不会崩（多余字段忽略），
  新客户端对老 app 可以降级。

## 2. 鉴权

除 `/api/health` 外，所有 `/api/*` 都要求：

```
Authorization: Bearer <token>
```

令牌每次启动随机生成，写进握手文件。网页端不需要额外分发——服务端会把
`<meta name="deck-token" content="…">` 注入 `index.html`，SPA 从 DOM 里读。

本地开发想关掉鉴权：`STUDYDECK_NO_AUTH=1`。

未授权返回 `401`：

```json
{"error": "缺少或错误的 Bearer token（见数据目录的 port 文件）"}
```

## 3. 投递一轮

```bash
PORT=$(python3 -c 'import json;print(json.load(open("'$HOME'/Library/Application Support/dev.studydeck.app/port"))["port"])')
TOKEN=$(python3 -c 'import json;print(json.load(open("'$HOME'/Library/Application Support/dev.studydeck.app/port"))["token"])')

curl -N -X POST "http://127.0.0.1:$PORT/api/ask" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"text": "解释一下这段代码\n\n<nvim-context rust>\ncwd: /repo\n</nvim-context>"}'
```

`POST /api/ask` 的 body：

| 字段 | 说明 |
|---|---|
| `text` | 原样收下的提问。`<nvim-context>` 块按普通文本处理，模型自己会读 |
| `cwd` | 可选。缺省时服务端从 `text` 里的 `cwd:` 行抠；再缺省为 `inbox` |

**同一 cwd 复用同一条会话**，所以同一个仓库里的提问自带连续性，换仓库就是干净的新上下文。

### 响应

`text/event-stream`，同时带两个头：

```
x-deck-turn: 96e2e03c-…
x-deck-session: ab669159-…
```

首帧是这一轮的坐标：

```
id: 1
data: {"type":"turn_started","turn_id":"96e2e03c-…","session_id":"ab669159-…"}
```

之后是 `assistant_start` / `delta` / `tool_call` / `tool_done` / `done` / `error` /
`cancelled` / `end`。**每一帧都有 `id: <seq>`**。

## 4. 事件与续传

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/turns?active=1` | 列出轮次（状态、seq、消息 id） |
| GET | `/api/turns/{id}` | 单轮详情 |
| GET | `/api/turns/{id}/events?since=N` | 回放 + 实时（也支持 `Last-Event-ID` 头） |
| POST | `/api/turns/{id}/cancel` | 取消 |

回放语义：先补 `seq > since` 的历史事件，再无缝接上实时广播。**订阅在快照之前**，
所以中间不会漏；重复的 seq 会被过滤。客户端应当记录最后见到的 `id`，断线后带上
`Last-Event-ID` 或 `?since=`。

事件缓冲是环形队列（2000 条），溢出丢最老的——`delta` 本来就不能拼接重放，
丢了不心疼；**最终文本在数据库里**，不在缓冲里。

## 5. 状态

每个轮次只有四种状态：

```
running → ok | error | cancelled
```

`messages.status` 会同步落库（用户消息 `ok`；助手消息先 `running`）。应用崩溃或强退后，
下次启动会把残留的 `running` 收敛成 `error`——所以 UI 里不会永远转圈。

## 6. 并发与取消

- **同一会话同时只允许一轮**。冲突返回 `409`：

  ```json
  {"error": "这个会话还有一轮在跑", "active_turn": "96e2e03c-…"}
  ```

- **客户端断开 SSE 即取消这一轮**：没人要结果，就不该继续烧 token。
- 主动取消后，已经推送给客户端的内容会被保留（DB 里 `status=cancelled`，正文是半截答案）。

## 7. 深链

```
studydeck://session/<session-id>
```

macOS 上通过 `CFBundleURLTypes` 注册，`RunEvent::Opened` 接收；应用会把窗口导航到
`http://127.0.0.1:<port>/?session=<id>`，SPA 启动时优先读这个参数。

## 8. 客户端最小实现

一个编辑器插件只需要四件事：

1. 启动时读握手文件，拿 `port` / `token` / `caps`；
2. 发问：`POST /api/ask`，读首帧拿 `turn_id`；
3. 观察：SSE 流结束（或轮询 `/api/turns/{id}`）即「跑完了」；
4. 打断：`POST /api/turns/{id}/cancel`。

参考实现：`ask-agent.nvim` 的 `lua/ask_agent/backends/deck.lua`（约 190 行，含注释）。
