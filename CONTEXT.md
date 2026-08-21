# Board Game Platform

这是当前极简邀请房平台的统一语言。当前支持五子棋、中国象棋、井字棋、单人扫雷与双人扫雷竞速；以后增加其他棋类时保持房间基础设施不变。首页只展示四个棋类入口，扫雷在统一选择层中再选单人/双人竞速和难度。

## Language

**Guest（游客）**  
由浏览器匿名会话识别、没有账号的访问者。

**Browser Bootstrap（浏览器引导租约）**

首次没有会话 Cookie 时，用来让并发标签页取得同一个 Guest 的 60 秒短租约。浏览器在 IndexedDB 中原子选择并按期轮换随机标识，`RoomDirectory` 只在同一短窗口内把它映射到 Guest；过期标识不能恢复先前身份。

**Platform Presence（平台在线租约）**
浏览器页面为 Guest 周期续期的 45 秒短租约。一个 Guest 的多个页面各有独立 Presence，但平台在线人数只计一次；关页会主动释放，通知丢失时由到期清理兜底。每个页面的心跳与释放携带单调序号，服务端保留 5 分钟的近期 tombstone 以忽略乱序旧请求；单个 Guest 最多同时计 8 个活跃页面并保留 64 条近期顺序记录。

**Platform Stats（平台实时统计）**
首页展示的匿名聚合数字，包括具有有效 Platform Presence 的 Guest 数和当前已激活、尚未废弃的 Room 数；不得包含 Guest、Presence 或 Room 标识。

**Seat（席位）**  
游客在一个 Room 内稳定的平台身份。席位与每局棋种侧的黑、白、红等阵营映射分离；复赛可交换阵营，但不交换 Seat。

**Spectator（观众）**
进入 Room 但不占有 Seat 的游客。观众只读地观看当前棋局，不属于有效玩家连接。

**Display Name（显示昵称）**
游客自行选择并向同一 Room 内其他人展示的称呼。昵称不是身份凭据，也不要求唯一。设置后表单收起为页面右上角的昵称 Chip，点击可再次编辑。

**Room（房间）**  
邀请链接指向的连接与复赛容器，由一个 GameRoom Durable Object 权威保存。一个房间同一时刻只有一局。

**Game（对局）**  
从初始局面到一个 Outcome 的单局过程。复赛会在原 Room 内创建新 Game。

**Action（动作）**  
席位请求的状态变化。棋种动作作为不透明 payload 交给对应规则模块；认输和准备复赛属于平台动作。

**Action Journal（动作日志）**
并发规则的有界幂等回执表。客户端在单个连接内单调生成 `clientSeq`，HTTPS fallback 对同一连接的变更请求串行发送：前一个请求失败或结果不明时，后续序号保持 pending，恢复后从最小序号继续；WebSocket 自身保持单连接有序。服务端按 Seat 保存回执、按连接序号空间维护淘汰下界和当前已保留的最高序号，并在 Seat 范围内全局去重 `actionId`，因此多个连接的动作可以乱序到达。HTTP fallback 与 WebSocket 握手复用同一个浏览器 `connectionId`（WebSocket 通过校验过的 query 参数传递），确保丢包后的跨传输重试仍落入原序号空间；该 ID 只是序号命名空间，不是认证凭证，认证仍由签名 Guest Session 完成。未传该参数的旧客户端会被拒绝并在当前 UI 重连。每个 Seat 最多保留最近 128 条可见回执，最多保留 128 个连接 scope 的淘汰元数据；落在仍保留的对应连接淘汰下界内的动作返回 `room.action_expired`，同一连接内同一序号换用其他 ID 返回 `room.action_sequence_conflict`，已见更高序号后的未见低序号返回 `room.action_out_of_order`，这些动作都不得再次进入规则模块。被淘汰的 scope 属于幂等窗口之外，旧序号不再有永久拒绝保证。拒绝回执可以单独持久化，但不推进游戏或快照修订号，也不触发整房广播。

**Leave（退出房间）**
游客主动结束当前页面与 Room 的连接。退出不等于认输，也不释放席位；同一游客的其他页面仍可保持在线。

**Vacant Room（空房）**
没有任何有效玩家连接的 Room。普通关页、刷新或断网后保留 60 秒恢复窗口；窗口内重连保留原局面，超时后废弃。最后一个有效玩家显式 Leave 时立即废弃；观众不单独延长房间生命周期。

**Room Capacity（房间容量）**
平台允许同时存在的尚未废弃 Room 数量；当前上限为 10。单人游戏和全局排行榜 Durable Object 不是 Room，不占用名额。

**Connection Limit（连接上限）**
单个 Guest 在一个 Room 内最多同时保持 4 条 WebSocket 或 HTTPS 兼容连接；单房总连接最多 16 条。其中观众最多占 8 条，剩余容量为两个玩家及其重连保留。

**GameRules（棋类规则模块）**  
隐藏某棋种初始局面、回合、合法性和规则终局的深模块。公共接口由确定性的 `create`、`apply` 和按观看者生成公开局面的 `project` 组成。

**Game Manifest / Game Catalog（游戏清单 / 客户端目录）**
共享清单只保存 `gameId`、标题、启动类型、创建策略和规则集 ID 等纯元数据。客户端目录通过静态 allowlist 把清单映射到动态加载的本地页面或房间 renderer；服务端规则注册表独立决定规则能否恢复或新建。任何来自 URL 或协议的字符串都不能直接拼成模块导入路径。

**Authoritative Position（权威局面）**
仅保存在服务端的完整规则局面。具有隐藏信息的游戏可以在这里保存雷区、随机种子和私有旗帜。

**Public Position（公开局面）**
`GameRules.project` 根据观看者 Seat 从权威局面生成的快照。终局前不得包含未公开的雷区、种子、隐藏数字或对手私有信息。

**Minesweeper Race（扫雷竞速）**
规则集为 `minesweeper.race.*.v1`。服务端生成一张权威雷区，双方从同一中央安全起点开始，但各自保存独立的 revealed 和 flags。旗帜动作使用显式 `set_flag(flagged)`，重放不会把状态反向切换。终局前对手和观众只看到双方进度数，不看到对手格子坐标；先揭开全部安全格者获胜，踩雷者立即失败。旧 `minesweeper.duel.*.v1` 仅可恢复已有房间，公共建房入口拒绝创建。

**Minesweeper Leaderboard（扫雷排行榜）**
单人扫雷按小型、中型、大型分榜，显示当前签名 Guest 的个人最佳和全站 Top 10。每个 Guest 每个难度只保留最快成绩，榜单保存签名会话中的 Display Name 和用时，不公开 Guest ID。成绩绑定不可变的 `minesweeper.solo.v1` 规则版本，服务端按写入时间最多保留 180 天并每日清理。用时仍由客户端提交，接口虽有限流和输入校验，但没有账号或完整服务端回放校验，因此只定位为休闲榜，不宣称强反作弊。

**RuleSet（规则集）**  
具有不可变语义和版本号的规则定义，例如 `gomoku.freestyle15.v1` 或 `xiangqi.casual.v1`。规则语义变化必须发布新 ID。

**RulePosition（规则局面）**  
规则模块生成的可序列化局面，包含棋种私有 `data`、当前行动 Seat 和可选 Outcome。平台不得解释私有 data。

**Outcome（结果）**  
规则导致的胜、负、和，或平台动作导致的认输结果。

**Revision（修订号）**  
`revision` 是权威游戏/房间状态改变后的序号。严格棋类用 `expectedRevision` 防止旧页面或重复提交覆盖新状态；并发棋类按最新权威局面处理携带 `actionId`、`clientSeq` 和 `baseRevision` 的动作。仅写入拒绝回执不会推进它。

**Snapshot Revision（快照修订号）**
玩家可见房间状态、昵称或 Presence 改变后的序号。HTTPS fallback 的 `/sync` 携带 `sinceSnapshotRevision`；没有可见变化时返回 `204` 和当前修订号，不重新投影或向 WebSocket 重复广播。轮询仍在内存中续租，但持久化频率被限制到约每 5 秒一次。

**Action Consistency（动作一致性策略）**
规则模块声明 `strict_revision` 或 `concurrent_idempotent`。五子棋、中国象棋和井字棋保持严格 revision；扫雷竞速允许并发幂等动作，客户端从房间快照读取策略而不按棋种名称判断。

避免把 User、Match、Rating、OpeningRule 和通用 Board 等未来概念提前加入当前实现；真实功能出现时再扩充语言。
