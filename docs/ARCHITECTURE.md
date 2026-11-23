# 架构

## 一句话

**把「读到不懂的词 → 就地展开 → 不丢主线 → 沉淀成账本」做成一个可运行的应用。**

主对话是线性的，但理解不是。所以这里把「展开」从**跳转**变成**叠加**：选中主线回答里的
任意一段文字，浮出一张卡片，卡片里可以继续追问，关掉时自动记账，主线的位置和上下文不受影响。

## 分层

```
apps/desktop/src-tauri   Tauri 壳：起本地服务 + 开窗口 + 深链
apps/web                 Vite + React + TS：消息流、划词、卡片、账本
crates/server            axum：HTTP + SSE、轮次登记表、鉴权、导出
crates/agent             provider（OpenAI 兼容 / 演示）+ 上下文装配 + 工具循环
crates/store             SQLite：会话 / 消息 / 卡片 / 账本，版本化迁移
crates/core              纯领域模型：无 async、无 I/O、无 UI 依赖
```

依赖方向只有一个：

```
apps/* ──► agent ──► core ◄── store
```

`core` 不认识网络、SQLite 和 UI。想加 CLI 或第二个前端，复用的是 `agent` + `store`，
不需要动任何界面逻辑。

## 四个机制（这是产品，不是功能列表）

| 机制 | 落点 |
|---|---|
| **依赖清单 + 深度契约**（能调 / 能改 / 能推） | `core::Depth` 的 `directive()` 直接拼进卡片 prompt，改变的是「解释到什么程度就停」 |
| **带坐标的展开** | `CardAssembler` 只给「术语 + 前后 240 字 + 目标深度 + 面包屑」，不塞整段历史 |
| **账本** | 关卡片自动写；`term` 是原文选区，`gist` 是答案前 160 字，`anchor` 保留回跳能力 |
| **深度预算** | 卡片内文字不绑定划词监听，只能展开一层 |

## 支线升级：Card → Topic → Session

卡片是微观层，只解释一个概念；当它需要系统化时，升级为专题：

```
Card（锚点 + 一层解释）
  └─ promote ─► Topic（长期知识单元）
                  └─ Session（一次具体讨论，可多个）
```

关键约束：

- **不复制父会话历史**。升级时只保存 `SessionSeed`：来源会话、来源消息、字符锚点、前后 240 字、
  卡片结论、目标深度。主线的 `MainAssembler` 在 system 里注入这个起点包。
- **幂等**。`cards.promoted_session_id` 记录升级结果；同一张卡重复调用返回同一个会话。
- **来源和知识分开**。`session_links` 记录“从哪来”，`topics` / `topic_edges` 记录“知识上什么关系”。
- **扩展点**。`topics.metadata`、`session_seeds.metadata`、`session_links.kind` 都是 JSON/字符串，
  插件可以挂数据，不需要改 schema。HTTP 能力声明 `CAPS` 里增加了 `promote`、`topics`。

## 专题工作区

专题页是 Card → Topic → Session 之后的组织层：

- Topic 可挂多个 Session；Session 的 `topic_id` 是唯一归属，可关联/移出。
- `topics.outline_md` 保存学习地图；先存 Markdown，后续再升级成结构化节点。
- `topic_edges` 保存知识关系：`from` 是先修/前置，`to` 是依赖方。
  - `prerequisite`：添加时从 `to` 出发做 BFS，检测是否会回到 `from`。
  - `related`：对称展示，不参与先修排序。
- 关系建议从升级卡片的「前置依赖（一层）」解析；同名专题复用，不存在时由前端创建。
- 专题上下文会注入每一轮 system prompt（`topic_block`），所以专题下的新会话不需要重新复制起点包。

## 课程与课表

课程是专题之上的编排层：

- `courses`：标题、目标、起止日期。
- `course_items`：`course_id + topic_id` 唯一；`position` 决定顺序，`planned_at` 是课表日期，
  `status` 是 planned / learning / done。
- 先修警告不是另存一份关系，而是在读取课程时用 `topic_edges` 现算：
  前置专题不在课程中，或位置排在当前专题之后，就提示“先修未满足”。
- `auto-order` 用课程内专题的 `prerequisite` 边做 Kahn 拓扑排序；有环时保留剩余条目的原顺序，
  不丢条目。
- `auto-schedule` 从课程开始日期（或今天）起，按 `daily_minutes` 和学习日把条目排进同一天或后续学习日；同一天可放多个条目。
- 删除课程只删 `courses` / `course_items`；专题和会话保留，避免误删知识资产。

## 结构化学习地图与提醒

- `topic_outline_nodes` 把 Markdown 大纲拆成可勾选节点；同名节点重解析时保留原状态。
- 课程页拖拽只改 `course_items.position`，不改专题关系。
- 今日提醒由 `/api/reminders` 现算：`planned_at <= today` 且 `status != done`。
- 日历导出是 `.ics`（全天事件 + VALARM），不绑定系统日历 API；用户把文件导入日历即可。

## 删除专题

删除是一个事务，先清理关联再删专题：

- `topic_outline_nodes`、`topic_edges`、`course_items` 全部删除或移除
- `delete_sessions=false`：会话保留，`sessions.topic_id` 置空，变成普通会话
- `delete_sessions=true`：消息、卡片、来源包、会话一起删除，并清掉源卡片上的 `promoted_session_id`
- 账本条目始终保留

## 项目只读工具

`/api/ask` 的 cwd 会作为 `project_root` 进入 `TurnSpec` / `TurnRequest`。Agent 的
`ToolContext` 对该目录做 canonicalize，并拒绝 `/` 和用户 home 根目录。

工具只读：`read_file` / `list_dir` / `search_text`。路径解析后必须仍在 root 下，
敏感文件（`.env`、`.ssh`、`.git`、密钥等）拒绝读取。普通 App 会话没有 cwd 时不挂这些工具。

## 上下文预算与成本

Agent 在每次请求前做一次保守 token 估算（中文按字、ASCII 按 4 字符/token），并执行：

- 输入预算 32K tokens
- 主线只保留最近能放下的历史，较早消息压成摘要
- 工具结果单条最多 12K 字符
- 输出 `max_tokens=4096`
- 卡片追问历史最多 3000 字，旧解释最多 500 字
- 每轮 prompt/completion token 写入 `turn_usage`，会话接口返回累计值

这避免长会话每轮重复发送全部历史，也防止工具结果撑爆上下文。

## 几个关键决定

**锚点是字符区间 + 原文快照，不是像素坐标。**
滚动、缩放、字体变化后仍能还原。前端只在一处做 `Range` ↔ 字符偏移的换算
（`apps/web/src/lib/selection.ts`），其他地方一律用 `Anchor`。

**一轮对话是一个对象，不是一条连接。**
`crates/server/src/turn.rs` 维护登记表：状态、事件序号、环形缓冲、取消令牌。
没有它，「这一轮跑完没有」只能靠 SSE 连接是否还活着来猜——连接一断就全丢，
编辑器和网页端都没法可靠地显示状态。

**取消要连断流一起。**
客户端断开 SSE 就取消这一轮。这比「用户点取消」更常发生，否则没人要的结果还在烧 key。

**前端产物编进二进制。**
`rust-embed` 把 `apps/web/dist` 放进 server，桌面版因此是单文件自包含的（不需要带
`dist/` 目录），也避免了「路径找不到」这一类问题。代价是改前端要重新 `cargo build`。

**密钥不进仓库、不进 settings.json。**
优先写 macOS 钥匙串；钥匙串不可用时退化成 `0600` 文件，并在 UI 里提示。

**结构变更走 `schema_migrations`。**
增量、可重放；老库启动时自动补列。没有这一步，每次加字段都是一次赌博。

## 有意不做

- **不给窗口几何 API**：外部应用的坐标混进编辑器布局的地图，只会让人误读。
- **不做「最后一段回答」端点**：turn + messages 已经覆盖，多一个缓存就多一处不一致。
- **不在编辑器侧再养一套状态机**：状态权威只在应用这一侧。
- **不做多用户 / 云同步**：本地工具的最大卖点就是没有账号。

## 规模

约 2,400 行 Rust + 1,500 行 TypeScript/Lua（含插件侧），其中「agent 运行时」
（循环 + provider + 工具）约 400 行——它买到的是对上下文装配的控制权，不是 agent 平台。
