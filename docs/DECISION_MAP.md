# Decision map: ym0v0 极简棋类平台

状态：2026-08-24 已按“全站同时最多 10 个未废弃房间”的容量重新收敛，并纳入井字棋、挑夹棋、单人扫雷与双人同时扫雷。当前统一语言以 [`CONTEXT.md`](../CONTEXT.md) 为准；实现细节见 [GOMOKU_PLATFORM_PLAN.md](./GOMOKU_PLATFORM_PLAN.md)，GitHub 证据见 [research/GITHUB_SURVEY.md](./research/GITHUB_SURVEY.md)。

## #1：复用完整平台还是基于 Cloudflare 原语自建？

**结论**：不 fork 完整五子棋站点。现有项目普遍存在许可证、服务端非权威、维护状态或部署栈不匹配。使用 Cloudflare 官方模板和 chat demo 的模式，自写小型规则模块。

## #2：首版到底交付什么？

**结论**：交付可自定义昵称的游客邀请房、15×15 自由五子棋、休闲中国象棋、井字棋、挑夹棋、单人扫雷、双人同时扫雷、前两人对战与后续游客只读观战、权威裁决、认输/复赛、刷新和断线重连、移动端棋盘。没有账号、匹配、排位、棋钟、聊天、AI 和永久历史。

## #3：实时状态放在哪里？

**结论**：一个房间对应一个 SQLite-backed GameRoom Durable Object。DO 串行处理动作，先 `storage.put("room", snapshot)`，再向连接广播完整 snapshot。使用原生 WebSocket Hibernation，不引入 PartyServer。

## #4：需要哪些 Cloudflare 产品？

**结论**：只需 Worker Static Assets、Worker，以及三个 DO 类：每房一个 `GameRoom`，单例 `RoomDirectory` 原子管理全站 10 个房间的容量与 Presence，单例 `MinesweeperLeaderboard` 保存带规则版本和保留期限的单人休闲榜。当前不需要 D1、Queue、KV、R2、Pages 或第二个 Worker。以后只在真实功能触发时逐项增加。

## #5：如何持续增加棋类？

**结论**：保留一个深而窄的 `GameRules` 模块，由确定性的 `create`、`apply`、按观看者生成公开局面的 `project`，以及显式 `actionConsistency` 组成。时间与随机种子只能由平台通过 `RuleContext` 注入。平台把棋种状态和 action payload 当作不透明 JSON；前端每个棋种有独立 renderer。中国象棋、井字棋、挑夹棋和扫雷已验证这条扩展缝；以后仍不设计万能棋盘。

## #6：前端怎样兼顾小、快和易用？

**结论**：Preact + Vite + 共享 `GameManifest` 和客户端静态 allowlist `GameCatalog`，按入口动态加载每棋种页面/renderer。规则网格使用 Canvas 2D，挑夹棋这类不规则图使用 SVG 线段配合可访问的 DOM 节点，井字棋和扫雷使用可访问的 DOM Grid。首屏 JS gzip 目标小于 100 KB；严格棋类由服务端确认后落为实子，双人扫雷逐格显示 pending；断线时保留局面并自动恢复。

## #7：怎样部署到 ym0v0.com？

**结论**：单 Worker 使用 Custom Domain `play.ym0v0.com`，静态资源、API 和 WebSocket 同源。该名称当前未发现 DNS 冲突；Cloudflare 创建 DNS 与证书。

## #8：何时重新设计？

只有以下触发条件出现时才重开对应决策：

- 需要随机匹配：增加 MatchQueue DO。
- 需要账号、跨设备历史或榜单：评估 D1。
- 需要异步结算：评估 Queue。
- 需要大量长期棋谱：评估 R2。
- 单房出现大量观众：增加扇出 DO。
- 大陆三网实测 ACK p95 持续超过 500 ms：重新评估部署地域和网络方案。
