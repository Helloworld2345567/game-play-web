# ym0v0 棋局

一个部署在 Cloudflare 上的极简实时棋类对战平台。当前支持 15×15 自由五子棋和休闲中国象棋：无需注册，创建房间后把邀请链接发给朋友即可开始。

- 线上地址：<https://play.ym0v0.com>
- 服务端权威裁决，旧修订和非法落子不会改变棋局
- 匿名签名 Cookie 恢复席位
- 每个房间一个 SQLite-backed Durable Object
- WebSocket Hibernation、完整快照重连、手机与键盘操作
- 双方确认复赛并自动交换先手
- 中国象棋支持标准棋子走法、九宫、河界、将军/将死、困毙、飞将、三次重复与连续 60 回合无进展自动和棋；不含竞赛规则的长将/长捉责任裁定

## 架构

同一个 TypeScript 项目构建 Preact 静态页面与 Cloudflare Worker。Worker 负责会话和路由；`GameRoom` Durable Object 串行处理一个房间内的命令、持久化状态并广播快照。棋种规则通过 `GameRules` 注册表隔离，前端通过对应的 `GameAdapter` 注册表生成首页入口并选择棋盘，因此增加更多棋类不需要修改房间、会话或重连核心。

详细设计与调研见 [`docs/GOMOKU_PLATFORM_PLAN.md`](docs/GOMOKU_PLATFORM_PLAN.md) 和 [`docs/research/GITHUB_SURVEY.md`](docs/research/GITHUB_SURVEY.md)。

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

测试覆盖纯规则/房间状态、五子棋与中国象棋规则、真实 workerd Durable Object 与 WebSocket 集成，以及两个独立浏览器身份的邀请、断网恢复、完整胜局、复赛和第三人房满流程。

## 部署

`wrangler.jsonc` 已配置 Worker、静态资源、SQLite Durable Object 和 Custom Domain `play.ym0v0.com`。

```bash
npx wrangler login
npx wrangler secret put SESSION_SECRET
npm run deploy
```

生产密钥只能写入 Cloudflare Secret，不要放入 `.env`、源码或 Git 历史。

## 增加棋种

1. 在 `src/games/<game>/` 实现并测试确定性的 `GameRules`，注册到 `src/games/registry.ts`。
2. 在 `src/web/games/<game>/` 实现棋盘与展示 adapter，注册到 `src/web/games/registry.tsx`。
3. 为新规则发布不可变的 `ruleSetId`；不要按客户端消息动态选择规则。

房间协议只传递不透明的棋种 payload，平台核心不读取棋种私有局面。当前中国象棋规则 ID 为 `xiangqi.casual.v1`；规则语义变化应发布新的不可变 ID。
