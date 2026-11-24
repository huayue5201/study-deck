# 卡片 UI / 动画现状（交接文档）

> 面向"换一个会话继续调整卡片动画"的场景。这里记录**当前实现、关键参数、已知限制**，
> 以及改哪里。代码即事实，本文只做导航和决策记录。

## 0. 一句话

卡片 = 主对话里划词后浮出来的解释面板。它支持**无限层嵌套**（卡片里再划词），
祖先卡以「牌堆 / Cover Flow」两种形态呈现，左侧 rail 和卡内分支条负责在层级间跳转。

技术栈：React + 纯 CSS/WAAPI（无动画库），跑在 Tauri 的 WebView（macOS = WKWebView，即 Safari 内核）。
所以网页上能做的动画这里都能做，没有"桌面端受限"的问题。

## 1. 文件地图

| 文件 | 职责 |
|---|---|
| `apps/web/src/components/Card.tsx` | 卡片的全部渲染、动画状态、键盘、拖拽、牌堆/封面 |
| `apps/web/src/components/CardLayer.tsx` | 薄封装，把 props 透传给 Card（无状态） |
| `apps/web/src/App.tsx` | 卡片状态模型（`path` / `branches`）、打开/跳层/切分支/保存 |
| `apps/web/src/lib/selection.ts` | 划词 → anchor（支持消息内和卡片内 `[data-card-id]`） |
| `apps/web/src/styles.css` | 搜 `.card-` / `.card-deck` / `.rail-` / `.branch-` 相关段落 |
| `crates/server/src/lib.rs` | `/api/chat` 的 `parent_card_id`、`parent_text`（嵌套上下文） |
| `crates/store/src/lib.rs` | `cards.parent_card_id`、`stack_depth`（migration 11） |

## 2. 状态模型（App.tsx）

```ts
path: OpenCardState[]        // 根 → 当前，当前卡 = path[path.length - 1]
branches: Record<string, OpenCardState[][]>
                             // key = 父卡身份，value = 其它分支（每条是父卡之后的整条链）
card = path[path.length - 1] // 当前卡
activeIndex = path.length - 1
```

关键函数：

| 函数 | 语义 |
|---|---|
| `branchKey(c)` | `c.id ?? \`draft:${c.anchor.quote}\``（账本命中卡没有 id，用引文兜底） |
| `rememberBranch(parent, chain)` | 把一条"父卡之后"的链登记为分支，按 `chainSignature` 去重 |
| `jumpToLayer(k)` | 跳到 path[k]；被越过的后缀 `rememberBranch` 成分支，**不销毁** |
| `switchBranch(parentIndex, branchIndex)` | 切到某个祖先的另一条分支；当前后缀也存成分支 |
| `openCard()` | 嵌套展开：同父卡 + 同文字区间 → 复用已有卡（0 次模型调用）；否则新增节点 |

`OpenCardState` 字段见 `Card.tsx` 顶部（`id/anchor/level/question/answer/streaming/saved/promotedSessionId/parentCardId/parentText/rect/sourceText`）。

## 3. 三条动画（各管一件事，别混）

| 动画 | 触发 | 实现 | 参数 |
|---|---|---|---|
| `card-in` | 卡片首次挂载 | `scale(0.88) + opacity 0` → 1 | 220ms，`transform-origin: var(--enter-origin)` |
| 切层交叉淡入 | `cardKey` 变化 | 上一张内容渲染成 `.card-ghost` 覆盖层并淡出 | 240ms |
| `card-out` | 关闭 | `.card-stack.closing` 淡出 + 缩到 0.97 | 160ms，之后才 `onClose()` |

重要约束（踩过的坑）：

1. **不要用"切 class 改变 animation"** 来做切层。class 移除时 `animation` 会回落到基础声明，
   浏览器会**重播** `card-in`，看起来像卡片被重新打开了一遍。切层用 ghost 覆盖层，卡片本体不重挂载。
2. **卡片本体保持不透明**。曾经给整卡做 opacity 淡入，结果透出背后的聊天文字，反而像闪烁。
3. `cardKey = \`${activeIndex}:${card.id ?? card.anchor.quote}\`` —— 必须带 `activeIndex`，
   否则同名引文的不同层不会被判定为"切换"。
4. 卡片**位置只在首次挂载时计算一次**（`placedRef`），切层不重算，否则会跳。
5. `--enter-origin` 取自被划文字在卡片内的坐标：`card.rect.center - pos`，clamp 到卡内。

## 4. 牌堆 / Cover Flow（styles.css）

封面（`.card-cover`）的**尺寸和基准位置固定**，两种形态只改 `transform`：

```css
.card-cover {
  position: absolute; left: 54px; top: 18px; width: 380px; height: 232px;
  z-index: 1;            /* 必须在卡片(z-index:10)下面 */
  /* 牌堆形态（默认） */
  transform: translate(calc(76px + var(--d) * 16px), calc(-32px + var(--d) * -12px))
             rotate(calc(var(--d) * 1.7deg));
}
.card-deck.deck-fan .card-cover {   /* 掀开形态 */
  transform: perspective(1400px)
             translateX(calc(var(--d) * var(--spread-l, 118px) * -1))
             translateZ(calc(var(--d) * -140px)) rotateY(30deg) scale(calc(1 - var(--d) * 0.05));
}
```

- `--d`：深度（1 = 紧挨当前卡），由 JS 以内联变量给出。
- `--spread-l`：扇开幅度，按左侧空间算：`clamp(48, (pos.left + 54 - 8) / 层数, 118)`。
- **perspective 写在每张封面自己的 transform 里**，不要用父级 `preserve-3d`：
  3D 排序会和 `z-index` 打架，出现过"封面盖住当前卡"的情况。
- 过渡：`transform 0.3s cubic-bezier(.22,.9,.3,1)`；hover 只 `translateY(-8px)` + 提亮，
  **不要做横向位移**（点击时会点空）。

深度配色（`--d` 驱动）：

```css
background: linear-gradient(158deg,
  hsl(calc(30 + var(--d)*4) 13% calc(17% + var(--d)*3%)),
  hsl(calc(26 + var(--d)*3) 11% calc(10% + var(--d)*1.6%)));
border: 1px solid hsl(34 16% calc(23% + var(--d)*4.2%));
box-shadow: ... inset 0 1px 0 rgba(255,243,220, calc(.09 + var(--d)*.05)),   /* 顶部纸边 */
            inset 1px 0 0 rgba(225,180,106, calc(.06 + var(--d)*.035));       /* 左侧金线 */
.card-cover::after { background: rgba(0,0,0, calc(.04 + var(--d)*.055)); }    /* 深度薄纱 */
```

## 5. 高度自适应 + 流式滚动

- 卡片高度 = `clamp(正文真实内容高 + 头/尾, 360, min(66vh, 620))`，`transition: height .22s`。
- **必须用 `.card-body-inner` 测高**：`.card-body` 是 `flex:1`，`scrollHeight` 永远被撑满，量不出内容高。
- 流式输出用 `requestAnimationFrame` 缓动跟随（`scrollTop += gap * 0.24`），不要每个 token 硬跳。
- 切层时 `bodyRef.scrollTop = 0`（DOM 不重建，不重置就会从上一张卡的滚动位置开始）。

## 6. 交互清单

| 交互 | 位置 | 行为 |
|---|---|---|
| 划词 | 消息内 / 卡片正文内 | 浮出 `解释这段` 按钮 |
| 徽标「第 N 层」 | 卡头 | 切换牌堆 ⇄ Cover Flow |
| 悬停右上热区 | 卡外 40px | 掀开牌堆（`.pile-hotspot`） |
| rail | 卡左侧 | 默认 40px 只显示 `L1..Ln`，悬停展开 172px 显示引文；`⟣N` 直达分支 |
| 分支条 | 面包屑下方 | 列出当前卡的所有分支（`L2 · 引文`），点击切换；**这是"其它卡不见了"的解法** |
| 键盘 | 全局 | `Esc` 关闭（带退场）、`←/→` 在 path 上翻层、`1–9` 切档位；输入框/弹窗内全部让路 |
| 拖拽 | 卡头 | 移动卡片，带视口 clamp + ResizeObserver 重夹 |
| 关闭 | 卡头 × | `requestClose()` → 160ms 退场 → `onClose` |

## 7. 已知限制（按优先级）

1. **分支只在内存里**。关掉卡片堆再打开同一张卡，`branches` 丢失。
   数据库里 `cards.parent_card_id` 是持久的，可按会话 `view.cards` 重建树——这是下一步。
2. **卡片靠近视口顶部时封面被裁**：封面 `top:-14 ~ -50`，`pos.top < 60` 时露不出来。
   可选修法：按 `pos.top` 把封面整体下移（JS 给 `--cover-offset-y`）。
3. **没有 `prefers-reduced-motion` 支持**，系统"减弱动态效果"时仍会播 scale/rotate。
4. 同锚点复用依赖 `sessionCardsRef`，目前只在少数 `fetchSession` 处更新；新建卡后若没刷新，
   复用可能不命中（会多花一次模型调用，不会覆盖数据）。
5. 扇开幅度上限 118px；超宽屏下 Cover Flow 会显得"挤"。
6. 牌堆静止态每层只露 12~16px 边，条目长时标签会被截断。

## 8. 构建 / 验证

```bash
# 前端
cd apps/web && npm run build
# 桌面壳（会内嵌 dist）
cd ../.. && cargo build --release -p desktop
# 打包 + 安装（macOS）
cd apps/desktop && ./make-app.sh && cp -R ../../target/StudyDeck.app /Applications/
# 后端测试
cargo test -p agent -p store -p studydeck-core
```

手工/自动验证要点：

- 数据目录 `~/Library/Application Support/dev.studydeck.app/`（`port` 里有 `{port, token, api}`，`studydeck.db`）。
- 每次改完需重启 App（WebView 不热更新）。
- 无头验证：Chrome `--headless=new --remote-debugging-port=9222`，页面里
  `localStorage.setItem('studydeck.session', <id>)` 后 reload，并点掉首启 gate（`.gate-card .link`）。
- 关键断言：切层后 `document.querySelector('.card').getBoundingClientRect()` 不变；
  `getComputedStyle(card).transform === 'none'`（没有重播放大）；`document.querySelector('.card-ghost')` 在 240ms 内出现后消失。

## 9. 相关提交（最近 → 早期）

```
03ec32f fix(cards): 切层后其它卡不再「消失」——改成分支条
48e375f feat(cards): 分支树——回退不再丢支线，同锚点复用已有卡片
17e3b65 style(cards): 卡片堆叠按深度分色，层次更清楚
84822bb fix(cards): 切层交叉淡入、卡片高度自适应、修掉切换时的重播闪烁
ae44d11 refactor(cards): 动画收敛为三条状态 + 清理冗余样式
c474945 fix(cards): 卡片位置固定、切层淡入、rail 折叠、封面不溢出
7b537d9 feat(cards): 左侧层级标签栏 + 牌堆边缘层号
a78ed89 feat(cards): 卡片固定尺寸、前进栈、有序层号
3779ab7 feat(cards): 静止态改为 Card Pile，掀开后变 Cover Flow
533241c feat(cards): 入场放大动画 + 高度平滑 + 可扇开的卡片堆
```

## 10. 改动画时的检查清单

1. 改了 `transform` → 确认牌堆和掀开两种形态都没溢出视口（`card-cover` 的 `getBoundingClientRect`）。
2. 改了 `animation` → 确认没有把"切层"和"挂载"的动画混在同一个元素上（会重播）。
3. 改了高度 → 确认 `.card-body-inner` 还在，`overflow: auto` 只放在 `.card-body` 上。
4. 改了 z-index → 封面 1 / 卡片 10 / rail 20 / 分支条在卡内 / 弹层 80。
5. 动完手测三点：入场方向、切层不闪、关闭有退场。
