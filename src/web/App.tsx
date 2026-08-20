import { useEffect, useState } from "preact/hooks";
import type { RoomSnapshot } from "../shared/protocol";
import {
  availableGameAdapters,
  GameRenderer,
  getGameAdapter,
  UnsupportedGame,
  unknownSeatPresentations,
} from "./games/registry";
import {
  ensureBrowserSession,
  useRoom,
  type ConnectionPhase,
  type RoomTransport,
} from "./room-client";

const ROOM_PATH = /^\/r\/([A-Za-z0-9_-]{16})\/?$/u;

function Brand() {
  return (
    <a class="brand" href="/" aria-label="ym0v0 棋局首页">
      <span class="brand-mark" aria-hidden="true">棋</span>
      <span>ym0v0 棋局</span>
    </a>
  );
}

function LandingPage() {
  const [creating, setCreating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const createRoom = async (gameType: string, ruleSetId: string) => {
    if (creating !== null) return;
    setCreating(ruleSetId);
    setError(null);
    try {
      await ensureBrowserSession();
      const response = await fetch("/api/rooms", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          gameType,
          ruleSetId,
        }),
      });
      const body = (await response.json()) as {
        roomId?: string;
        error?: string;
      };
      if (!response.ok || !body.roomId) throw new Error(body.error);
      location.assign(`/r/${body.roomId}`);
    } catch {
      setCreating(null);
      setError("建房失败，请检查网络后重试。");
    }
  };

  return (
    <main class="landing">
      <nav class="topbar"><Brand /></nav>
      <section class="hero">
        <p class="eyebrow">轻量 · 实时 · 无需注册</p>
        <h1>一条链接，<br />马上下一局。</h1>
        <p class="hero-copy">
          创建私人棋局，把邀请链接发给朋友。没有账号、广告和复杂大厅。
        </p>
        <div class="game-choice-grid" aria-label="选择棋种">
          {availableGameAdapters.map((game, index) => (
            <button
              key={game.ruleSetId}
              class={`${index === 0 ? "primary-button" : "secondary-button"} hero-button game-choice`}
              onClick={() => void createRoom(game.gameType, game.ruleSetId)}
              disabled={creating !== null}
            >
              <strong>
                {creating === game.ruleSetId
                  ? "正在创建…"
                  : game.createRoomLabel}
              </strong>
              <small>{game.landingDescription}</small>
            </button>
          ))}
        </div>
        {error && <p class="inline-error" role="alert">{error}</p>}
      </section>
      <section class="feature-grid" aria-label="产品特点">
        <article>
          <span class="feature-number">01</span>
          <h2>服务端裁决</h2>
          <p>每一步先由房间确认，再显示为实子。并发操作不会打乱棋局。</p>
        </article>
        <article>
          <span class="feature-number">02</span>
          <h2>断线恢复</h2>
          <p>刷新或短暂断网后自动同步完整局面，不靠浏览器猜测状态。</p>
        </article>
        <article>
          <span class="feature-number">03</span>
          <h2>手机优先</h2>
          <p>落点自动吸附，按下可预览，松开才提交，也支持键盘操作。</p>
        </article>
      </section>
      <footer class="site-footer">
        五子棋与中国象棋 · 一条邀请链接，一局私人对战
      </footer>
    </main>
  );
}

function phaseText(
  phase: ConnectionPhase,
  transport: RoomTransport = "websocket",
): string {
  if (transport === "http") {
    if (phase === "online") return "兼容连接";
    if (phase === "retrying") return "兼容连接中断，正在重试";
    if (phase === "connecting" || phase === "syncing") {
      return "正在建立兼容连接";
    }
  }
  const labels: Record<ConnectionPhase, string> = {
    connecting: "正在进入房间",
    syncing: "正在同步局面",
    online: "连接正常",
    retrying: "连接中断，正在重连",
    offline: "设备已离线",
    fatal: "无法进入房间",
  };
  return labels[phase];
}

function mainStatus(
  snapshot: RoomSnapshot | null,
  phase: ConnectionPhase,
  transport: RoomTransport,
): string {
  if (phase !== "online" || snapshot === null) {
    return phaseText(phase, transport);
  }
  if (snapshot.position === null) return "等待对手加入";
  const outcome = snapshot.position.outcome;
  if (outcome?.kind === "draw") return "本局和棋";
  if (outcome?.kind === "win") {
    return outcome.winner === snapshot.selfSeat ? "你赢了" : "对手获胜";
  }
  return snapshot.position.turn === snapshot.selfSeat ? "轮到你" : "等待对手落子";
}

function RoomPage({
  roomId,
  onExit,
}: {
  roomId: string;
  onExit(): void;
}) {
  const client = useRoom(roomId);
  const snapshot = client.snapshot;
  const adapter =
    snapshot === null
      ? null
      : getGameAdapter(snapshot.gameType, snapshot.ruleSetId);
  const unsupportedGame = snapshot !== null && adapter === null;
  const seatPresentations =
    adapter?.getSeatPresentations(snapshot?.position ?? null) ??
    unknownSeatPresentations;
  const gameName =
    adapter?.displayName ?? (snapshot === null ? "自由五子棋" : "未知棋类");
  const [shareNotice, setShareNotice] = useState<string | null>(null);
  const bothOccupied =
    snapshot?.seats["seat-a"]?.occupied === true &&
    snapshot.seats["seat-b"]?.occupied === true;
  const outcome = snapshot?.position?.outcome ?? null;
  const canPlace =
    client.phase === "online" &&
    !client.pending &&
    !client.leaving &&
    adapter !== null &&
    bothOccupied &&
    snapshot?.position?.turn === snapshot.selfSeat &&
    outcome === null;
  const ownReady =
    snapshot?.selfSeat !== null &&
    snapshot?.selfSeat !== undefined &&
    snapshot.seats[snapshot.selfSeat]?.rematchReady === true;

  const share = async () => {
    const shareData = {
      title: `来和我下一局${gameName}`,
      text: `打开链接加入我的 ym0v0 ${gameName}房间`,
      url: location.href,
    };
    try {
      const shareFunction = Reflect.get(navigator, "share");
      const usedNativeShare = typeof shareFunction === "function";
      if (usedNativeShare) await shareFunction.call(navigator, shareData);
      else await navigator.clipboard.writeText(location.href);
      setShareNotice(usedNativeShare ? "邀请已打开" : "邀请链接已复制");
    } catch (error) {
      if ((error as DOMException).name !== "AbortError") {
        setShareNotice("请复制浏览器地址发送给朋友");
      }
    }
  };

  const exitRoom = async () => {
    if (
      !confirm(
        "确定退出房间吗？退出不会自动认输；所有人离开后，邀请链接将失效。",
      )
    ) {
      return;
    }
    await client.leave();
    onExit();
  };

  if (client.phase === "fatal") {
    return (
      <main class="room-page">
        <nav class="topbar"><Brand /></nav>
        <section class="fatal-card">
          <p class="eyebrow">房间不可用</p>
          <h1>{client.fatalCode === "room.full" ? "这里已经坐满了" : "没能进入这个房间"}</h1>
          <p>{client.notice ?? "邀请链接可能已失效，请让创建者重新建房。"}</p>
          <a class="primary-button link-button" href="/">返回首页</a>
        </section>
      </main>
    );
  }

  return (
    <main class="room-page">
      <nav class="topbar room-topbar">
        <Brand />
        <span
          class={`connection-pill phase-${client.phase}`}
          title={
            client.transport === "http"
              ? "当前网络不支持 WebSocket，已通过 HTTPS 连接"
              : undefined
          }
        >
          <span aria-hidden="true" />
          {phaseText(client.phase, client.transport)}
        </span>
      </nav>

      <section class="game-layout">
        <header class="game-heading">
          <p class="eyebrow">第 {snapshot?.round ?? 1} 局 · {gameName}</p>
          <h1>
            {unsupportedGame
              ? "暂不支持这个规则版本"
              : mainStatus(snapshot, client.phase, client.transport)}
          </h1>
        </header>

        <div class="seat-strip">
          {(["seat-a", "seat-b"] as const).map((seatId) => {
            const seat = snapshot?.seats[seatId];
            const isSelf = snapshot?.selfSeat === seatId;
            const presentation = seatPresentations[seatId];
            return (
              <div class={`seat-card ${isSelf ? "is-self" : ""}`}>
                <span
                  class={`stone-swatch ${presentation.swatchClassName}`}
                  aria-hidden="true"
                />
                <span>
                  <strong>{presentation.label}{isSelf ? " · 你" : ""}</strong>
                  <small>
                    {!seat?.occupied ? "等待加入" : seat.online ? "在线" : "暂时离线"}
                    {seat?.rematchReady ? " · 已准备" : ""}
                  </small>
                </span>
              </div>
            );
          })}
        </div>

        {unsupportedGame ? (
          <UnsupportedGame
            gameType={snapshot.gameType}
            ruleSetId={snapshot.ruleSetId}
          />
        ) : snapshot?.position ? (
          <GameRenderer
            gameType={snapshot.gameType}
            ruleSetId={snapshot.ruleSetId}
            position={snapshot.position}
            selfSeat={snapshot.selfSeat}
            disabled={!canPlace}
            pending={client.pending}
            onAction={(payload) => client.sendGameAction(payload)}
          />
        ) : (
          <div class="board-placeholder" aria-label="等待对手加入的空棋盘">
            <span>邀请朋友加入后开始</span>
          </div>
        )}

        {client.phase !== "online" && snapshot && (
          <div class="network-banner" role="status">
            保留当前棋盘，连接恢复后自动同步。
            <button disabled={client.leaving} onClick={client.retryNow}>
              立即重试
            </button>
          </div>
        )}

        <div class="room-actions">
          <button
            class="secondary-button"
            disabled={client.leaving}
            onClick={share}
          >
            {bothOccupied ? "分享房间" : "邀请好友"}
          </button>
          <button
            class="secondary-button"
            disabled={client.leaving}
            onClick={() => void exitRoom()}
          >
            {client.leaving ? "正在退出…" : "退出房间"}
          </button>
          {adapter && snapshot?.position && outcome === null && bothOccupied && (
            <button
              class="danger-button"
              disabled={
                client.leaving || client.pending || client.phase !== "online"
              }
              onClick={() => {
                if (confirm("确定认输并结束本局吗？")) client.resign();
              }}
            >
              认输
            </button>
          )}
          {adapter && outcome && (
            <button
              class="primary-button"
              disabled={
                client.leaving || client.pending || client.phase !== "online"
              }
              onClick={() => client.setRematchReady(!ownReady)}
            >
              {ownReady ? "取消准备" : "再来一局"}
            </button>
          )}
        </div>

        <div class="live-region" aria-live="polite">
          {client.leaving
            ? "正在退出房间…"
            : client.pending
              ? "正在等待房间确认…"
              : client.notice ?? shareNotice}
        </div>
      </section>
    </main>
  );
}

function NotFoundPage() {
  return (
    <main class="landing">
      <nav class="topbar"><Brand /></nav>
      <section class="fatal-card">
        <p class="eyebrow">404</p>
        <h1>这里没有棋盘</h1>
        <a class="primary-button link-button" href="/">返回首页</a>
      </section>
    </main>
  );
}

export function App() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const updatePath = () => setPath(location.pathname);
    window.addEventListener("popstate", updatePath);
    return () => window.removeEventListener("popstate", updatePath);
  }, []);

  if (path === "/" || path === "") {
    return <LandingPage />;
  }
  const match = path.match(ROOM_PATH);
  if (match?.[1]) {
    return (
      <RoomPage
        roomId={match[1]}
        onExit={() => {
          history.replaceState(null, "", "/");
          setPath("/");
          window.scrollTo({ top: 0 });
        }}
      />
    );
  }
  return <NotFoundPage />;
}
