# ym0v0 棋局

一个部署在 Cloudflare 上的极简实时棋类对战平台。首页提供五子棋、中国象棋、井字棋、警察抓小偷、扫雷和 2048 六个入口；扫雷入口内可选单人或双人竞速及三种难度，2048 是固定 4×4 的单机游戏。无需注册，创建房间后把邀请链接发给朋友即可开始；单机游戏直接在本机开始，不创建房间。

- 线上地址：<https://play.ym0v0.com>
- 服务端权威裁决：严格棋类拒绝旧修订；并发棋类始终按最新权威局面验证动作
- 匿名签名 Cookie 恢复席位与游客昵称；昵称设置后收起为右上角 Chip
- 首页实时显示按游客去重的在线人数和当前已创建房间数
- 每个房间一个 SQLite-backed Durable Object
- 前两位游客对战，之后进入的游客可实时观战且不能执行玩家操作
- 全站最多同时存在 10 个房间；废弃时会持久记录释放任务，短暂故障后自动重试
- WebSocket Hibernation、完整快照重连、手机与键盘操作
- 可主动退出房间；玩家全部关页后保留 60 秒重连窗口，随后自动废弃旧链接
- 回合制房间在首局开始前由双方选择角色和先后手；双方确认复赛后自动交换角色与先后手
- 中国象棋支持标准棋子走法、九宫、河界、将军/将死、困毙、飞将、三次重复与连续 60 回合无进展自动和棋；不含竞赛规则的长将/长捉责任裁定
- 扫雷支持 9×9/10 雷、16×16/40 雷、30×16/99 雷；单人模式不占房间名额
- 双人扫雷竞速使用同一权威雷区和共同中央安全起点，双方的已揭格与旗帜完全独立；只公开进度，先完成者获胜，踩雷者失败
- 单人扫雷按难度显示个人最佳和全站 Top 10；成绩绑定不可变规则版本并最多保留 180 天
- 2048 只支持固定 4×4 网格，在浏览器本地运行，不创建房间或消耗房间名额；棋盘无法继续移动时自动提交本局分数
- 2048 全站排行榜按签名 Guest 每人一条个人最高分，按 `score` 降序取 Top 10；同分按 `achieved_at`、`guest_id` 确定性排序，绑定不可变的 `2048.solo.4x4.v1`，成绩最多保留 180 天

## 架构

同一个 TypeScript 项目构建 Preact 静态页面与 Cloudflare Worker。Worker 负责会话和路由；`GameRoom` Durable Object 串行处理房间内的 HTTP、WebSocket 和持久化，其内部由统一准入、`RoomRuntime`、`ActionJournal` 与 `SnapshotProjector` 分工，但不增加跨 DO 网络跳转；单例 `RoomDirectory` 管理 10 个房间的容量与 Presence；单例 SQLite-backed `MinesweeperLeaderboard` 按 Guest、难度和规则版本原子保存最佳成绩，单例 SQLite-backed `Game2048Leaderboard` 按签名 Guest 和固定规则版本原子保存个人最高分并生成全局 Top 10，使用独立的分数表与接口，不复用扫雷的难度/preset/计时榜单结构。当前共四类 SQLite-backed Durable Object；排行榜 DO 不计入房间上限。

共享 `GameManifest` 只包含可信纯元数据，客户端 `GameCatalog` 通过静态 allowlist 动态加载本地页面或房间 renderer，服务端 `GameRules` 注册表独立控制规则恢复与新建。浏览器侧保留窄的 `useRoom()` 接口，内部 `RoomSession` 将 WebSocket、HTTPS polling、协议解析和并发动作跟踪分离，因此增加棋类不需要修改会话与重连核心。

五子棋、中国象棋、井字棋和警察抓小偷继续使用严格 revision。新建双人扫雷房使用 `minesweeper.race.*.v1` 和 `actionId + clientSeq + baseRevision` 的并发幂等通道，`clientSeq` 在单个连接内单调；HTTPS fallback 对同一连接串行发送，未知结果会暂停后续序号并从最小 pending 动作恢复，服务端也会拒绝已见更高序号后的未见低序号。旗帜使用显式 `set_flag`；服务端会拒绝已淘汰序号和同序号不同 ID。旧 `minesweeper.duel.*.v1` 只保留已有房间恢复，公共建房 API 也会拒绝。WebSocket 为首选，受限网络下操作仍会立即通过 HTTPS 兼容连接提交；无变化的 fallback sync 返回 `204`，不会反复投影和广播同一快照。单人和竞速扫雷复用同一个纯函数 `MinefieldEngine` 与 `MinesweeperBoard`。

2048 是独立的 `local-game` 页面，首页导航到 `/2048` 后才通过客户端静态 allowlist 动态加载；它只在浏览器内运行固定 4×4 规则，不进入房间协议，不创建 `GameRoom`。结束时通过独立的 `/api/2048/leaderboard` 与 `/api/2048/leaderboard/record` 接口提交或读取客户端分数；`Game2048Leaderboard` 使用不可变的 `2048.solo.4x4.v1`，每个签名 Guest 只保留个人最高分，按分数降序返回全站 Top 10。

单人扫雷榜以签名 Guest 作为匿名身份，昵称从签名会话取得。`minesweeper.solo.v1` 与其他规则版本不混榜，记录在 180 天后由每日清理任务删除。它是客户端计时并提交的休闲榜，已做输入校验、请求限流和最佳成绩原子更新，但不具备完整服务端回放校验，不宣称强反作弊。2048 榜同样按签名 Guest 保存单条个人最高分，`2048.solo.4x4.v1` 与其他规则版本不混榜，分数由客户端提交并在 180 天后清理，因此同样只定位为休闲榜。

初始架构设计、当前扩展说明与调研证据见 [`docs/GOMOKU_PLATFORM_PLAN.md`](docs/GOMOKU_PLATFORM_PLAN.md) 和 [`docs/research/GITHUB_SURVEY.md`](docs/research/GITHUB_SURVEY.md)。

## 本地运行

需要 Node.js 24+。

```bash
npm ci
```

创建不会提交到 Git 的 `.dev.vars`：

```dotenv
SESSION_SECRET=请替换为至少32字节的随机值
```

随后运行：

```bash
npm run dev
```

## 验证

```bash
npm run typecheck
npm test
npm run test:worker
npm run test:e2e
npm run build
```

测试覆盖纯规则/房间状态、五子棋、中国象棋、井字棋、警察抓小偷和扫雷引擎、固定 4×4 的 2048 引擎与本地页交互、2048 客户端排行榜解析、两个独立排行榜 Durable Object、真实 workerd Durable Object、Worker 边界校验、WebSocket/HTTPS 混合并发、秘密状态投影、全局房间容量与 Presence 统计，以及多个独立浏览器身份的昵称、邀请、开局选角、观战、退出与空房回收、断网恢复、完整胜局和复赛换边流程。

## 部署

`wrangler.jsonc` 已配置 Worker、静态资源、`GameRoom`、`RoomDirectory`、`MinesweeperLeaderboard` 和 `Game2048Leaderboard` 四个 SQLite Durable Object 类，以及 Custom Domain `play.ym0v0.com`。

推送到 GitHub `main` 分支会触发 [Deploy production](.github/workflows/deploy.yml)：依次运行高危依赖审计、单元测试、Worker 集成测试、浏览器 E2E 和生产构建，全部通过后才部署到 Cloudflare。同一时间只运行一个生产部署，也可以在 GitHub Actions 页面手动触发。

首次启用需要在 GitHub 仓库设置：

- Actions Secret `CLOUDFLARE_API_TOKEN`：使用 Cloudflare `Edit Cloudflare Workers` 模板创建，并将资源范围限制到当前账号。
- Actions Variable `CLOUDFLARE_ACCOUNT_ID`：Cloudflare Account ID，不属于密钥。

生产 `SESSION_SECRET` 继续只保存在 Cloudflare Secret 中；不要复制到 GitHub。普通 Worker 部署会保留现有 Secret，工作流中的固定 `SESSION_SECRET` 仅供隔离的本地浏览器测试使用。

本地手动部署仍可作为故障兜底：

```bash
npx wrangler login
npx wrangler secret put SESSION_SECRET
npm run deploy
```

生产密钥只能写入 Cloudflare Secret，不要放入 `.env`、源码或 Git 历史。

安全边界：Worker 对 JSON 请求执行 Content-Type、Content-Length 和字节上限校验；会话、建房、房间 HTTP/WebSocket 握手、统计和排行榜入口都有 Guest/IP 维度的软限流，房间内 WebSocket 消息还受 Guest 级限流约束，生产环境还应在 Cloudflare WAF/Rate Limiting 配置分布式规则。静态资源使用 CSP、HSTS、同源隔离、`nosniff` 和禁止 iframe；生产构建不发布 source map。`SESSION_SECRET` 缺失或过弱时 Worker 拒绝启动，客户端清单不是服务端授权边界。

## 增加棋种

1. 在 `src/games/<game>/` 实现并测试确定性的 `GameRules`，注册到 `src/games/registry.ts`。
2. 在 `src/web/games/<game>/` 实现棋盘与展示 adapter，注册到 `src/web/games/registry.tsx`。
3. 为新规则发布不可变的 `ruleSetId`；服务端只从注册表解析规则，不能直接信任客户端提交的 ID。需要在复赛时切换模式的兼容规则，应在服务端注册到同一个显式 `rematchGroup`。

房间协议只传递不透明的棋种 payload，平台核心不读取棋种私有局面。需要隐藏信息的游戏必须实现 `project(authoritativePosition, viewerSeat)`，并为并发游戏明确选择 `concurrent_idempotent`；其他棋类保持 `strict_revision`。规则语义变化应发布新的不可变 `ruleSetId`。

需要首局选角色的回合制规则在 `GameRules.definition.openingRoleIds` 中按先手、后手顺序声明两个稳定角色 ID，并在网页 adapter 中提供对应标签；房间层统一处理认领、开局和复赛换边。每一局内的 `ruleSetId` 保持不可变；本局结束后，玩家可从服务端授权的同组模式中选择下一局规则，修改模式会清除双方复赛准备，双方重新确认后才原子切换规则并开局。
