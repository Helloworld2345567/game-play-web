# ym0v0 棋局

一个部署在 Cloudflare 上的轻量实时棋类平台。平台提供游客邀请房、服务端权威裁决、观战、短暂断线恢复，以及不创建房间的本地小游戏。

线上地址：<https://play.ym0v0.com>

## 当前能力

联机入口包括五子棋、中国象棋、井字棋、挑夹棋、警察抓小偷、扫雷和 2/3/4 人跳棋。扫雷房间支持三种难度的双人竞速，单人模式在浏览器本地运行。

本地入口包括 4×4/5×5/6×6 2048、20×20 贪吃蛇、Microban 前 20 关推箱子、叠叠高和使用固定图片的九宫格拼图。除成绩或推箱子进度接口外，本地游戏的局面不上传到服务端；拼图只在当前浏览器保存个人最佳步数。

平台约束如下：

- 一个 `GameRoom` Durable Object 保存一个房间，房间内事件串行处理，并在持久化后广播公开快照。
- 建房、席位、观众、复赛、容量、身份和网络恢复遵循 [CONTEXT.md](CONTEXT.md) 中的契约。
- WebSocket 是首选通道；受限网络使用同源 HTTPS 兼容通道，并后台探测恢复实时连接。动作确认、重试和切换规则见 CONTEXT。
- 匿名身份使用签名 HttpOnly Cookie；游客可设置昵称，房间上限为 10 个，观众不占玩家席位。
- 每个规则版本使用不可变 `ruleSetId`。隐藏信息只能通过按观看者生成的公开投影发送。

推箱子关卡的作者许可、固定来源和核验记录见 [`docs/research/SOKOBAN_LEVELS.md`](docs/research/SOKOBAN_LEVELS.md)。

## 本地开发

需要 Node.js 24+。

```bash
npm ci
```

在不会提交到 Git 的 `.dev.vars` 中设置本地会话密钥：

```dotenv
SESSION_SECRET=请替换为至少32字节的随机值
```

启动开发服务器：

```bash
npm run dev
```

提交前可运行完整检查：

```bash
npm run typecheck
npm test
npm run test:worker
npm run test:e2e
npm run build
```

## 部署

`wrangler.jsonc` 是 Worker、静态资源、Durable Object、Custom Domain 和必需密钥的配置来源。推送 `main` 会触发 [Deploy production](.github/workflows/deploy.yml)，依次执行依赖审计、单元测试、Worker 集成测试、浏览器 E2E、生产构建和 Cloudflare 部署。

首次配置 GitHub Actions 时，需要设置：

- Secret `CLOUDFLARE_API_TOKEN`，权限限制为当前账号的 `Edit Cloudflare Workers`。
- Variable `CLOUDFLARE_ACCOUNT_ID`。

生产 `SESSION_SECRET` 只放在 Cloudflare Secret 中，不要写入源码、`.env` 或 Git 历史。手动部署可使用：

```bash
npx wrangler login
npx wrangler secret put SESSION_SECRET
npm run deploy
```

## 增加游戏

房间游戏需要新增确定性的 `GameRules`、服务端规则注册和共享 `GameManifest`。客户端在 `src/web/games/<game>/` 内维护 `presentation.ts`（展示适配及 renderer 的字面量导入）、棋盘，以及可选的 `launch.tsx`（玩法选择）；在 `catalog.ts` 静态组合这些能力后，首页和房间页自动接入，无需增加 App 分支。本地游戏增加 `local-game` 清单、页面 loader 和独立纯函数引擎。

每次规则语义变化都发布新的不可变 `ruleSetId`，不要让客户端提交的 ID 成为服务端授权依据。

扩展时保持以下边界：

1. 规则模块只负责局面、动作合法性、终局和 `project`，不执行 I/O，也不修改输入。
2. 房间层只负责身份、席位、修订号、动作交付、持久化、投影和广播，不读取棋种私有局面。
3. 客户端通过静态 allowlist 选择页面或 renderer；URL 和协议字符串不能直接拼接动态导入路径。
4. 为新规则补充规则、协议、恢复和多客户端行为测试。

## 文档索引

- [CONTEXT.md](CONTEXT.md)：当前架构、身份、房间生命周期、网络协议和不可变规则契约。
- [性能与弱网优化](docs/PERFORMANCE.md)：当前验证方式、本地耗时指标和后续优化。
- [推箱子关卡来源](docs/research/SOKOBAN_LEVELS.md)：Microban 1–20 的作者许可、来源和核验事实。
