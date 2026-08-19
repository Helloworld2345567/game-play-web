# GitHub survey: Gomoku and real-time Cloudflare foundations

Research date: 2026-08-19

## Method

The survey used GitHub's public repository search and repository APIs, then checked repository metadata, README files, relevant source files, and default-branch commit feeds for the most relevant candidates. Search terms included `gomoku`, `topic:gomoku`, `gomoku multiplayer`, `renju`, `durable objects multiplayer`, and `partykit`. Stars and activity dates are a dated snapshot, not a quality guarantee. A missing license is treated as no permission to copy or redistribute code.

Candidates were judged on five things: a production-safe license, recent maintenance, an authoritative server model, fit with Cloudflare Workers and Durable Objects, and the amount of project-specific code that would have to be discarded.

## Findings

| Repository | Snapshot | License | What it proves | Recommendation |
| --- | ---: | --- | --- | --- |
| [cloudflare/templates](https://github.com/cloudflare/templates) | 2,075 stars; pushed 2026-08-14 | MIT | Current official Workers scaffolds and deployment patterns | Use `create-cloudflare` as the project starting point; do not fork a game app |
| [cloudflare/workers-chat-demo](https://github.com/cloudflare/workers-chat-demo) | 1,106 stars; pushed 2026-04-23 | BSD-3-Clause | One Durable Object per room, WebSocket broadcast, stored history, rate limiting, and Hibernation API | Best small official reference for the live-room hot path |
| [cloudflare/workers-sdk](https://github.com/cloudflare/workers-sdk) | 4,446 stars; pushed 2026-08-19 | Apache-2.0 | Wrangler, Miniflare, Workers types, and the supported local toolchain | Use the released tooling; do not vendor it |
| [cloudflare/partykit](https://github.com/cloudflare/partykit) | 1,249 stars; pushed 2026-08-03 | ISC | `partyserver` lifecycle/broadcast helpers and `partysocket` reconnect, buffering, and resilience | Useful if room features grow; the ≤10-user MVP uses native Hibernation APIs to avoid another dependency, and the README still calls the project a work in progress |
| [partykit/partykit](https://github.com/partykit/partykit) | 5,686 stars; pushed 2026-01-29 | MIT | The earlier PartyKit implementation and ecosystem | Do not start new work here; its README says current development moved to `cloudflare/partykit` |
| [lihongxun945/gobang](https://github.com/lihongxun945/gobang) | 1,799 stars; pushed 2026-08-13 | No detected license | A well-developed browser JavaScript alpha-beta Gomoku AI, tactical tests, and performance evaluation | Study algorithms and test ideas only; do not copy code without explicit permission; it is not a multiplayer server |
| [dhbloo/rapfi](https://github.com/dhbloo/rapfi) | 258 stars; pushed 2026-08-18 | GPL-3.0 | A strong C++ Gomoku/Renju engine with classical and NNUE evaluation | Optional later analysis service only if GPL obligations and non-Workers deployment are acceptable; not an MVP dependency |
| [SabakiHQ/Shudan](https://github.com/SabakiHQ/Shudan) | 105 stars; pushed 2026-08-13 | MIT | A polished, customizable Preact Go-board component with markers and animations | A useful interaction reference; a dedicated 15×15 Gomoku canvas is smaller and easier to make touch-precise |
| [realjustice/renju_forbid](https://github.com/realjustice/renju_forbid) | 6 stars; pushed 2022-07-25 | MIT | A Go implementation covering double-three, double-four, overline, and win checks | Use only as one differential-test reference; age and limited evidence make it unsuitable as the production rules oracle |
| [HullQin/gobang](https://github.com/HullQin/gobang) | 97 stars; last default-branch commit 2022-04-18 | MIT | A tiny URL-room game with WebSocket, spectators, and reconnection | Interaction reference only. Its [`server.py`](https://github.com/HullQin/gobang/blob/main/server.py) appends and broadcasts `DropPiece` without authoritative identity, turn, bounds, occupancy, or win validation; state is in memory and the client decides the result |
| [hulang1024/online-chess](https://github.com/hulang1024/online-chess) | 78 stars; last default-branch commit 2025-07-27 | MIT | Gomoku and Chinese-chess platform with guests, rooms, quick join, friends, chat, rankings, reconnection, pause, spectators, and invites | Strong product reference, poor deployment fit: Java 8, Spring Boot, Netty, MySQL, Redis, Nginx, an old frontend stack, and dependencies needing a security upgrade; it cannot run natively on Workers |
| [dhbloo/gomoku-calculator](https://github.com/dhbloo/gomoku-calculator) | 106 stars; last default-branch commit 2025-11-17 | No detected repository license; Rapfi core is GPL-3.0 | Vue 2 analysis UI selecting single-threaded, multithreaded, and SIMD Rapfi WASM variants | Its Web Worker/WASM capability fallback is useful design research. Do not copy the unlicensed application; multithreaded WASM also needs COOP/COEP and large engine assets, which do not belong in the MVP |
| [junghyun397/mintaka](https://github.com/junghyun397/mintaka) | 5 stars; last default-branch commit 2026-06-23 | No detected license | Pre-alpha Rust/WASM Renju engine claiming strict forbidden-pattern handling | Potential independent test-case research only; no license means its code cannot be copied or distributed |
| [jolestar/gomoku-wasm](https://github.com/jolestar/gomoku-wasm) | 34 stars; last default-branch commit 2021-09-17 | No detected license | AssemblyScript proof of concept for shared browser/server Gomoku rules | The shared-rules idea is sound, but this old unlicensed code should not be a dependency |
| [flaviagaglio/tic-tac-toe](https://github.com/flaviagaglio/tic-tac-toe) | 1 star; pushed 2026-08-08 | MIT | A tiny authoritative Cloudflare Durable Object game server with full-state sync | Read as a contemporary vertical-slice example, not as a production foundation |
| [htlin222/kahoot-cf](https://github.com/htlin222/kahoot-cf) | 5 stars; pushed 2026-05-21 | MIT | A fuller Workers + Durable Objects + D1 + WebSocket application, including admin use of Cloudflare Access | Useful for deployment and data-flow ideas; audit any borrowed pattern because popularity and operational evidence are limited |
| [ChrisWiles/GomokuReact](https://github.com/ChrisWiles/GomokuReact) | 8 stars; pushed 2016-12-14 | No detected license | A historical React, Express, and Socket.IO multiplayer demo | Do not reuse: stale, unlicensed, and based on a permanently running origin-server model |

General multiplayer frameworks were also checked:

| Repository | Snapshot | License / runtime | Assessment |
| --- | ---: | --- | --- |
| [boardgameio/boardgame.io](https://github.com/boardgameio/boardgame.io) | 12,406 stars; last default-branch commit 2026-08-10 | MIT; Node 22+, Koa, Socket.IO | Excellent concepts for authoritative turn-based state, lobby, bots, phases, logs, and time travel, but porting its transport and storage layers to Workers is more work than the Gomoku state machine itself |
| [colyseus/colyseus](https://github.com/colyseus/colyseus) | 7,202 stars; last default-branch commit 2026-08-10 | MIT; Node 20+ | Mature authoritative rooms, matchmaking, reconnection, and sync, but requires a conventional Node service rather than Cloudflare's DO model |
| [heroiclabs/nakama](https://github.com/heroiclabs/nakama) | 13,184 stars; last default-branch commit 2026-08-05 | Apache-2.0; Go, Docker, Postgres/CockroachDB | Full accounts, social, chat, matchmaking, leaderboards, tournaments, and authoritative runtime; operationally excessive for a first Gomoku release and not Cloudflare-native |

## Conclusions

There is no mature, actively maintained, permissively licensed online Gomoku platform that should be forked wholesale. The highly starred Gomoku repositories are primarily AI experiments, while multiplayer examples are generally small, old, unlicensed, or tied to a conventional Node server.

The safest foundation is therefore:

1. Scaffold with the official Cloudflare Workers template.
2. Use one SQLite-backed Durable Object per room as the authoritative state and native WebSocket Hibernation for the ≤10-user MVP. The official chat demo is the closest low-level operational reference.
3. Broadcast a full snapshot after each accepted action. A 15×15 board is tiny, so PartyServer, event deltas and catch-up logs do not yet repay their extra interfaces.
4. Keep room lifecycle independent of game rules through one small `GameRules` interface.
5. Write a small pure TypeScript Gomoku rules engine. Cross-check it with independently written slow logic and curated rule cases instead of importing an uncertain rules package.
6. Build a purpose-made canvas board. Shudan is a design reference, not a required dependency.
7. Add PartyServer, AI or a larger platform service only after an observed requirement justifies it. Rapfi remains a separate GPL and infrastructure decision.

## License guardrails

- Preserve notices for MIT, ISC, BSD-3-Clause, and Apache-2.0 code that is actually copied.
- Do not copy code, assets, weights, or test fixtures from repositories without a license.
- GPL-3.0 code linked into or distributed with the application can impose source-distribution obligations; obtain legal review before integrating Rapfi or another GPL engine.
- Ideas, protocols, and observable behavior can inform an independent implementation, but copied expression remains subject to copyright.
