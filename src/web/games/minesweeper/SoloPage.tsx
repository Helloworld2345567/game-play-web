import { useEffect, useRef, useState } from "preact/hooks";
import {
  applySoloAction,
  createSoloGame,
  type SoloGameState,
} from "../../../games/minesweeper/solo-controller";
import {
  MINEFIELD_PRESETS,
  type MinefieldPresetId,
} from "../../../games/minesweeper/presets";
import {
  projectHiddenMinefield,
  projectMinefield,
} from "../../../games/minesweeper/public-view";
import {
  MinesweeperBoard,
  type MinesweeperBoardAction,
} from "./Board";
import {
  loadMinesweeperLeaderboard,
  type MinesweeperLeaderboardSnapshot,
  recordMinesweeperWin,
} from "./leaderboard-client";
import { ProfileMenu } from "../../ProfileMenu";

const EMPTY_PENDING_CELLS: ReadonlySet<string> = new Set<string>();

const PRESET_LABELS: Readonly<Record<MinefieldPresetId, string>> = {
  small: "小型 · 9×9 · 10 雷",
  medium: "中型 · 16×16 · 40 雷",
  large: "大型 · 30×16 · 99 雷",
};

const STATUS_LABELS: Readonly<Record<SoloGameState["status"], string>> = {
  ready: "点击任意格开始",
  playing: "扫雷中",
  paused: "已暂停",
  won: "全部安全格已揭开，你赢了",
  lost: "踩到地雷，本局失败",
};

export function formatElapsedTime(elapsedMs: number): string {
  const totalSeconds = Math.floor(Math.max(0, elapsedMs) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function formatLeaderboardTime(elapsedMs: number): string {
  const totalCentiseconds = Math.floor(Math.max(0, elapsedMs) / 10);
  const minutes = Math.floor(totalCentiseconds / 6_000);
  const seconds = Math.floor((totalCentiseconds % 6_000) / 100);
  const centiseconds = totalCentiseconds % 100;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}`;
}

export function advancePlayingClock(
  game: SoloGameState,
  previousTickAt: number,
  now: number,
): SoloGameState {
  if (game.status !== "playing") return game;
  return applySoloAction(game, {
    type: "advance_time",
    deltaMs: Math.max(0, now - previousTickAt),
  }).state;
}

export function isNewPersonalBest(
  previousBestMs: number | null,
  completedElapsedMs: number,
  confirmedBestMs: number | null,
): boolean {
  const submittedElapsedMs = Math.max(1, Math.round(completedElapsedMs));
  return confirmedBestMs === submittedElapsedMs &&
    (previousBestMs === null || submittedElapsedMs < previousBestMs);
}

export function presetFromSearch(search: string): MinefieldPresetId {
  const presetId = new URLSearchParams(search).get("preset");
  return presetId === "medium" || presetId === "large" ? presetId : "small";
}

function newSoloGame(presetId: MinefieldPresetId): SoloGameState {
  return createSoloGame(MINEFIELD_PRESETS[presetId], crypto.randomUUID());
}

export function SoloPage({
  displayName,
  initiallyOpenProfile = false,
  onDisplayNameChange,
}: {
  displayName: string;
  initiallyOpenProfile?: boolean;
  onDisplayNameChange(displayName: string): void;
}) {
  const [presetId, setPresetId] = useState<MinefieldPresetId>(() =>
    presetFromSearch(location.search)
  );
  const [game, setGame] = useState<SoloGameState>(() =>
    newSoloGame(presetFromSearch(location.search))
  );
  const [leaderboard, setLeaderboard] =
    useState<MinesweeperLeaderboardSnapshot | null>(null);
  const [leaderboardStatus, setLeaderboardStatus] =
    useState<"loading" | "ready" | "offline">("loading");
  const [recordNotice, setRecordNotice] = useState<string | null>(null);
  const submittedGames = useRef(new Set<string>());
  const leaderboardRequest = useRef(0);
  const previousTickAt = useRef<number | null>(null);

  useEffect(() => {
    if (game.status !== "playing") return;
    previousTickAt.current ??= performance.now();
    const timer = globalThis.setInterval(() => {
      const now = performance.now();
      setGame((current) => {
        const previous = previousTickAt.current ?? now;
        previousTickAt.current = now;
        return advancePlayingClock(current, previous, now);
      });
    }, 250);
    return () => globalThis.clearInterval(timer);
  }, [game.status]);

  useEffect(() => {
    const controller = new AbortController();
    const requestId = ++leaderboardRequest.current;
    setLeaderboardStatus("loading");
    void loadMinesweeperLeaderboard(
      displayName,
      presetId,
      controller.signal,
    ).then(
      (snapshot) => {
        if (leaderboardRequest.current !== requestId) return;
        setLeaderboard(snapshot);
        setLeaderboardStatus("ready");
      },
      () => {
        if (controller.signal.aborted || leaderboardRequest.current !== requestId) {
          return;
        }
        setLeaderboard(null);
        setLeaderboardStatus("offline");
      },
    );
    return () => controller.abort();
  }, [displayName, presetId]);

  useEffect(() => {
    if (game.status !== "won" || submittedGames.current.has(game.seed)) return;
    submittedGames.current.add(game.seed);
    const controller = new AbortController();
    const requestId = ++leaderboardRequest.current;
    const previousBest = leaderboard?.personalBestMs ?? null;
    setRecordNotice("正在保存本局纪录…");
    void recordMinesweeperWin(
      displayName,
      presetId,
      Math.max(1, game.elapsedMs),
      controller.signal,
    ).then(
      (snapshot) => {
        if (leaderboardRequest.current !== requestId) return;
        setLeaderboard(snapshot);
        setLeaderboardStatus("ready");
        setRecordNotice(
          isNewPersonalBest(
            previousBest,
            game.elapsedMs,
            snapshot.personalBestMs,
          )
            ? "新的个人最佳！"
            : "本局成绩已记录",
        );
      },
      () => {
        if (controller.signal.aborted || leaderboardRequest.current !== requestId) {
          return;
        }
        setLeaderboardStatus("offline");
        setRecordNotice("本局已完成，纪录暂未同步");
      },
    );
    return () => controller.abort();
  }, [displayName, game.elapsedMs, game.seed, game.status, leaderboard, presetId]);

  const view = game.field === null
    ? projectHiddenMinefield(game.config, game.progress)
    : projectMinefield(game.field, game.progress, {
        revealMines: game.status === "lost",
      });
  const boardMode =
    game.status === "ready" || game.status === "playing"
      ? "playing" as const
      : "disabled" as const;
  const flagCount = game.progress.flags.filter(Boolean).length;

  const restart = (nextPresetId = presetId) => {
    const seed = crypto.randomUUID();
    previousTickAt.current = null;
    setGame((current) =>
      applySoloAction(current, {
        type: "restart",
        config: MINEFIELD_PRESETS[nextPresetId],
        seed,
      }).state
    );
    setRecordNotice(null);
  };

  const handleBoardAction = (action: MinesweeperBoardAction) => {
    if (action.type === "select_start") return;
    const now = performance.now();
    setGame((current) => {
      const timed = previousTickAt.current === null
        ? current
        : advancePlayingClock(current, previousTickAt.current, now);
      const next = applySoloAction(timed, action).state;
      previousTickAt.current = next.status === "playing" ? now : null;
      return next;
    });
  };

  return (
    <main class="minesweeper-solo-page">
      <nav class="minesweeper-solo-topbar">
        <a class="secondary-button minesweeper-home-link" href="/">
          返回首页
        </a>
        <ProfileMenu
          displayName={displayName}
          initiallyOpen={initiallyOpenProfile}
          onSave={onDisplayNameChange}
        />
      </nav>
      <header class="minesweeper-solo-header">
        <div>
          <p class="eyebrow">单人 · 本机游戏</p>
          <h1>扫雷</h1>
          <p class="minesweeper-solo-status" aria-live="polite">
            {STATUS_LABELS[game.status]}
          </p>
        </div>
      </header>

      <section class="minesweeper-solo-controls" aria-label="单人扫雷控制">
        <label>
          难度
          <select
            value={presetId}
            onChange={(event) => {
              const nextPresetId = event.currentTarget.value as MinefieldPresetId;
              setPresetId(nextPresetId);
              const url = new URL(location.href);
              url.searchParams.set("preset", nextPresetId);
              history.replaceState(null, "", url);
              restart(nextPresetId);
            }}
          >
            {(Object.keys(MINEFIELD_PRESETS) as MinefieldPresetId[]).map(
              (id) => <option value={id}>{PRESET_LABELS[id]}</option>,
            )}
          </select>
        </label>
        <div class="minesweeper-counter" aria-label="用时">
          <small>用时</small>
          <strong>{formatElapsedTime(game.elapsedMs)}</strong>
        </div>
        <div class="minesweeper-counter" aria-label="旗帜数量">
          <small>旗帜</small>
          <strong>{flagCount}/{game.config.mineCount}</strong>
        </div>
        <div class="minesweeper-counter" aria-label="个人最佳纪录">
          <small>个人最佳</small>
          <strong>
            {leaderboard?.personalBestMs === null || leaderboard === null
              ? "—"
              : formatLeaderboardTime(leaderboard.personalBestMs)}
          </strong>
        </div>
        <button
          class="secondary-button"
          type="button"
          disabled={game.status === "ready" || game.status === "won" || game.status === "lost"}
          onClick={() => {
            const now = performance.now();
            setGame((current) => {
              const timed = previousTickAt.current === null
                ? current
                : advancePlayingClock(current, previousTickAt.current, now);
              const next = applySoloAction(timed, {
                type: timed.status === "paused" ? "resume" : "pause",
              }).state;
              previousTickAt.current = next.status === "playing" ? now : null;
              return next;
            });
          }}
        >
          {game.status === "paused" ? "继续" : "暂停"}
        </button>
        <button
          class="primary-button"
          type="button"
          onClick={() => restart()}
        >
          重新开始
        </button>
      </section>

      <MinesweeperBoard
        view={view}
        mode={boardMode}
        pendingCells={EMPTY_PENDING_CELLS}
        onAction={handleBoardAction}
      />
      <p class="board-last-move">
        桌面端左键揭开、右键插旗；手机点击揭开、长按插旗。点击已揭开的数字可快捷展开。
      </p>
      {recordNotice && (
        <p class="minesweeper-record-notice" aria-live="polite">
          {recordNotice}
        </p>
      )}
      <section class="minesweeper-leaderboard" aria-label="扫雷排行榜">
        <header>
          <div>
            <p class="eyebrow">休闲榜 · 当前难度</p>
            <h2>{PRESET_LABELS[presetId]} · 前 10</h2>
          </div>
          <span>
            {leaderboardStatus === "loading"
              ? "正在加载…"
              : leaderboardStatus === "offline"
                ? "暂时无法连接排行榜"
                : "按完成用时排序"}
          </span>
        </header>
        {leaderboard !== null && leaderboard.top.length > 0 ? (
          <ol>
            {leaderboard.top.map((entry) => (
              <li key={`${entry.rank}-${entry.displayName}-${entry.elapsedMs}`}>
                <span class="leaderboard-rank">{entry.rank}</span>
                <strong>{entry.displayName}</strong>
                <time>{formatLeaderboardTime(entry.elapsedMs)}</time>
              </li>
            ))}
          </ol>
        ) : (
          <p class="leaderboard-empty">
            {leaderboardStatus === "ready" ? "还没有完成纪录" : "—"}
          </p>
        )}
      </section>
    </main>
  );
}
