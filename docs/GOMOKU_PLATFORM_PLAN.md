# ym0v0 棋类对战平台：≤10 人极简方案

方案日期：2026-08-19  
当前执行基线：邀请房 MVP

## 1. 一句话结论

将 `https://play.ym0v0.com` 部署为一个 Cloudflare Worker：它同时提供前端静态资源、少量 HTTP API 和 WebSocket；每个房间对应一个 SQLite-backed `GameRoom` Durable Object，串行裁决并保存完整棋局；另有一个单例 `RoomDirectory` Durable Object 原子管理全站房间容量。除此之外不启用其他 Cloudflare 数据服务。

```mermaid
flowchart LR
    B[浏览器] <-->|静态资源 / HTTP / WebSocket| W[一个 Cloudflare Worker]
    W <-->|按 roomId 路由| R[每房一个 GameRoom Durable Object]
```

平台不设置在线游客人数闸门，但全站同时最多存在 10 个尚未废弃的 Room。单例 `RoomDirectory` 通过带过期时间的租约原子占位；GameRoom 废弃时释放租约，初始化失败会回滚，陈旧临时租约也会自动清理。

## 2. MVP 做什么

- 游客先选择保存在浏览器中的显示昵称，再创建五子棋或中国象棋房间并复制私密邀请链接；另一位游客打开链接加入。
- 前两个不同身份占据两个席位；第三位及之后的游客作为只读观众实时接收完整局面。
- `15×15` 自由五子棋：黑先，横竖斜连续 `>=5` 获胜，无禁手，满盘和棋。
- 休闲中国象棋：红先，支持九宫/河界、所有基础棋子走法、飞将、将死、困毙、三次重复与连续 60 回合无进展自动和棋；暂不实现竞赛规则的长将/长捉责任裁定。
- 服务端权威校验落子、回合、胜负；支持认输和双方确认后再来一局。
- 刷新、短暂断网、Worker/DO 休眠后自动重连并恢复完整局面。
- 手机优先棋盘、落点预览、最近一手、胜利连线、连接状态和明确错误提示。

明确延后：账号、D1、永久棋谱、回放、排位、Elo、排行榜、赛季、快速匹配、棋钟、AI、聊天、举报、管理后台、PWA、KV、R2、Queues 和支付。当前没有账号与历史，因此浏览器数据清除后不承诺恢复旧席位。

## 3. GitHub 调研后的选择

完整证据、活跃度和许可证快照见 [GitHub survey](./research/GITHUB_SURVEY.md)。

| 候选 | 借鉴内容 | 当前决定 |
| --- | --- | --- |
| `cloudflare/templates` | 官方 Worker 脚手架 | 作为起点 |
| `cloudflare/workers-chat-demo` | 每房一个 DO、WebSocket Hibernation、广播 | 作为最接近的服务端参考 |
| `cloudflare/partykit` | 重连和房间生命周期封装 | ≤10 人 MVP 不引入；原生 API 更少依赖 |
| `hulang1024/online-chess` | 五子棋/象棋房间的产品功能 | Java + MySQL + Redis 栈过重，只看产品交互 |
| `boardgame.io` / Colyseus / Nakama | 通用多人游戏能力 | 都要求更多运行时或平台，远超本项目需要 |
| GitHub 上的五子棋项目 | UI、AI、规则测试思路 | 多数无许可证、非权威服务端或技术栈不匹配，不 fork |

结论是：基于 Cloudflare 官方原语独立实现约几百行的房间与规则核心，比改造一个完整开源平台更小、更安全。

## 4. 最小技术栈与目录

- TypeScript + Preact + Vite：小型前端，不引入 UI 组件库。
- 原生 Cloudflare Worker 路由：只有会话、建房和 WebSocket 三类入口，不引入 Hono。
- 原生 Durable Objects WebSocket Hibernation API：不引入 PartyServer。
- DO Storage 的 `get/put` 保存一个 `room` 对象；底层使用 SQLite-backed DO，但应用不写 SQL。
- Vitest 做纯规则单测；Cloudflare Workers 测试工具做 DO 集成测试；Playwright 做双浏览器 E2E。
- 单一 `package.json`、单一 Wrangler 项目，不做 monorepo。

```text
src/
├─ worker.ts                    # 静态资源、会话、建房、WS 路由
├─ game-room.ts                 # Durable Object、席位、持久化、广播
├─ core/
│  └─ game-rules.ts             # 唯一棋类规则接口
├─ games/
│  ├─ gomoku/
│  │  ├─ rules.ts
│  │  └─ rules.test.ts
│  └─ xiangqi/
│     ├─ rules.ts
│     └─ rules.test.ts
├─ shared/
│  └─ protocol.ts
└─ web/
   ├─ App.tsx
   └─ games/
      ├─ gomoku/Board.tsx
      └─ xiangqi/Board.tsx
```

## 5. 棋类扩展缝

平台只认识房间、连接、匿名身份、席位、`revision`、持久化和广播；棋类模块负责初始局面、轮次、动作合法性、局面变化和规则终局。接口保持两个同步纯方法：

```ts
interface GameRules {
  readonly definition: {
    gameType: string;
    ruleSetId: string; // 例如 gomoku.freestyle15.v1 / xiangqi.casual.v1
  };
  create(seats: readonly [SeatId, SeatId]): RulePosition;
  apply(
    current: RulePosition,
    command: { seat: SeatId; payload: JsonValue },
  ): { ok: true; next: RulePosition } | { ok: false; code: string };
}

interface RulePosition {
  data: JsonValue; // 只有对应棋类模块和前端 renderer 理解
  turn: SeatId | null;
  outcome: { kind: "win"; winner: SeatId; reason: string }
    | { kind: "draw"; reason: string }
    | null;
}
```

约束同样属于接口：`create/apply` 必须确定、无 I/O、无时间和随机数、不修改输入；所有状态可 JSON 序列化；规则升级发布新的不可变 `ruleSetId`。平台绝不读取 `position.data.board`，也不出现象棋专用判断。

前端按 `ruleSetId` 从 adapter Map 生成首页入口并选择棋盘，再用 `gameType` 做一致性校验。当前中国象棋已经通过同一扩展缝接入；以后增加第三种棋类只需新增对应 `games/<game>/rules.ts`、测试和 `web/games/<game>/Board.tsx`，再在规则 Map 与 adapter 列表各注册一次；Worker、GameRoom、首页、席位、重连和存储无需改变。

不提前设计通用棋盘、棋子、坐标、吃子或将军接口。当前接口只承诺两席位、确定性、完全信息棋类；真正出现第三类需求时再扩接口。

## 6. 房间、身份与协议

1. 页面启动先调用 `POST /api/session` 并提交规范化显示昵称。Worker 验证并复用已有匿名身份，把昵称与游客 ID 一起写入 HMAC 签名 Cookie；仅在缺失或签名无效时生成高熵匿名 ID。Cookie 设置 `Secure; HttpOnly; SameSite=Lax; Max-Age=2592000`，30 天有效期覆盖房间保留期。
2. `POST /api/rooms` 生成至少 96 bit 随机 `roomId`，并在 `GameRoom` 初始化时原子地把创建者身份绑定到 Seat A，再返回 `/r/:roomId` 邀请链接。身份或席位令牌不放进 URL。
3. `GET /api/rooms/:roomId/websocket` 检查同源 `Origin` 和 Cookie，再把升级请求转发到对应 DO。
4. 创建者固定为 Seat A；邀请链接只允许第一个不同的匿名身份占 Seat B，之后的不同身份以 Spectator 身份进入。相同身份刷新或多标签页仍回到原席位或观众身份。

协议使用小型 JSON，不需要二进制：

```json
{
  "v": 1,
  "type": "game_action",
  "gameType": "gomoku",
  "ruleSetId": "gomoku.freestyle15.v1",
  "expectedRevision": 12,
  "payload": { "type": "place", "x": 7, "y": 7 }
}
```

服务端返回 `snapshot`，包含 `gameType`、`ruleSetId`、最新 `revision`、自己的席位、双方状态和完整 `RulePosition`。认输和准备复赛是平台命令；复赛必须双方确认，并交换先后手。

客户端 envelope 中的 `gameType/ruleSetId` 只用于版本一致性检查；服务端始终使用房间初始化时持久化的不可变 `ruleSetId` 选择规则模块，不一致立即拒绝，绝不按客户端字段切换规则。

每个已接受命令令 `revision + 1`。DO 逐条执行：校验消息 → 校验身份、规则 ID 与 revision → 调用房间已绑定的规则模块 → `storage.put("room", nextState)` → 广播完整 snapshot。必须先持久化再广播。并发落子会被 DO 串行化，后到的旧 revision 被拒绝并获得新 snapshot。

五子棋完整快照通常只有几 KB；当前小规模房间中，全量同步比 delta、事件日志、补包和命令去重缓存更简单可靠。客户端断线后指数退避重连，离线时禁用操作，重连以服务端 snapshot 覆盖本地状态。

DO 使用 WebSocket attachment 保存身份和席位，使 Hibernation 唤醒后可恢复连接上下文。一个简单 alarm 清理过期房间：等待房 1 小时无活动、结束房 24 小时、进行中房 7 天无活动；到期前若有新活动则重新安排。

## 7. 棋种实现

### 五子棋

棋盘用长度 225 的数组，值为 `empty/black/white`。`apply` 只接受 `{type:"place", x, y}`，依次验证局未结束、行动席位、坐标范围和空位；落子后只沿横、竖、两条斜线从最新落点向两边计数，复杂度为 `O(15)`，不需要 WASM、位棋盘或 AI 引擎。

必须覆盖的规则测试：四个方向、边角落子、五连与长连、占位、越界、非当前席位、终局后落子和满盘和棋。规则函数在浏览器中只用于落点提示，最终裁决始终来自服务端。

### 中国象棋

中国象棋使用 9×10 交叉点数组；首局 Seat A 为红方先行、Seat B 为黑方，复赛继续沿用平台的先后手交换机制。`apply` 验证将/帅、士、象/相、马、车、炮、兵/卒的基础走法、宫界、河界、炮架、蹩马腿、塞象眼、飞将和自将。对手没有合法着法时，根据是否被将判定将死或困毙；同一完整局面（棋盘加行动方）第三次出现时自动判和。为限制快照与存储增长，吃子或兵卒向前移动会重置重复历史；连续 120 个半回合（60 个完整回合）没有吃子或兵卒前进时自动判和，因此重复表最多保留 121 项。前端 renderer 只负责选择和预览，最终裁决仍来自服务端。

## 8. 性能与体验

- 静态资源、API 和 WebSocket 同源，减少 DNS/TLS、CORS 和 Cookie 问题。
- 首屏 JS gzip 目标 `<100 KB`，硬上限 `150 KB`；不用第三方字体、广告、统计脚本和大型组件库。
- 棋盘使用 Canvas 2D，按设备像素比绘制但 DPR 上限为 2；只在局面或尺寸变化时重绘，不运行永久动画循环。
- 手机棋盘占满可用宽度；指针按最近交叉点吸附，按下/拖动显示半透明预览，抬起才提交。服务端确认前不画实心棋子。
- Canvas 可聚焦，方向键移动落点、Enter 提交；页面同时提供当前回合和最后落点的文本状态。
- 正常落子执行一次小对象写入、一次容量租约续期和一次房间广播。两个 DO 都使用 `locationHint: "apac"`；在最多 10 个房间的规模下优先保证容量语义明确。
- 目标：规则计算 `<1 ms`；同区域落子确认 p95 `<200 ms`；重连恢复 p95 `<1 s`。大陆网络延迟主要受运营商到 Cloudflare 的链路影响，必须用移动、联通、电信实测，普通全球网络不能承诺稳定低延迟。

## 9. 最小安全基线

- 仅接受 `https://play.ym0v0.com` 和明确预览域的 WebSocket Origin。
- 单条客户端消息最多 4 KB；运行时校验消息结构、字符串长度、坐标和枚举值。
- 每连接令牌桶限制约 10 条命令/秒、突发 20；房间创建按匿名身份和 IP 粗限速。
- 房间 ID 至少 96 bit 随机；会话 Cookie、签名和内部异常不写日志、不放 URL。
- 每位游客有显示昵称；统一做 Unicode/空白规范化，拒绝控制字符并限制为 1–16 个 Unicode code point。昵称只渲染为文本，不解析 HTML，也不作为身份凭据。
- 设置 CSP、`X-Content-Type-Options: nosniff`、`Referrer-Policy: same-origin`。不做自由文本聊天，避免首版引入审核面。

匿名休闲局不能提供强反作弊或身份追责；这正是排位和账号延后的原因。

## 10. 部署到 play.ym0v0.com

公开 DNS 已确认 `ym0v0.com` 使用 Cloudflare nameserver，`play.ym0v0.com` 当前未占用。

1. 使用 `create-cloudflare` 生成 TypeScript Worker 项目，加入 Preact/Vite，配置 Static Assets。
2. 在 `wrangler.jsonc` 中绑定一个 `ROOMS` Durable Object 类，并通过当前 Wrangler 的 declarative `exports.GameRoom.storage: "sqlite"` 声明 SQLite-backed DO；不混用旧 migration 配置。
3. 通过 `wrangler secret put SESSION_SECRET` 写入随机会话签名密钥，不提交到 Git。
4. 本地运行规则、DO 集成和双浏览器测试，再执行 `wrangler deploy`。
5. 在 Wrangler 配置或 Cloudflare Dashboard 为 Worker 添加 Custom Domain `play.ym0v0.com`；Cloudflare 自动创建 DNS 记录和证书。
6. 用桌面浏览器、两部手机和三家大陆运营商完成冒烟测试；确认建房、双人加入、落子、认输、复赛、刷新及断网恢复。
7. 记录可回滚的 Worker 版本；上线失败时回滚代码，已有 DO 状态仍采用同一 `schemaVersion` 读取。

开发和预览环境使用不同 DO namespace，避免测试连接进入生产房间。首版状态结构只增不删；真正需要破坏性迁移时发布新 DO 类或加入显式状态迁移。

## 11. 测试与上线门槛

- 纯规则单测覆盖全部合法性和胜负边界。
- DO 集成测试覆盖同时落同一点、旧 revision、伪造席位、错误 payload、存储后广播和休眠恢复。
- Playwright 使用两个独立浏览器 context 完成整局，并覆盖刷新、断网和 360 px 手机视口。
- 容量测试并发创建 11 个房间时必须严格得到 10 个成功与 1 个容量拒绝；房间废弃或初始化失败后名额必须可再次使用。
- 生产只记录错误、房间生命周期、重连次数和 ACK 延迟，不记录 Cookie、昵称或完整棋谱。
- 告警关注 Worker/DO 错误率、请求额度和 p95 ACK；错误率持续超过 1% 或 p95 超过 500 ms 时调查。

## 12. 成本和扩展路径

在 10 人规模下，Static Assets、Worker 和 SQLite-backed Durable Objects 通常可落在 Cloudflare Free 配额，已有域名之外预计增量约 `$0/月`。免费额度可能硬性截断，发布前以账户控制台的当期额度为准并设置用量告警；开始公开推广或接近额度时升级 Workers Paid，常见最低档约 `$5/月`。

| 真实需求出现时 | 只增加这一项 |
| --- | --- |
| 100+ 人或更多房间 | 实时架构不变；每房 DO 已天然分片 |
| 随机匹配 | 一个 MatchQueue DO |
| 账号、跨设备历史、排行榜 | D1 |
| 赛后异步结算或通知 | Queue |
| 大量永久棋谱/导出 | R2，D1 只存索引 |
| 单房大量观众 | SpectatorRelay DO |
| 更多棋类 | 新规则模块 + 新 renderer，不改基础设施 |

不要因为“以后可能需要”提前启用服务；每项都有清晰触发条件。

## 13. 排期与交付验收

- 第 1 天：单项目脚手架、规则接口、五子棋规则和测试、DO 状态读写。
- 第 2–4 天：匿名会话、邀请房、WebSocket 权威落子、完整 snapshot 重连、移动端棋盘。
- 第 5–7 天：认输/复赛、安全限制、E2E、容量测试、域名部署和运营商实测。
- 一名熟悉 TypeScript 的开发者约 4–7 天可交付基础 MVP；中国象棋已通过既有扩展缝作为第二棋种接入。

验收结果必须是：两个新浏览器只凭邀请链接能完成一局；任何并发、刷新、休眠或短暂断网都不会产生双落子或丢失已确认局面；360 px 手机可准确操作；新增棋类时不修改 GameRoom 核心。

## 14. 主要官方资料

- [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [Durable Objects WebSocket Hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Durable Objects Storage](https://developers.cloudflare.com/durable-objects/api/storage-api/)
- [Durable Objects data location](https://developers.cloudflare.com/durable-objects/reference/data-location/)
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
