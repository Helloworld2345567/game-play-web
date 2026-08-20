# Decision map: ym0v0 极简棋类平台

状态：2026-08-19 已按“同时在线不超过 10 人”的容量重新收敛。实现细节见 [GOMOKU_PLATFORM_PLAN.md](./GOMOKU_PLATFORM_PLAN.md)，GitHub 证据见 [research/GITHUB_SURVEY.md](./research/GITHUB_SURVEY.md)。

## #1：复用完整平台还是基于 Cloudflare 原语自建？

**结论**：不 fork 完整五子棋站点。现有项目普遍存在许可证、服务端非权威、维护状态或部署栈不匹配。使用 Cloudflare 官方模板和 chat demo 的模式，自写小型规则模块。

## #2：首版到底交付什么？

**结论**：交付游客邀请房、15×15 自由五子棋、休闲中国象棋、权威走子/胜负、认输/复赛、刷新和断线重连、移动端棋盘。没有账号、匹配、排位、棋钟、观战、聊天、AI 和永久历史。

## #3：实时状态放在哪里？

**结论**：一个房间对应一个 SQLite-backed GameRoom Durable Object。DO 串行处理动作，先 `storage.put("room", snapshot)`，再向连接广播完整 snapshot。使用原生 WebSocket Hibernation，不引入 PartyServer。

## #4：需要哪些 Cloudflare 产品？

**结论**：只需 Worker Static Assets、Worker 和一个 DO 类。当前不需要 D1、Queue、KV、R2、Pages 或第二个 Worker。以后只在真实功能触发时逐项增加。

## #5：如何持续增加棋类？

**结论**：保留一个深而窄的 `GameRules` 模块，只有确定性的 `create` 和 `apply`。平台把棋种状态和 action payload 当作不透明 JSON；前端每个棋种有独立 renderer。中国象棋已验证这条扩展缝；以后仍不设计万能棋盘。

## #6：前端怎样兼顾小、快和易用？

**结论**：Preact + Vite + Canvas 2D。首屏 JS gzip 目标小于 100 KB；棋盘按最近交叉点吸附，提交前显示预览，服务端确认后落为实子；断线时禁用操作并自动恢复。

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
