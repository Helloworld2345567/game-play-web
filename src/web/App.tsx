import { useEffect, useState } from "preact/hooks";
import { normalizeDisplayName } from "../shared/display-name";
import type { RoomSnapshot } from "../shared/protocol";
import {
  availableGameAdapters,
  GameRenderer,
  getGameAdapter,
  type GameAdapter,
  UnsupportedGame,
  unknownSeatPresentations,
} from "./games/registry";
import { SoloPage } from "./games/minesweeper/SoloPage";
import {
  ensureBrowserSession,
  useRoom,
  type ConnectionPhase,
  type RoomTransport,
} from "./room-client";

const ROOM_PATH = /^\/r\/([A-Za-z0-9_-]{16})\/?$/u;
const DISPLAY_NAME_STORAGE_KEY = "ym0v0.display-name";
let memoryDisplayName: string | null = null;

interface PlatformStats {
  onlineGuests: number;
  activeRooms: number;
}

function isPlatformStats(value: unknown): value is PlatformStats {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const stats = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(stats.onlineGuests) &&
    (stats.onlineGuests as number) >= 0 &&
    Number.isSafeInteger(stats.activeRooms) &&
    (stats.activeRooms as number) >= 0
  );
}

function usePlatformStats(displayName: string): PlatformStats | null {
  const [presenceId] = useState(() => crypto.randomUUID());
  const [stats, setStats] = useState<PlatformStats | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let refreshTimer: number | undefined;
    let refreshing = false;
    let refreshAgain = false;
    let sessionReady = false;
    const clearRefreshTimer = () => {
      if (refreshTimer !== undefined) {
        window.clearTimeout(refreshTimer);
        refreshTimer = undefined;
      }
    };
    const refresh = async () => {
      clearRefreshTimer();
      if (refreshing) {
        refreshAgain = true;
        return;
      }
      refreshing = true;
      try {
        if (!sessionReady) {
          await ensureBrowserSession(displayName, controller.signal);
          sessionReady = true;
        }
        const response = await fetch("/api/stats", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ presenceId }),
          signal: controller.signal,
        });
        const value: unknown = await response.json();
        if (response.status === 401) sessionReady = false;
        if (!response.ok || !isPlatformStats(value)) return;
        setStats(value);
      } catch {
        // Keep the last known values when the network is temporarily unavailable.
      } finally {
        refreshing = false;
        if (controller.signal.aborted) return;
        if (refreshAgain) {
          refreshAgain = false;
          void refresh();
        } else {
          refreshTimer = window.setTimeout(() => void refresh(), 10_000);
        }
      }
    };
    const refreshNow = () => void refresh();
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refreshNow();
    };
    window.addEventListener("online", refreshNow);
    window.addEventListener("pageshow", refreshNow);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    void refresh();
    return () => {
      controller.abort();
      clearRefreshTimer();
      window.removeEventListener("online", refreshNow);
      window.removeEventListener("pageshow", refreshNow);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [displayName, presenceId]);

  useEffect(() => {
    const leave = () => {
      const body = JSON.stringify({ presenceId });
      let queued = false;
      try {
        queued = navigator.sendBeacon(
          "/api/presence/leave",
          new Blob([body], { type: "application/json" }),
        );
      } catch {
        // Fall back to a keepalive request when Beacon is unavailable.
      }
      if (!queued) {
        void fetch("/api/presence/leave", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          keepalive: true,
        }).catch(() => undefined);
      }
    };
    window.addEventListener("pagehide", leave);
    return () => window.removeEventListener("pagehide", leave);
  }, [presenceId]);

  return stats;
}

function randomDisplayName(): string {
  const random = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  return `棋友${String(random % 10_000).padStart(4, "0")}`;
}

function storeDisplayName(displayName: string): void {
  memoryDisplayName = displayName;
  try {
    localStorage.setItem(DISPLAY_NAME_STORAGE_KEY, displayName);
  } catch {
    // Some privacy modes disable localStorage; keep the name for this page.
  }
}

function loadDisplayName(): string {
  if (memoryDisplayName !== null) return memoryDisplayName;
  try {
    const stored = normalizeDisplayName(
      localStorage.getItem(DISPLAY_NAME_STORAGE_KEY),
    );
    if (stored !== null) {
      storeDisplayName(stored);
      return stored;
    }
  } catch {
    // Fall through to a page-local default when storage is unavailable.
  }
  const generated = randomDisplayName();
  storeDisplayName(generated);
  return generated;
}

function DisplayNameEditor({
  displayName,
  onSave,
}: {
  displayName: string;
  onSave(displayName: string): void;
}) {
  const [draft, setDraft] = useState(displayName);
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    setDraft(displayName);
  }, [displayName]);

  return (
    <form
      class="display-name-editor"
      aria-label="设置游客昵称"
      onSubmit={(event) => {
        event.preventDefault();
        const normalized = normalizeDisplayName(draft);
        if (normalized === null) {
          setFeedback("昵称需为 1–16 个字符，且不能包含控制字符。");
          return;
        }
        setDraft(normalized);
        setFeedback("昵称已保存");
        onSave(normalized);
      }}
    >
      <label for="guest-display-name">你的昵称</label>
      <div class="display-name-controls">
        <input
          id="guest-display-name"
          name="displayName"
          value={draft}
          autocomplete="nickname"
          aria-describedby="display-name-help display-name-feedback"
          onInput={(event) => {
            setDraft(event.currentTarget.value);
            setFeedback(null);
          }}
        />
        <button class="secondary-button" type="submit">保存昵称</button>
      </div>
      <small id="display-name-help">1–16 个字符，保存在此浏览器</small>
      <span
        id="display-name-feedback"
        class={
          feedback?.startsWith("昵称已")
            ? "display-name-feedback is-success"
            : "display-name-feedback"
        }
        aria-live="polite"
      >
        {feedback}
      </span>
    </form>
  );
}

function Brand() {
  return (
    <a class="brand" href="/" aria-label="ym0v0 棋局首页">
      <span class="brand-mark" aria-hidden="true">棋</span>
      <span>ym0v0 棋局</span>
    </a>
  );
}

function LandingPage({
  displayName,
  onDisplayNameChange,
  stats,
}: {
  displayName: string;
  onDisplayNameChange(displayName: string): void;
  stats: PlatformStats | null;
}) {
  const [creating, setCreating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const createRoom = async (gameType: string, ruleSetId: string) => {
    if (creating !== null) return;
    setCreating(ruleSetId);
    setError(null);
    try {
      await ensureBrowserSession(displayName);
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
    } catch (failure) {
      setCreating(null);
      setError(
        failure instanceof Error &&
          failure.message === "room.capacity_reached"
          ? "当前已有 10 个房间，请稍后再试。"
          : "建房失败，请检查网络后重试。",
      );
    }
  };

  return (
    <main class="landing">
      <nav class="topbar">
        <Brand />
        <div
          class="platform-stats"
          aria-label="平台实时状态"
          aria-live="polite"
        >
          <span>在线 {stats?.onlineGuests ?? "—"} 人</span>
          <span aria-hidden="true">·</span>
          <span>房间 {stats?.activeRooms ?? "—"} 个</span>
        </div>
      </nav>
      <section class="hero">
        <p class="eyebrow">轻量 · 实时 · 无需注册</p>
        <h1>一条链接，<br />马上下一局。</h1>
        <p class="hero-copy">
          创建私人棋局，把邀请链接发给朋友。没有账号、广告和复杂大厅。
        </p>
        <DisplayNameEditor
          displayName={displayName}
          onSave={onDisplayNameChange}
        />
        <div class="game-choice-grid" aria-label="选择棋种">
          <a
            href="/minesweeper"
            class="secondary-button hero-button game-choice link-button"
          >
            <strong>单人扫雷</strong>
            <small>本机运行 · 三种难度 · 不占房间名额</small>
          </a>
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
        五子棋、中国象棋、井字棋与扫雷 · 一条邀请链接，一局私人对战
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
  adapter: GameAdapter | null,
): string {
  if (phase !== "online" || snapshot === null) {
    return phaseText(phase, transport);
  }
  const outcome = snapshot.position?.outcome ?? null;
  if (outcome !== null) {
    const gameMessage = adapter?.getOutcomeMessage?.(outcome, {
      selfSeat: snapshot.selfSeat,
      winnerDisplayName: outcome.kind === "win"
        ? snapshot.seats[outcome.winner]?.displayName ?? null
        : null,
    });
    if (gameMessage !== null && gameMessage !== undefined) return gameMessage;
  }
  if (snapshot.selfSeat === null) {
    if (outcome === null) return "正在观战";
    if (outcome.kind === "draw") return "本局和棋";
    const winnerName = snapshot.seats[outcome.winner]?.displayName ?? null;
    return winnerName === null ? "本局已分胜负" : `${winnerName}获胜`;
  }
  if (snapshot.position === null) return "等待对手加入";
  if (outcome?.kind === "draw") return "本局和棋";
  if (outcome?.kind === "win") {
    return outcome.winner === snapshot.selfSeat ? "你赢了" : "对手获胜";
  }
  const gameStatus = adapter?.getStatusMessage?.(
    snapshot.position,
    snapshot.selfSeat,
  );
  if (gameStatus !== undefined) return gameStatus;
  return snapshot.position.turn === snapshot.selfSeat ? "轮到你" : "等待对手落子";
}

function RoomPage({
  roomId,
  displayName,
  onDisplayNameChange,
  onExit,
}: {
  roomId: string;
  displayName: string;
  onDisplayNameChange(displayName: string): void;
  onExit(): void;
}) {
  const client = useRoom(roomId, displayName);
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
  const selfSeat = snapshot?.selfSeat ?? null;
  const isPlayer = selfSeat !== null;
  const canPlace =
    client.phase === "online" &&
    !client.leaving &&
    adapter !== null &&
    isPlayer &&
    bothOccupied &&
    outcome === null;
  const ownReady =
    snapshot !== null &&
    selfSeat !== null &&
    snapshot.seats[selfSeat]?.rematchReady === true;
  const spectators = snapshot?.spectators ?? [];

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
              : mainStatus(
                  snapshot,
                  client.phase,
                  client.transport,
                  adapter,
                )}
          </h1>
        </header>

        <DisplayNameEditor
          displayName={displayName}
          onSave={onDisplayNameChange}
        />

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
                  <strong>
                    {seat?.displayName ?? (seat?.occupied ? "棋友" : "等待加入")}
                    {isSelf ? " · 你" : ""}
                  </strong>
                  <small>
                    {presentation.label} · {seat?.occupied
                      ? seat.online
                        ? "在线"
                        : "暂时离线"
                      : "等待加入"}
                    {seat?.rematchReady ? " · 已准备" : ""}
                  </small>
                </span>
              </div>
            );
          })}
        </div>

        <section
          class="spectator-panel"
          aria-label={`观众，共 ${spectators.length} 人`}
        >
          <strong>观战 {spectators.length}</strong>
          <div class="spectator-list">
            {spectators.length === 0 ? (
              <span class="spectator-empty">暂无观众</span>
            ) : spectators.map((spectator, index) => (
              <span
                class={`spectator-chip ${spectator.isSelf ? "is-self" : ""}`}
                key={`${spectator.displayName}-${index}`}
              >
                {spectator.displayName}{spectator.isSelf ? " · 你" : ""}
              </span>
            ))}
          </div>
        </section>

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
            pendingCells={client.pendingCells}
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
          {isPlayer &&
            adapter &&
            snapshot?.position &&
            outcome === null &&
            bothOccupied && (
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
          {isPlayer && adapter && outcome && (
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
  const [displayName, setDisplayName] = useState(loadDisplayName);
  const stats = usePlatformStats(displayName);
  const saveDisplayName = (nextDisplayName: string) => {
    storeDisplayName(nextDisplayName);
    setDisplayName(nextDisplayName);
  };
  useEffect(() => {
    const updatePath = () => setPath(location.pathname);
    window.addEventListener("popstate", updatePath);
    return () => window.removeEventListener("popstate", updatePath);
  }, []);

  if (path === "/" || path === "") {
    return (
      <LandingPage
        displayName={displayName}
        onDisplayNameChange={saveDisplayName}
        stats={stats}
      />
    );
  }
  if (path === "/minesweeper" || path === "/minesweeper/") {
    return <SoloPage />;
  }
  const match = path.match(ROOM_PATH);
  if (match?.[1]) {
    return (
      <RoomPage
        roomId={match[1]}
        displayName={displayName}
        onDisplayNameChange={saveDisplayName}
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
