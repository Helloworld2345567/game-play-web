# Board Game Platform

这是当前极简邀请房平台的统一语言。当前支持五子棋、中国象棋、井字棋、单人扫雷与双人同时扫雷；以后增加其他棋类时保持房间基础设施不变。

## Language

**Guest（游客）**  
由浏览器匿名会话识别、没有账号的访问者。

**Seat（席位）**  
游客在一个 Room 内稳定的平台身份。席位与每局棋种侧的黑、白、红等阵营映射分离；复赛可交换阵营，但不交换 Seat。

**Spectator（观众）**
进入 Room 但不占有 Seat 的游客。观众只读地观看当前棋局，不属于有效玩家连接。

**Display Name（显示昵称）**
游客自行选择并向同一 Room 内其他人展示的称呼。昵称不是身份凭据，也不要求唯一。

**Room（房间）**  
邀请链接指向的连接与复赛容器，由一个 GameRoom Durable Object 权威保存。一个房间同一时刻只有一局。

**Game（对局）**  
从初始局面到一个 Outcome 的单局过程。复赛会在原 Room 内创建新 Game。

**Action（动作）**  
席位请求的状态变化。棋种动作作为不透明 payload 交给对应规则模块；认输和准备复赛属于平台动作。

**Leave（退出房间）**
游客主动结束当前页面与 Room 的连接。退出不等于认输，也不释放席位；同一游客的其他页面仍可保持在线。

**Vacant Room（空房）**
没有任何有效玩家连接的 Room。普通关页、刷新或断网后保留 60 秒恢复窗口；窗口内重连保留原局面，超时后废弃。最后一个有效玩家显式 Leave 时立即废弃；观众不单独延长房间生命周期。

**Room Capacity（房间容量）**
平台允许同时存在的尚未废弃 Room 数量；当前上限为 10。

**Connection Limit（连接上限）**
单个 Guest 在一个 Room 内最多同时保持 4 条 WebSocket 或 HTTPS 兼容连接；单房总连接最多 16 条。其中观众最多占 8 条，剩余容量为两个玩家及其重连保留。

**GameRules（棋类规则模块）**  
隐藏某棋种初始局面、回合、合法性和规则终局的深模块。公共接口由确定性的 `create`、`apply` 和按观看者生成公开局面的 `project` 组成。

**Authoritative Position（权威局面）**
仅保存在服务端的完整规则局面。具有隐藏信息的游戏可以在这里保存雷区、随机种子和私有旗帜。

**Public Position（公开局面）**
`GameRules.project` 根据观看者 Seat 从权威局面生成的快照。终局前不得包含未公开的雷区、种子、隐藏数字或对手私有信息。

**RuleSet（规则集）**  
具有不可变语义和版本号的规则定义，例如 `gomoku.freestyle15.v1` 或 `xiangqi.casual.v1`。规则语义变化必须发布新 ID。

**RulePosition（规则局面）**  
规则模块生成的可序列化局面，包含棋种私有 `data`、当前行动 Seat 和可选 Outcome。平台不得解释私有 data。

**Outcome（结果）**  
规则导致的胜、负、和，或平台动作导致的认输结果。

**Revision（修订号）**  
房间每处理一个改变持久状态的命令后递增的序号。严格棋类用 `expectedRevision` 防止旧页面或重复提交覆盖新状态；并发棋类按最新权威局面处理携带 `actionId`、`clientSeq` 和 `baseRevision` 的动作。

**Action Consistency（动作一致性策略）**
规则模块声明 `strict_revision` 或 `concurrent_idempotent`。五子棋、中国象棋和井字棋保持严格 revision；双人扫雷允许不同格子的并发幂等动作，客户端从房间快照读取策略而不按棋种名称判断。

避免把 User、Match、Rating、OpeningRule 和通用 Board 等未来概念提前加入当前实现；真实功能出现时再扩充语言。
