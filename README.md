# ym0v0 棋局

一个部署在 Cloudflare 上的极简实时棋类对战平台。首页提供五子棋、中国象棋、井字棋、挑夹棋、警察抓小偷、扫雷和跳棋七个联机入口，以及 2048、贪吃蛇、推箱子、坦克大战和叠叠高五个本地入口；扫雷入口内可选单人或双人竞速及三种难度，跳棋支持创建 2、3、4 人联机房间，2048 可选 4×4、5×5 或 6×6 单机地图，推箱子提供 Microban 前 20 个经典关卡。无需注册，创建房间后把邀请链接发给朋友即可开始；本地游戏直接在本机开始，不创建房间。

- 线上地址：<https://play.ym0v0.com>
- 服务端权威裁决：严格棋类拒绝旧修订；并发棋类始终按最新权威局面验证动作
- 匿名签名 HttpOnly Cookie 以最长 400 天滚动窗口恢复席位、游客昵称与个人记录；昵称设置后收起为右上角 Chip
- 首页实时显示按游客去重的在线人数和当前已激活房间数；刚创建但尚未建立首个连接的房间仍占用临时容量租约，不计入该统计
- 每个房间一个 SQLite-backed Durable Object
- 房间按规则声明的玩家席位数坐满后开始，之后进入的游客可实时观战且不能执行玩家操作
- 全站最多同时存在 10 个房间；废弃时会持久记录释放任务，短暂故障后自动重试
- WebSocket Hibernation、完整快照重连、手机与键盘操作
- 可主动退出房间；玩家全部关页后保留 60 秒重连窗口，随后自动废弃旧链接
- 需要角色的双人回合制房间在首局开始前由双方选择角色和先后手；终局后所有玩家确认复赛，系统自动轮换先手顺序
- 中国象棋支持标准棋子走法、九宫、河界、将军/将死、困毙、飞将、三次重复与连续 60 回合无进展自动和棋；不含竞赛规则的长将/长捉责任裁定
- 挑夹棋使用五花主图加十字菱形；双方初始各五子，支持直线长走、无尾夹换/挑换、“二子不挑、独子不夹”和菱形最右尖端困子终局
- 跳棋使用标准 121 孔六角星棋盘，支持创建 2、3、4 人联机房间；每方 10 子，可单步或连续跳跃，率先全部进入正对面营地者获胜
- 扫雷支持 9×9/10 雷、16×16/40 雷、30×16/99 雷；单人模式不占房间名额
- 双人扫雷竞速使用同一权威雷区和共同中央安全起点，双方的已揭格与旗帜完全独立；只公开进度，先完成者获胜，踩雷者失败
- 单人扫雷按难度显示个人最佳和全站 Top 10；成绩绑定不可变规则版本并最多保留 180 天
- 2048 支持 4×4、5×5、6×6 网格，在浏览器本地运行，不创建房间或消耗房间名额；棋盘无法继续移动时自动提交本局分数
- 2048 按地图尺寸独立排名；每个签名 Guest 在每种地图保留一条个人最高分，按 `score` 降序取 Top 10，同分按 `achieved_at`、`guest_id` 确定性排序；三种地图分别绑定不可变的 `2048.solo.4x4.v1`、`2048.solo.5x5.v1`、`2048.solo.6x6.v1`，成绩最多保留 180 天
- 贪吃蛇使用经典 20×20 有墙地图，支持方向键/WASD、触摸滑动、屏幕方向按钮、暂停和重开；吃到食物后增长、加分并逐步加速，撞墙或撞到自身后结束
- 贪吃蛇显示个人最高分和全站 Top 10；每个签名 Guest 在不可变规则版本 `snake.solo.20x20.v1` 下保留一条个人最高分，成绩最多保留 180 天
- 推箱子内置 Microban 第 1–20 关，支持方向键/WASD、触摸滑动、屏幕方向按钮、撤销、重开、上一关/下一关和关卡选择；局面纯本地运行，不创建房间，按签名 Guest 保存每关最少步数和通关记录 180 天并在下次访问恢复（清除 Cookie 或更换设备会成为新 Guest）
- 坦克大战使用 13×13 本地地图，支持方向键/WASD 驾驶、空格开火、暂停和重开；消灭三台会移动和开火的敌方坦克即可获胜，局面不创建房间也不上传成绩
- 叠叠高使用全屏 Three.js 立体场景，支持点击、触屏、空格或回车落块；超出塔身的部分会切除并坠落，移动方向逐层交替且速度随分数提升，连续完美落点可恢复平台尺寸；最高层数仅保存在当前浏览器
- Microban 关卡由 David W. Skinner 创作，依“可自由转载但须署名”的原作者许可分发；游戏页保留可见署名，固定 GitHub 来源与核验记录见 [`docs/research/SOKOBAN_LEVELS.md`](docs/research/SOKOBAN_LEVELS.md)

## 架构

同一个 TypeScript 项目构建 Preact 静态页面与 Cloudflare Worker。Worker 负责会话和路由；`GameRoom` Durable Object 串行处理房间内的 HTTP、WebSocket 和持久化，其内部由统一准入、`RoomRuntime`、`ActionJournal` 与 `SnapshotProjector` 分工，但不增加跨 DO 网络跳转；单例 `RoomDirectory` 管理 10 个房间的容量与 Presence；`MinesweeperLeaderboard`、`Game2048Leaderboard` 和 `SnakeLeaderboard` 三个 SQLite-backed 单例分别按各自不可变规则版本原子保存个人最佳并生成 Top 10；`SokobanProgress` 使用固定 64 个确定性分片，表内按 `guest_id` 隔离，每个 Guest 至多幂等保存二十个关卡的最佳步数，记录保留 180 天后清理，避免为匿名访问者无限创建 Durable Object。当前共六类 SQLite-backed Durable Object；排行榜和进度 DO 都不计入房间上限。

共享 `GameManifest` 只包含可信纯元数据，客户端 `GameCatalog` 通过静态 allowlist 动态加载本地页面或房间 renderer，服务端 `GameRules` 注册表独立控制规则恢复与新建。浏览器侧保留窄的 `useRoom()` 接口，内部 `RoomSession` 将 WebSocket、HTTPS polling、协议解析和并发动作跟踪分离，因此增加棋类不需要修改会话与重连核心。

五子棋、中国象棋、井字棋、挑夹棋和警察抓小偷继续使用严格 revision。新建双人扫雷房使用 `minesweeper.race.*.v1` 和 `actionId + clientSeq + baseRevision` 的并发幂等通道，`clientSeq` 在单个连接内单调；HTTPS fallback 对同一连接串行发送，未知结果会暂停后续序号并从最小 pending 动作恢复，服务端也会拒绝已见更高序号后的未见低序号。旗帜使用显式 `set_flag`；服务端会拒绝已淘汰序号和同序号不同 ID。旧 `minesweeper.duel.*.v1` 只保留已有房间恢复，公共建房 API 也会拒绝。WebSocket 为首选，受限网络下操作仍会立即通过 HTTPS 兼容连接提交；无变化的 fallback sync 返回 `204`，不会反复投影和广播同一快照。单人和竞速扫雷复用同一个纯函数 `MinefieldEngine` 与 `MinesweeperBoard`。

2048 是独立的 `local-game` 页面，首页导航到 `/2048` 后才通过客户端静态 allowlist 动态加载；它只在浏览器内运行 4×4、5×5 或 6×6 规则，不进入房间协议，不创建 `GameRoom`。`/2048` 默认打开 4×4，也可用 `?size=5` 或 `?size=6` 直达其他地图。结束时通过独立的 `/api/2048/leaderboard` 与 `/api/2048/leaderboard/record` 接口提交或读取客户端分数；`Game2048Leaderboard` 按不可变地图规则版本隔离数据，每个签名 Guest 在每种地图只保留个人最高分，按分数降序返回各自的全站 Top 10。

贪吃蛇也是独立的 `local-game` 页面，访问 `/snake` 时才动态加载。纯函数引擎在 20×20 有墙地图上维护蛇身、食物、方向、暂停与终局状态，随机食物生成由调用方注入随机源；页面只负责定时推进和输入。结束时通过 `/api/snake/leaderboard` 与 `/api/snake/leaderboard/record` 读取或提交成绩；`SnakeLeaderboard` 在 `snake.solo.20x20.v1` 下为每个签名 Guest 保留最高分并返回全站 Top 10。

推箱子通过 `/sokoban` 按需加载为独立的 `local-game` 页面，`?level=1..20` 可直达关卡。纯函数引擎解析 XSB 关卡并严格区分外部空白、墙、地板和目标点，通过不可变的 `createSokoban` / `moveSokoban` 接口统一验证移动、推箱、计步和胜利；棋盘、撤销栈和当前局面仍只在浏览器内运行。页面通过 `/api/sokoban/progress` 与 `/api/sokoban/progress/record` 恢复或幂等保存当前签名 Guest 的通关记录与每关最少步数；首次进入时先确认当前 Guest 再开放移动，确认后发生的断网通关会进入按关卡独立存储、绑定用途专属 HMAC 伪名的离线 outbox。服务端只接受固定规则版本、已发布关卡和当前 Guest 的同步令牌，不接受客户端 Guest ID，也不向响应公开 Guest ID。不可变规则版本 `sokoban.microban-1-20.v1` 使用独立的 `src/games/sokoban/levels.ts` 数据目录，后续追加或修改关卡时必须发布新的进度版本。

叠叠高通过 `/stack-game` 按需加载为独立的 `local-game` 页面。纯函数引擎以不可变矩形几何计算交叠、切片、完美落点、连击奖励、逐层加速和终局；Three.js 页面只负责灯光、阴影、镜头爬升、碎片重力和输入反馈。它不创建房间、不调用成绩接口，最高层数与音效偏好仅保存在浏览器本地。

跳棋通过首页选择人数创建 `chinese-checkers.room.2p.v1`、`chinese-checkers.room.3p.v1` 或 `chinese-checkers.room.4p.v1` 邀请房间。纯函数引擎生成标准 121 孔棋盘和 2/3/4 人营地布局，房间规则统一验证相邻单步、同子连续跳跃、回合轮转与目标营胜负；客户端房间 renderer 只维护选中状态与展示状态。

单人扫雷榜以签名 Guest 作为匿名身份，昵称从签名会话取得。`minesweeper.solo.v1` 与其他规则版本不混榜，记录在 180 天后由每日清理任务删除。它是客户端计时并提交的休闲榜，已做输入校验、请求限流和最佳成绩原子更新，但不具备完整服务端回放校验，不宣称强反作弊。2048 与贪吃蛇榜同样按签名 Guest 和不可变规则版本保存单条个人最高分，分数由客户端提交并在 180 天后清理，因此也只定位为休闲榜。

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

测试覆盖纯规则/房间状态、五子棋、中国象棋、井字棋、挑夹棋、警察抓小偷、扫雷、跳棋、贪吃蛇、推箱子、坦克大战和叠叠高引擎、4×4/5×5/6×6 的 2048 引擎与本地页交互、叠叠高的真实 WebGL 桌面/手机画布、排行榜与进度客户端解析、三个独立排行榜和推箱子进度 Durable Object、真实 workerd Durable Object、Worker 边界校验、推箱子关闭页面后的通关恢复、WebSocket/HTTPS 混合并发、秘密状态投影、全局房间容量与 Presence 统计，以及多个独立浏览器身份的昵称、邀请、开局选角、观战、退出与空房回收、断网恢复、完整胜局和复赛换边流程。

## 部署

`wrangler.jsonc` 已配置 Worker、静态资源、`GameRoom`、`RoomDirectory`、`MinesweeperLeaderboard`、`Game2048Leaderboard`、`SnakeLeaderboard` 和 `SokobanProgress` 六个 SQLite Durable Object 类，以及 Custom Domain `play.ym0v0.com`。

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

安全边界：Worker 对 JSON 请求执行 Content-Type、Content-Length 和字节上限校验；会话、建房、房间 HTTP/WebSocket 握手、统计、排行榜和推箱子进度入口都有 Guest/IP 维度的软限流，房间内 WebSocket 消息还受 Guest 级限流约束，生产环境还应在 Cloudflare WAF/Rate Limiting 配置分布式规则。推箱子通关只影响该 Guest 自己的完成标记，不用于排名、奖励或权限；若未来用于竞争性结果，必须增加服务端回放验证。静态资源使用 CSP、HSTS、同源隔离、`nosniff` 和禁止 iframe；生产构建不发布 source map。`SESSION_SECRET` 缺失或过弱时 Worker 拒绝启动，客户端清单不是服务端授权边界。

## 增加棋种

本地游戏只需在共享 `GameManifest` 增加 `local-game` 元数据，在客户端 `PAGE_LOADERS` 使用字面量路径加入页面，并实现独立纯函数引擎；不进入房间协议或服务端规则注册表。推箱子新增关卡时在 `src/games/sokoban/levels.ts` 追加经过许可核验的 XSB 数据，同时更新不可变规则版本、来源记录和解析测试。

1. 在 `src/games/<game>/` 实现并测试确定性的 `GameRules`，注册到 `src/games/registry.ts`。
2. 在 `src/web/games/<game>/` 实现棋盘与展示 adapter，注册到 `src/web/games/registry.tsx`。
3. 为新规则发布不可变的 `ruleSetId`；服务端只从注册表解析规则，不能直接信任客户端提交的 ID。需要在复赛时切换模式的兼容规则，应在服务端注册到同一个显式 `rematchGroup`。

房间协议只传递不透明的棋种 payload，平台核心不读取棋种私有局面。需要隐藏信息的游戏必须实现 `project(authoritativePosition, viewerSeat)`，并为并发游戏明确选择 `concurrent_idempotent`；其他棋类保持 `strict_revision`。规则语义变化应发布新的不可变 `ruleSetId`。

需要首局选角色的回合制规则在 `GameRules.definition.openingRoleIds` 中按先手、后手顺序声明两个稳定角色 ID，并在网页 adapter 中提供对应标签；房间层统一处理认领、开局和复赛换边。每一局内的 `ruleSetId` 保持不可变；本局结束后，玩家可从服务端授权的同组模式中选择下一局规则，修改模式会清除双方复赛准备，双方重新确认后才原子切换规则并开局。
