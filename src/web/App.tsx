import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { normalizeDisplayName } from "../shared/display-name";
import type {
  RoomPreparationView,
  RoomSnapshot,
} from "../shared/protocol";
import {
  GameErrorBoundary,
  GameRenderer,
  getGameAdapter,
  projectPendingCells,
  resolveGameErrorMessage,
  type GameAdapter,
  type SeatPresentations,
  UnsupportedGame,
  unknownSeatPresentations,
} from "./games/registry";
import {
  clientGameCatalog,
  LANDING_GAME_CATALOG,
  OTHER_SERVICE_LINKS,
  getClientGameCatalogEntry,
  resolveRematchModeOptions,
  type ClientGamePage,
  type GameLaunchTarget,
  type LocalGamePageProps,
} from "./games/catalog";
import {
  ensureBrowserSession,
  useRoom,
  type ConnectionPhase,
  type RoomTransport,
} from "./room-client";
import { ProfileMenu } from "./ProfileMenu";
import { OpeningRolePanel } from "./OpeningRolePanel";
import {
  RematchModeSelector,
} from "./RematchModeSelector";
import { ThemeToggle } from "./theme";
import { requestJsonWithRetry } from "./api-request";

export {
  LANDING_GAME_CATALOG,
  OTHER_SERVICE_LINKS,
  resolveRematchModeOptions,
} from "./games/catalog";
export {
  resolveChaseLaunch,
  type ChaseDifficulty,
} from "./games/chase/launch";
export {
  resolveChineseCheckersLaunch,
  type ChineseCheckersPlayerCount,
} from "./games/chinese-checkers/launch";
export {
  resolveMinesweeperLaunch,
  type MinesweeperLaunchMode,
  type MinesweeperPreset,
} from "./games/minesweeper/launch";

const ROOM_PATH = /^\/r\/([A-Za-z0-9_-]{16})\/?$/u;
const LOCAL_GAME_PATH = /^\/([A-Za-z0-9_-]+)\/?$/u;
const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{16}$/u;
const DISPLAY_NAME_STORAGE_KEY = "ym0v0.display-name";
const DISPLAY_NAME_CONFIRMED_STORAGE_KEY = "ym0v0.display-name-confirmed";
let memoryDisplayName: string | null = null;
let displayNameNeedsPrompt = false;

interface PlatformStats {
  onlineGuests: number;
  activeRooms: number;
}

export function localGameIdFromPath(path: string): string | null {
  const gameId = path.match(LOCAL_GAME_PATH)?.[1];
  if (gameId === undefined) return null;
  return getClientGameCatalogEntry(gameId)?.loadPage === undefined
    ? null
    : gameId;
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
  const presenceSequence = useRef(0);
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
        const { response, data } = await requestJsonWithRetry<unknown>(
          "/api/stats",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({
              presenceId,
              clientSeq: ++presenceSequence.current,
            }),
            signal: controller.signal,
          },
        );
        if (response.status === 401) sessionReady = false;
        if (!response.ok || !isPlatformStats(data)) return;
        setStats(data);
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
      const body = JSON.stringify({
        presenceId,
        clientSeq: ++presenceSequence.current,
      });
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

export function shouldPromptForDisplayName(
  storedName: unknown,
  confirmationFlag: string | null,
): boolean {
  return normalizeDisplayName(storedName) === null || confirmationFlag !== "1";
}

function storeDisplayName(displayName: string): void {
  memoryDisplayName = displayName;
  try {
    localStorage.setItem(DISPLAY_NAME_STORAGE_KEY, displayName);
  } catch {
    // Some privacy modes disable localStorage; keep the name for this page.
  }
}

function confirmDisplayName(displayName: string): void {
  storeDisplayName(displayName);
  try {
    localStorage.setItem(DISPLAY_NAME_CONFIRMED_STORAGE_KEY, "1");
  } catch {
    // Some privacy modes disable localStorage; the current page still remembers it.
  }
}

function loadDisplayName(): string {
  if (memoryDisplayName !== null) return memoryDisplayName;
  try {
    const rawStored = localStorage.getItem(DISPLAY_NAME_STORAGE_KEY);
    const stored = normalizeDisplayName(rawStored);
    if (stored !== null) {
      displayNameNeedsPrompt = shouldPromptForDisplayName(
        rawStored,
        localStorage.getItem(DISPLAY_NAME_CONFIRMED_STORAGE_KEY),
      );
      storeDisplayName(stored);
      return stored;
    }
    localStorage.removeItem(DISPLAY_NAME_CONFIRMED_STORAGE_KEY);
  } catch {
    // Fall through to a page-local default when storage is unavailable.
  }
  const generated = randomDisplayName();
  displayNameNeedsPrompt = true;
  storeDisplayName(generated);
  return generated;
}

function Brand() {
  return (
    <a class="brand" href="/" aria-label="返回首页">
      <span class="brand-mark" aria-hidden="true">棋</span>
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
  const [activePicker, setActivePicker] = useState<string | null>(null);
  const pickerTriggerRefs = useRef(new Map<string, HTMLButtonElement>());

  const createRoom = async (gameType: string, ruleSetId: string) => {
    if (creating !== null) return;
    setCreating(ruleSetId);
    setError(null);
    try {
      await ensureBrowserSession(displayName);
      const { response, data } = await requestJsonWithRetry<{
        roomId?: string;
        error?: string;
      }>(
        "/api/rooms",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            gameType,
            ruleSetId,
          }),
        },
        {
          maxAttempts: 1,
          attemptTimeoutMs: 30_000,
          totalTimeoutMs: 30_000,
          readErrorBody: true,
        },
      );
      const body = data ?? {};
      if (
        !response.ok ||
        typeof body.roomId !== "string" ||
        !ROOM_ID_PATTERN.test(body.roomId)
      ) {
        throw new Error(body.error);
      }
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

  const launch = (target: GameLaunchTarget) => {
    if (target.kind === "navigate") {
      location.assign(target.href);
      return;
    }
    void createRoom(target.gameType, target.ruleSetId);
  };

  const closePicker = () => {
    const pickerId = activePicker;
    setActivePicker(null);
    setError(null);
    if (pickerId !== null) {
      requestAnimationFrame(() => {
        pickerTriggerRefs.current.get(pickerId)?.focus();
      });
    }
  };

  const activeEntry = activePicker === null
    ? undefined
    : LANDING_GAME_CATALOG.find((entry) => entry.id === activePicker);
  const Picker = activeEntry?.picker;

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
        <div class="topbar-actions">
          <ProfileMenu
            displayName={displayName}
            initiallyOpen={displayNameNeedsPrompt}
            onSave={onDisplayNameChange}
          />
          <ThemeToggle />
        </div>
      </nav>
      <section class="hero">
        <h1>想下哪一局？</h1>
        <p class="hero-copy">
          和朋友开一局，或者玩一盘单机小游戏。
        </p>
        <div class="game-choice-grid" aria-label="选择棋种">
          {LANDING_GAME_CATALOG.map((game) => (
            <button
              key={game.id}
              ref={(element) => {
                if (element === null) pickerTriggerRefs.current.delete(game.id);
                else pickerTriggerRefs.current.set(game.id, element);
              }}
              class="secondary-button hero-button game-choice"
              type="button"
              aria-label={game.ariaLabel}
              aria-haspopup={game.launch.kind === "picker" ? "dialog" : undefined}
              onClick={() => {
                setError(null);
                if (game.launch.kind === "picker") {
                  setActivePicker(game.id);
                } else {
                  launch(game.launch);
                }
              }}
              disabled={creating !== null}
            >
              <span class="game-choice-heading">
                <strong>
                  {game.launch.kind === "room" &&
                      creating === game.launch.ruleSetId
                    ? "正在创建…"
                    : game.label}
                </strong>
                {game.launch.kind !== "room" && (
                  <span class="game-choice-chevron" aria-hidden="true">›</span>
                )}
              </span>
              <small>{game.description}</small>
            </button>
          ))}
        </div>
        <section class="other-services" aria-labelledby="other-services-title">
          <h2 class="eyebrow" id="other-services-title">其他服务</h2>
          <div class="other-service-grid">
            {OTHER_SERVICE_LINKS.map((service) => (
              <a
                class="secondary-button game-choice service-link"
                key={service.id}
                href={service.href}
                target="_blank"
                rel="noreferrer"
                aria-label={`${service.label}（${service.description}），在新标签页打开`}
              >
                <span class="game-choice-heading">
                  <strong>{service.label}</strong>
                  <span class="game-choice-chevron" aria-hidden="true">↗</span>
                </span>
                <small>{service.description}</small>
              </a>
            ))}
          </div>
        </section>
        {error && activePicker === null && (
          <p class="inline-error" role="alert">{error}</p>
        )}
      </section>
      {Picker !== undefined && (
        <Picker
          creating={creating !== null}
          error={error}
          onLaunch={launch}
          onClose={closePicker}
        />
      )}
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

function preparationSeatPresentations(
  adapter: GameAdapter,
  preparation: RoomPreparationView,
): SeatPresentations {
  const choices = adapter.openingChoices ?? [];
  const presentationFor = (seat: "seat-a" | "seat-b") => {
    const roleId = preparation.roleBySeat[seat];
    const choice = choices.find((entry) => entry.roleId === roleId);
    return choice === undefined
      ? { label: "未选择", swatchClassName: "neutral" }
      : {
          label: choice.label,
          swatchClassName: choice.swatchClassName,
        };
  };
  return {
    "seat-a": presentationFor("seat-a"),
    "seat-b": presentationFor("seat-b"),
  };
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
    if (snapshot.preparation !== null && snapshot.preparation !== undefined) {
      return "等待双方选择角色";
    }
    if (outcome === null) return "正在观战";
    if (outcome.kind === "draw") return "本局和棋";
    const winnerName = snapshot.seats[outcome.winner]?.displayName ?? null;
    return winnerName === null ? "本局已分胜负" : `${winnerName}获胜`;
  }
  if (snapshot.preparation !== null && snapshot.preparation !== undefined) {
    const roleId = snapshot.preparation.roleBySeat[snapshot.selfSeat] ?? null;
    if (roleId === null) return "请选择你的角色";
    const roleLabel = adapter?.openingChoices?.find(
      (choice) => choice.roleId === roleId,
    )?.label;
    return `已选择${roleLabel ?? "角色"}，等待对手`;
  }
  if (snapshot.position === null) return "等待其他玩家加入";
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
  const client = useRoom(roomId, displayName, {
    resolveErrorMessage: resolveGameErrorMessage,
  });
  const snapshot = client.snapshot;
  const adapter =
    snapshot === null
      ? null
      : getGameAdapter(snapshot.gameType, snapshot.ruleSetId);
  const pendingCells = useMemo(
    () => projectPendingCells(adapter, client.pendingActions),
    [adapter, client.pendingActions],
  );
  const unsupportedGame = snapshot !== null && adapter === null;
  const seatPresentations = snapshot?.preparation !== null &&
      snapshot?.preparation !== undefined &&
      adapter !== null
    ? preparationSeatPresentations(adapter, snapshot.preparation)
    : adapter?.getSeatPresentations(snapshot?.position ?? null) ??
      unknownSeatPresentations;
  const gameName =
    adapter?.displayName ?? (snapshot === null ? "自由五子棋" : "未知棋类");
  const [shareNotice, setShareNotice] = useState<string | null>(null);
  const seatOrder = snapshot?.seatOrder ??
    (snapshot === null ? ["seat-a", "seat-b"] : Object.keys(snapshot.seats));
  const allOccupied =
    seatOrder.length >= 2 &&
    seatOrder.every((seatId) => snapshot?.seats[seatId]?.occupied === true);
  const outcome = snapshot?.position?.outcome ?? null;
  const selfSeat = snapshot?.selfSeat ?? null;
  const isPlayer = selfSeat !== null;
  const canPlace =
    client.phase === "online" &&
    !client.leaving &&
    adapter !== null &&
    isPlayer &&
    allOccupied &&
    snapshot?.position !== null &&
    snapshot?.position !== undefined &&
    (snapshot?.preparation === null || snapshot?.preparation === undefined) &&
    outcome === null;
  const ownReady =
    snapshot !== null &&
    selfSeat !== null &&
    snapshot.seats[selfSeat]?.rematchReady === true;
  const rematchModeOptions = useMemo(
    () =>
      resolveRematchModeOptions(
        snapshot?.gameType ?? "",
        snapshot?.rematchOptions,
      ),
    [snapshot?.gameType, snapshot?.rematchOptions],
  );
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
        <nav class="topbar">
          <Brand />
          <div class="topbar-actions">
            <ThemeToggle />
          </div>
        </nav>
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
              ? "实时连接暂不可用，已通过 HTTPS 连接"
              : undefined
          }
        >
          <span aria-hidden="true" />
          {phaseText(client.phase, client.transport)}
        </span>
        <div class="topbar-actions">
          <ProfileMenu
            displayName={displayName}
            initiallyOpen={displayNameNeedsPrompt}
            onSave={onDisplayNameChange}
          />
          <ThemeToggle />
        </div>
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

        <div class="seat-strip">
          {seatOrder.map((seatId, index) => {
            const seat = snapshot?.seats[seatId];
            const isSelf = snapshot?.selfSeat === seatId;
            const presentation = seatPresentations[seatId] ?? {
              label: `席位 ${String.fromCharCode(65 + index)}`,
              swatchClassName: "neutral",
            };
            return (
              <div
                key={seatId}
                class={`seat-card ${isSelf ? "is-self" : ""}`}
                data-seat={seatId}
              >
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

        {snapshot?.preparation && adapter?.openingChoices && (
          <OpeningRolePanel
            preparation={snapshot.preparation}
            openingChoices={adapter.openingChoices}
            selfSeat={snapshot.selfSeat}
            pending={client.pending}
            disabled={client.phase !== "online" || client.leaving}
            onSelect={(roleId) => {
              client.selectOpeningRole(roleId);
            }}
          />
        )}

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
            pendingCells={pendingCells}
            onAction={(payload) => client.sendGameAction(payload)}
          />
        ) : snapshot?.preparation ? null : (
          <div class="board-placeholder" aria-label="等待玩家加入的空棋盘">
            <span>
              已加入 {seatOrder.filter((seatId) =>
                snapshot?.seats[seatId]?.occupied === true
              ).length} / {seatOrder.length} 人，坐满后开始
            </span>
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

        {outcome !== null &&
          snapshot?.rematchOptions !== null &&
          snapshot?.rematchOptions !== undefined &&
          rematchModeOptions.length > 1 && (
          <RematchModeSelector
            options={rematchModeOptions}
            selectedRuleSetId={snapshot.rematchOptions.selectedRuleSetId}
            disabled={
              !isPlayer ||
              client.leaving ||
              client.pending ||
              client.phase !== "online"
            }
            onSelect={(ruleSetId) => {
              if (
                ruleSetId !== snapshot.rematchOptions?.selectedRuleSetId
              ) {
                client.selectRematchRule(ruleSetId);
              }
            }}
          />
        )}

        <div class="room-actions">
          <button
            class="secondary-button"
            disabled={client.leaving}
            onClick={share}
          >
            {allOccupied ? "分享房间" : "邀请好友"}
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
            allOccupied &&
            snapshot.capabilities?.resign !== false && (
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
      <nav class="topbar">
        <Brand />
        <div class="topbar-actions">
          <ThemeToggle />
        </div>
      </nav>
      <section class="fatal-card">
        <p class="eyebrow">404</p>
        <h1>这里没有棋盘</h1>
        <a class="primary-button link-button" href="/">返回首页</a>
      </section>
    </main>
  );
}

/** Load a local-game page only when its route is actually visited. */
function LocalGamePageRoute({
  gameId,
  ...pageProps
}: LocalGamePageProps & { gameId: string }) {
  const [Page, setPage] = useState<ClientGamePage | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    const loader = getClientGameCatalogEntry(gameId)?.loadPage;
    if (loader === undefined) {
      setFailed(true);
      return () => {
        active = false;
      };
    }
    void loader().then(
      (nextPage) => {
        if (!active) return;
        setPage(() => nextPage);
      },
      () => {
        if (!active) return;
        setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [gameId]);

  if (failed) {
    return (
      <main class="landing">
        <nav class="topbar">
          <Brand />
          <div class="topbar-actions">
            <ThemeToggle />
          </div>
        </nav>
        <section class="fatal-card" role="alert">
          <p class="eyebrow">游戏不可用</p>
          <h1>暂时无法加载这个游戏</h1>
          <p>请刷新页面后重试。</p>
          <a class="primary-button link-button" href="/">返回首页</a>
        </section>
      </main>
    );
  }
  if (Page === null) {
    return (
      <main class="landing">
        <nav class="topbar">
          <Brand />
          <div class="topbar-actions">
            <ThemeToggle />
          </div>
        </nav>
        <section class="fatal-card" role="status" aria-live="polite">
          <p class="eyebrow">正在加载</p>
          <h1>正在准备游戏…</h1>
        </section>
      </main>
    );
  }
  return (
    <GameErrorBoundary gameName={gameId}>
      <Page {...pageProps} />
    </GameErrorBoundary>
  );
}

export function App() {
  const [path, setPath] = useState(location.pathname);
  const [displayName, setDisplayName] = useState(loadDisplayName);
  const stats = usePlatformStats(displayName);
  const saveDisplayName = (nextDisplayName: string) => {
    displayNameNeedsPrompt = false;
    confirmDisplayName(nextDisplayName);
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
  const localGameId = localGameIdFromPath(path);
  if (localGameId !== null) {
    return (
      <LocalGamePageRoute
        gameId={localGameId}
        displayName={displayName}
        initiallyOpenProfile={displayNameNeedsPrompt}
        onDisplayNameChange={saveDisplayName}
      />
    );
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
