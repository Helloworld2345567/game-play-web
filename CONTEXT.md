# Board Game Platform

这是项目当前的架构与行为契约。README 负责开发和部署入口；本文件只记录跨游戏必须稳定的身份、房间、网络和规则边界。

## 架构边界

- 一个 TypeScript 项目构建 Preact/Vite 页面和 Cloudflare Worker。Worker 提供静态资源、HTTP API 和 WebSocket 路由。
- 每个房间对应一个 `GameRoom` Durable Object。它串行处理房间事件，负责席位、生命周期、动作、持久化、公开投影和广播；状态必须先持久化再广播。
- `RoomDirectory` 负责全站房间容量和 Platform Presence。排行榜与推箱子进度使用独立的 SQLite-backed Durable Object，不占房间名额；房间动作不通过跨 DO 往返完成。
- 目录的租约、Guest Presence 和 bootstrap 按记录保存，计数与变更在同一事务维护；到期清理负责校正统计。旧整表按需原子迁移，回滚边界与测量见 [性能文档](docs/PERFORMANCE.md)。
- `GameManifest` 只保存可信纯元数据。客户端 `GameCatalog` 通过静态 allowlist 选择页面或 renderer；服务端规则注册表独立决定规则能否新建或恢复。来自 URL/协议的字符串不能直接拼成模块导入路径。
- 各游戏目录拥有启动选择器、展示适配和 renderer loader；`catalog.ts` 组合静态注册，`registry.tsx` 提供通用懒加载及错误隔离，`App` 根据能力渲染入口，不维护棋种启动分支。
- 本地游戏是 `local-game` 页面，不进入房间协议，也不创建 `GameRoom`。
- `useRoom` 只订阅并转发操作；`RoomSession` 统一管理连接状态、确认队列、探测、重连和退出，浏览器身份与传输通过 adapter 注入。终止后忽略迟到回包，严格命令不得越过待确认的并发队列；关键链路使用可控时钟独立测试。

规则模块的唯一类型定义见 [`src/core/game-rules.ts`](src/core/game-rules.ts)，由 `create`、`apply` 和 `project` 组成。

`create`、`apply` 和 `project` 必须确定性、无 I/O、不修改输入，并返回可 JSON 序列化状态。平台把棋种 `data` 和 action payload 当作不透明值，不读取棋盘、雷区或其他私有字段。时间和随机性由平台通过 `RuleContext` 显式注入。

## 身份与房间生命周期

- **Guest**：没有账号的匿名访问者。身份是 HMAC 签名的 `Secure; HttpOnly; SameSite=Lax` Cookie，成功会话请求会滚动续期最长 400 天。清除 Cookie、无痕窗口或更换设备会产生新的 Guest；页面脚本不能读取或伪造 Guest ID。
- **Browser Bootstrap**：无 Cookie 的并发标签页可通过 IndexedDB 中的短期随机租约共享一次会话建立；过期租约不能恢复旧身份。
- **Seat**：Guest 在一个房间内的稳定席位。棋种阵营映射与 Seat 分开，复赛可换阵营但不换席位。**Spectator** 只读观战，不占玩家席位。
- **Display Name**：同房间展示用昵称，不是凭据，也不要求唯一。
- 全站最多 10 个未废弃房间。新房间先持有 60 秒 provisional lease；首个 WebSocket 或 HTTPS 同步成功后才计入 `activeRooms`，但临时租约仍占容量。目录释放任务失败时由 alarm 重试。
- 一个房间最多 16 条连接（玩家、观众各最多 8 条），单个 Guest 在同房间最多 4 条。没有有效玩家连接时保留 60 秒恢复窗口；最后一个玩家显式 Leave 则立即废弃，观众不能保活。Leave 不等同于认输，也不释放席位；同一 Guest 的其他页面仍可在线。
- **Platform Presence** 是页面为 Guest 续期的 45 秒租约。多个页面各有 Presence，但统计按 Guest 去重；心跳/释放用单调序号防乱序，近期 tombstone 保留 5 分钟，每 Guest 最多 8 个活跃页面、64 条顺序记录。首页只公开在线 Guest 数和已激活房间数；释放丢失由到期清理兜底。

## 网络与一致性

- 静态资源、HTTP API 和 WebSocket 同源。WebSocket 优先；HTTPS 兼容通道必须保留相同的身份、`connectionId` 和动作交付语义。连接断开后退避重连，恢复成功后以服务端完整公开快照覆盖本地视图。
- `revision` 表示权威房间/对局状态变化。严格规则使用 `expectedRevision` 拒绝旧页面或重复提交；并发规则使用 `actionId + clientSeq + baseRevision` 在最新权威局面上按到达顺序幂等处理。
- 并发动作的 `clientSeq` 在单个连接序号空间内单调。HTTPS 兼容通道同一时刻只发送一个变更动作；未知结果时必须暂停后续序号，从最小 pending 动作恢复，不能靠跳过序号追求并行。
- 并发回执在 Seat 内按 `actionId` 去重，每 Seat 保留最近 128 条回执及最多 128 个 scope 的淘汰元数据；窗口内重复动作不得再次进入规则模块。严格动作继续校验 revision，结果未知时必须获取完整快照核对并解除等待或提示重试。`/sync` 的 `204` 只表示 `snapshotRevision` 没有变化，不能据此宣称某个动作成功。
- HTTP 降级期间使用带退避的后台 WebSocket 探测，探测不发送动作。只有收到已追平的完整快照、HTTP 请求和待确认动作都处理完，才切换发送通道；失败或连接名额不足时继续 HTTP。显式退出同一连接时需清理升级残留的 HTTP lease，其他页面的 lease 保留。
- 服务端为显式退出的 `Guest + connectionId` 保留 60 秒关闭记录（每房间最多 64 条），拦截迟到同步、动作和重连；记录到期或房间退休时清理。客户端取消请求只能停止等待，不能代替服务端退出处理。
- 客户端普通 JSON 请求的截止时间覆盖响应体读取，取消不重试；建房及首次身份建立仍按自身幂等约束处理。服务端入站 JSON 另有类型、大小和限流校验。
- 房间事件顺序为：解析并验证 → 身份/规则/一致性检查 → 调用规则 → 持久化 → 生成观看者专属公开投影 → 广播。隐藏信息在终局前不得进入不应看到它的快照。

## 不可变规则与扩展

- `ruleSetId` 表示不可变的规则语义；规则变化必须发布新 ID。客户端清单只做提示和 allowlist，服务端注册表始终是授权来源。
- `strict_revision` 适合回合制严格提交；`concurrent_idempotent` 只用于明确允许基于旧局面的并发规则，例如扫雷竞速。不要按棋种名称在平台核心分支判断策略。
- `openingRoleIds` 用稳定的先手/后手角色 ID 表示需要选角色的双人回合制房间。首局双方完成认领后创建局面；终局复赛需要全部玩家准备，只有同一显式兼容组内的规则才能切换。修改下一局模式会清除准备，规则切换和先手轮换在一次持久化决策中完成。
- 目前联机规则包括五子棋、象棋、井字棋、挑夹棋、警察抓小偷、2/3/4 人跳棋和扫雷竞速；扫雷旧 duel 规则只为旧房间恢复，禁止新建。2048、贪吃蛇、推箱子、坦克大战和叠叠高是本地规则。
- 新增联机游戏时，新增规则模块、服务端注册、共享 manifest、客户端 adapter 和测试；新增本地游戏时增加本地页面 allowlist 与纯函数引擎。不要提前抽象通用棋盘、坐标或吃子接口。

## 个人记录

- 扫雷、2048、贪吃蛇和叠叠高的四个榜单 DO 按签名 Guest 和不可变规则版本原子保存个人最佳、生成 Top 10，保留 180 天。扫雷按用时升序，其他按分数降序，同分以时间和 Guest 确定性排序；分数来自客户端，只定位为休闲榜。它们不进入本地动画循环，也不计房间容量。
- 推箱子进度使用固定 64 个确定性 DO 分片，表内按 Guest 隔离，逐关保存最佳步数并保留 180 天。首次确认 Guest 后才开放移动；离线 outbox 绑定用途专属 HMAC 伪名，换 Cookie 后不得把旧记录写入新 Guest。进度只用于个人完成标记，不用于排名、奖励或权限。
- 推箱子版本为 `sokoban.microban-1-20.v1`；关卡许可和固定来源见 [`docs/research/SOKOBAN_LEVELS.md`](docs/research/SOKOBAN_LEVELS.md)。追加或修改关卡必须发布新的进度版本并更新来源记录。
