import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  createSokoban,
  moveSokoban,
  type SokobanDirection,
  type SokobanState,
  type SokobanTile,
} from "../../../games/sokoban/engine";
import {
  SOKOBAN_LEVELS,
  SOKOBAN_LEVEL_SOURCE,
} from "../../../games/sokoban/levels";
import { ProfileMenu } from "../../ProfileMenu";
import { ThemeToggle } from "../../theme";
import {
  directionForSokobanKey,
  directionForSokobanSwipe,
} from "./interactions";
import {
  loadSokobanProgress,
  recordSokobanCompletion,
  SokobanProgressRequestError,
} from "./progress-client";
import {
  bestSokobanPendingCompletions,
  createSokobanOutboxId,
  queueSokobanPendingCompletion,
  readSokobanPendingCompletions,
  removeSokobanPendingCompletion,
  type SokobanPendingCompletion,
} from "./progress-storage";
import type { SokobanProgressRecord } from "../../../shared/sokoban-progress";
import "./game.css";

interface PointerStart {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
}

const DIRECTION_BUTTONS: ReadonlyArray<{
  readonly direction: SokobanDirection;
  readonly label: string;
  readonly symbol: string;
  readonly className: string;
}> = [
  { direction: "up", label: "向上移动", symbol: "↑", className: "up" },
  { direction: "left", label: "向左移动", symbol: "←", className: "left" },
  { direction: "down", label: "向下移动", symbol: "↓", className: "down" },
  { direction: "right", label: "向右移动", symbol: "→", className: "right" },
];

const SOKOBAN_LEVEL_IDS = new Set(SOKOBAN_LEVELS.map((level) => level.id));
const EMPTY_COMPLETED_LEVEL_IDS: ReadonlySet<string> = new Set();

type SokobanBestMovesRecord = Pick<SokobanProgressRecord, "levelId" | "bestMoves">;

/**
 * Merges progress records without allowing a slower attempt to replace a
 * faster one.  The returned map follows the shipped level order so rendering
 * stays deterministic while callers can keep their previous immutable map on
 * a no-op.
 */
export function mergeSokobanBestMoves(
  current: ReadonlyMap<string, number>,
  incoming: readonly SokobanBestMovesRecord[],
): ReadonlyMap<string, number> {
  const merged = new Map(current);
  let changed = false;
  for (const record of incoming) {
    if (
      !SOKOBAN_LEVEL_IDS.has(record.levelId) ||
      !Number.isSafeInteger(record.bestMoves) ||
      record.bestMoves < 1
    ) {
      continue;
    }
    const previous = merged.get(record.levelId);
    if (previous === undefined || record.bestMoves < previous) {
      merged.set(record.levelId, record.bestMoves);
      changed = true;
    }
  }
  if (!changed) return current;
  return new Map(
    SOKOBAN_LEVELS.flatMap((level) => {
      const bestMoves = merged.get(level.id);
      return bestMoves === undefined ? [] : [[level.id, bestMoves] as const];
    }),
  );
}

function pendingRecords(
  pending: readonly SokobanPendingCompletion[],
): readonly SokobanBestMovesRecord[] {
  return bestSokobanPendingCompletions(pending).map(({ levelId, moves }) => ({
    levelId,
    bestMoves: moves,
  }));
}

export function mergeSokobanCompletedLevels(
  current: ReadonlySet<string>,
  incoming: readonly string[],
): ReadonlySet<string> {
  const merged = new Set(current);
  for (const levelId of incoming) {
    if (SOKOBAN_LEVEL_IDS.has(levelId)) merged.add(levelId);
  }
  if (merged.size === current.size) return current;
  return new Set(
    SOKOBAN_LEVELS
      .map((level) => level.id)
      .filter((levelId) => merged.has(levelId)),
  );
}

/**
 * A page-local completion may only survive a session refresh when its
 * purpose-bound sync id is exactly the one returned by the current session.
 * In particular, an old id (or an entry created before the first id was
 * observed) must never be rebound to a new anonymous Guest.
 */
export function retainSokobanPendingForSync(
  pending: readonly SokobanPendingCompletion[],
  syncId: string,
): readonly SokobanPendingCompletion[] {
  return pending.filter((completion) => completion.syncId === syncId);
}

/**
 * A completed request may only clear the page-local entry it was created
 * from.  Another tab (or a newer completion in this tab) can replace the
 * same level while the request is in flight.
 */
export function matchesSokobanPendingCompletion(
  current: SokobanPendingCompletion | undefined,
  expected: SokobanPendingCompletion,
): boolean {
  return current !== undefined &&
    current.outboxId === expected.outboxId &&
    current.levelId === expected.levelId &&
    current.moves === expected.moves &&
    current.pushes === expected.pushes &&
    current.syncId === expected.syncId;
}

export function visibleSokobanCompletedLevels(
  completed: ReadonlySet<string>,
  progressIdentityReady: boolean,
): ReadonlySet<string> {
  return progressIdentityReady ? completed : EMPTY_COMPLETED_LEVEL_IDS;
}

export function sokobanLevelIndexFromSearch(
  search: string,
  levelCount = SOKOBAN_LEVELS.length,
): number {
  const rawLevel = new URLSearchParams(search).get("level");
  if (rawLevel === null || !/^\d+$/u.test(rawLevel)) return 0;
  const levelNumber = Number(rawLevel);
  return Number.isInteger(levelNumber) &&
      levelNumber >= 1 &&
      levelNumber <= levelCount
    ? levelNumber - 1
    : 0;
}

function pointKey(x: number, y: number): string {
  return `${x},${y}`;
}

function tileAt(
  game: SokobanState,
  x: number,
  y: number,
  crates: ReadonlySet<string>,
  targets: ReadonlySet<string>,
): SokobanTile {
  const terrain = game.terrain[y * game.width + x] ?? "void";
  if (terrain === "void" || terrain === "wall") return terrain;
  const key = pointKey(x, y);
  const onTarget = targets.has(key);
  if (game.player.x === x && game.player.y === y) {
    return onTarget ? "player-on-target" : "player";
  }
  if (crates.has(key)) return onTarget ? "crate-on-target" : "crate";
  return onTarget ? "target" : "floor";
}

function tileLabel(tile: SokobanTile, x: number, y: number): string {
  const position = `第 ${y + 1} 行第 ${x + 1} 列`;
  const labels: Readonly<Record<SokobanTile, string>> = {
    void: "棋盘外",
    wall: "墙",
    floor: "地板",
    target: "目标点",
    crate: "箱子",
    "crate-on-target": "已归位的箱子",
    player: "玩家",
    "player-on-target": "站在目标点上的玩家",
  };
  return `${position}，${labels[tile]}`;
}

function updateLevelUrl(levelIndex: number): void {
  const url = new URL(window.location.href);
  if (levelIndex === 0) {
    url.searchParams.delete("level");
  } else {
    url.searchParams.set("level", String(levelIndex + 1));
  }
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
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
  const initialLevelIndex = sokobanLevelIndexFromSearch(location.search);
  const [levelIndex, setLevelIndex] = useState(initialLevelIndex);
  const [game, setGame] = useState<SokobanState>(() =>
    createSokoban(initialLevelIndex)
  );
  const [undoStack, setUndoStack] = useState<readonly SokobanState[]>([]);
  const [completedLevelIds, setCompletedLevelIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [bestMovesByLevel, setBestMovesByLevel] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );
  const [progressStatus, setProgressStatus] =
    useState<"loading" | "ready" | "saving" | "offline">("loading");
  const [progressIdentityReady, setProgressIdentityReady] = useState(false);
  const progressSyncId = useRef<string | null>(null);
  const progressIdentityReadyRef = useRef(false);
  const volatilePendingCompletions = useRef(
    new Map<string, SokobanPendingCompletion>(),
  );
  const progressSyncing = useRef(false);
  const progressSyncRequested = useRef(false);
  const progressRetryTimer = useRef<number | null>(null);
  const reloadProgressRef = useRef<(() => void) | null>(null);
  const scheduleProgressRetryRef = useRef<(() => void) | null>(null);
  const mounted = useRef(true);
  const boardRef = useRef<HTMLDivElement>(null);
  const pointerStart = useRef<PointerStart | null>(null);

  const flushPendingCompletions = useCallback(async () => {
    if (progressSyncing.current) {
      progressSyncRequested.current = true;
      return;
    }
    progressSyncing.current = true;
    let failed = false;
    let waitingForSyncId = false;
    const processedOutboxIds = new Set<string>();
    try {
      while (true) {
        const syncId = progressSyncId.current;
        if (!progressIdentityReadyRef.current || syncId === null) {
          waitingForSyncId = true;
          break;
        }
        const pendingByLevel = new Map(
          bestSokobanPendingCompletions([
            ...retainSokobanPendingForSync(
              readSokobanPendingCompletions(),
              syncId,
            ),
            ...[...volatilePendingCompletions.current.values()].filter(
              (completion) => completion.syncId === syncId,
            ),
          ]
            .filter((completion) => !processedOutboxIds.has(completion.outboxId)))
            .map((completion) => [completion.levelId, completion] as const),
        );
        const pending = SOKOBAN_LEVELS.flatMap((level) => {
          const completion = pendingByLevel.get(level.id);
          return completion === undefined ? [] : [completion];
        });
        if (pending.length === 0) break;

        const sendable = pending.filter(
          (completion) => completion.syncId === syncId,
        );
        if (sendable.length === 0) break;
        let savedAny = false;
        for (const completion of sendable) {
          if (mounted.current) setProgressStatus("saving");
          try {
            const snapshot = await recordSokobanCompletion(
              displayName,
              completion.levelId,
              completion.moves,
              completion.pushes,
              completion.syncId,
            );
            processedOutboxIds.add(completion.outboxId);
            const currentVolatile =
              volatilePendingCompletions.current.get(completion.levelId);
            if (matchesSokobanPendingCompletion(currentVolatile, completion)) {
              volatilePendingCompletions.current.delete(completion.levelId);
            }
            removeSokobanPendingCompletion(completion.outboxId);
            savedAny = true;
            if (mounted.current) {
              setCompletedLevelIds((completed) =>
                mergeSokobanCompletedLevels(
                  completed,
                  snapshot.completedLevelIds,
                )
              );
              setBestMovesByLevel((bestMoves) =>
                mergeSokobanBestMoves(bestMoves, [
                  ...snapshot.records,
                  { levelId: completion.levelId, bestMoves: completion.moves },
                ])
              );
            }
          } catch (error) {
            failed = true;
            progressSyncRequested.current = false;
            if (
              error instanceof SokobanProgressRequestError &&
              error.status === 409
            ) {
              // The signed Guest cookie changed between the snapshot and the
              // write.  Re-read the current sync id immediately; retrying the
              // old outbox entry would only produce another 409 forever.
              if (progressRetryTimer.current !== null) {
                window.clearTimeout(progressRetryTimer.current);
                progressRetryTimer.current = null;
              }
              progressIdentityReadyRef.current = false;
              if (mounted.current) {
                setProgressIdentityReady(false);
                setCompletedLevelIds(new Set());
                setBestMovesByLevel(new Map());
              }
              const reload = reloadProgressRef.current;
              if (reload !== null) {
                reload();
              } else if (mounted.current) {
                setProgressStatus("offline");
                scheduleProgressRetryRef.current?.();
              }
            } else {
              if (mounted.current) setProgressStatus("offline");
              scheduleProgressRetryRef.current?.();
            }
            break;
          }
        }
        if (failed || !savedAny) break;
      }
      if (!failed && !waitingForSyncId && mounted.current) {
        setProgressStatus("ready");
      }
    } finally {
      progressSyncing.current = false;
      const rerunRequested = progressSyncRequested.current;
      progressSyncRequested.current = false;
      if (!failed && rerunRequested && mounted.current) {
        void flushPendingCompletions();
      }
    }
  }, [displayName]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (progressRetryTimer.current !== null) {
        window.clearTimeout(progressRetryTimer.current);
        progressRetryTimer.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let loadInFlight = false;
    let reloadRequested = false;
    progressSyncId.current = null;
    progressIdentityReadyRef.current = false;
    setProgressIdentityReady(false);
    setCompletedLevelIds(new Set());
    setBestMovesByLevel(new Map());

    function retryProgress(): void {
      loadProgress();
      void flushPendingCompletions();
    }

    function scheduleRetry(): void {
      if (
        controller.signal.aborted ||
        !mounted.current ||
        progressRetryTimer.current !== null
      ) {
        return;
      }
      progressRetryTimer.current = window.setTimeout(() => {
        progressRetryTimer.current = null;
        retryProgress();
      }, 5_000);
    }

    function loadProgress(): void {
      if (loadInFlight) {
        reloadRequested = true;
        if (mounted.current) setProgressStatus("loading");
        return;
      }
      loadInFlight = true;
      if (mounted.current) setProgressStatus("loading");
      void loadSokobanProgress(displayName, controller.signal).then(
        (snapshot) => {
          if (controller.signal.aborted) return;
          if (progressRetryTimer.current !== null) {
            window.clearTimeout(progressRetryTimer.current);
            progressRetryTimer.current = null;
          }
          progressSyncId.current = snapshot.syncId;
          const allCurrentPagePending = [
            ...volatilePendingCompletions.current.values(),
          ];
          const currentPagePending = retainSokobanPendingForSync(
            allCurrentPagePending,
            snapshot.syncId,
          );
          volatilePendingCompletions.current.clear();
          for (const completion of currentPagePending) {
            volatilePendingCompletions.current.set(completion.levelId, completion);
          }
          const storedPending = retainSokobanPendingForSync(
            readSokobanPendingCompletions(),
            snapshot.syncId,
          );
          const pendingIds = bestSokobanPendingCompletions(storedPending).map(
            (completion) => completion.levelId,
          );
          const completed = new Set([
            ...snapshot.completedLevelIds,
            ...pendingIds,
            ...currentPagePending.map((completion) => completion.levelId),
          ]);
          setCompletedLevelIds(
            new Set(
              SOKOBAN_LEVELS
                .map((level) => level.id)
                .filter((levelId) => completed.has(levelId)),
            ),
          );
          setBestMovesByLevel(
            mergeSokobanBestMoves(
              new Map(),
              [
                ...snapshot.records,
                ...pendingRecords(storedPending),
                ...pendingRecords(currentPagePending),
              ],
            ),
          );
          progressIdentityReadyRef.current = true;
          if (mounted.current) {
            setProgressIdentityReady(true);
            setProgressStatus("ready");
          }
          void flushPendingCompletions();
        },
        () => {
          if (!controller.signal.aborted && mounted.current) {
            setProgressStatus("offline");
            scheduleRetry();
          }
        },
      ).finally(() => {
        loadInFlight = false;
        if (reloadRequested && !controller.signal.aborted) {
          reloadRequested = false;
          loadProgress();
        }
      });
    }
    reloadProgressRef.current = loadProgress;
    scheduleProgressRetryRef.current = scheduleRetry;
    const flushOnPageHide = () => void flushPendingCompletions();
    const retryWhenVisible = () => {
      if (document.visibilityState === "visible") retryProgress();
    };
    loadProgress();
    void flushPendingCompletions();
    window.addEventListener("online", retryProgress);
    window.addEventListener("pageshow", retryProgress);
    window.addEventListener("pagehide", flushOnPageHide);
    document.addEventListener("visibilitychange", retryWhenVisible);
    return () => {
      controller.abort();
      if (progressRetryTimer.current !== null) {
        window.clearTimeout(progressRetryTimer.current);
        progressRetryTimer.current = null;
      }
      if (reloadProgressRef.current === loadProgress) {
        reloadProgressRef.current = null;
      }
      if (scheduleProgressRetryRef.current === scheduleRetry) {
        scheduleProgressRetryRef.current = null;
      }
      window.removeEventListener("online", retryProgress);
      window.removeEventListener("pageshow", retryProgress);
      window.removeEventListener("pagehide", flushOnPageHide);
      document.removeEventListener("visibilitychange", retryWhenVisible);
    };
  }, [displayName, flushPendingCompletions]);

  useEffect(() => {
    if (game.won) void flushPendingCompletions();
  }, [flushPendingCompletions, game.won]);

  const focusBoard = useCallback(() => {
    window.setTimeout(() => boardRef.current?.focus(), 0);
  }, []);

  const selectLevel = useCallback((nextLevelIndex: number) => {
    if (
      !Number.isInteger(nextLevelIndex) ||
      nextLevelIndex < 0 ||
      nextLevelIndex >= SOKOBAN_LEVELS.length
    ) return;
    pointerStart.current = null;
    setLevelIndex(nextLevelIndex);
    setGame(createSokoban(nextLevelIndex));
    setUndoStack([]);
    updateLevelUrl(nextLevelIndex);
    focusBoard();
  }, [focusBoard]);

  const move = useCallback((direction: SokobanDirection) => {
    const syncId = progressSyncId.current;
    if (!progressIdentityReadyRef.current || syncId === null) {
      focusBoard();
      return;
    }
    setGame((current) => {
      const result = moveSokoban(current, direction);
      if (!result.moved) return current;
      setUndoStack((stack) => [...stack, current]);
      if (result.won) {
        const completion = {
          outboxId: createSokobanOutboxId(),
          levelId: result.state.levelId,
          moves: result.state.moves,
          pushes: result.state.pushes,
          syncId,
        };
        const previousPending = volatilePendingCompletions.current.get(
          completion.levelId,
        );
        if (
          previousPending === undefined ||
          completion.moves < previousPending.moves ||
          (completion.moves === previousPending.moves &&
            completion.pushes < previousPending.pushes)
        ) {
          volatilePendingCompletions.current.set(completion.levelId, completion);
        }
        queueSokobanPendingCompletion(completion);
        setCompletedLevelIds((completed) =>
          mergeSokobanCompletedLevels(completed, [completion.levelId])
        );
        setBestMovesByLevel((bestMoves) =>
          mergeSokobanBestMoves(bestMoves, [
            { levelId: completion.levelId, bestMoves: completion.moves },
          ])
        );
      }
      return result.state;
    });
    focusBoard();
  }, [focusBoard]);

  const undo = useCallback(() => {
    setUndoStack((stack) => {
      const previous = stack.at(-1);
      if (previous === undefined) return stack;
      setGame(previous);
      return stack.slice(0, -1);
    });
    focusBoard();
  }, [focusBoard]);

  const restart = useCallback(() => {
    pointerStart.current = null;
    setGame(createSokoban(levelIndex));
    setUndoStack([]);
    focusBoard();
  }, [focusBoard, levelIndex]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          /^(?:A|BUTTON|INPUT|SELECT|TEXTAREA)$/u.test(target.tagName))
      ) return;
      if (event.key === "Backspace" || event.key.toLowerCase() === "u") {
        event.preventDefault();
        undo();
        return;
      }
      if (event.key.toLowerCase() === "r") {
        event.preventDefault();
        restart();
        return;
      }
      const direction = directionForSokobanKey(event.key);
      if (direction === null) return;
      event.preventDefault();
      move(direction);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [move, restart, undo]);

  const crateKeys = new Set(game.crates.map(({ x, y }) => pointKey(x, y)));
  const targetKeys = new Set(game.targets.map(({ x, y }) => pointKey(x, y)));
  const placedCrates = game.crates.filter(({ x, y }) =>
    targetKeys.has(pointKey(x, y))
  ).length;
  const levelNumber = levelIndex + 1;
  const currentBestMoves = bestMovesByLevel.get(game.levelId);
  const visibleCompletedLevelIds = visibleSokobanCompletedLevels(
    completedLevelIds,
    progressIdentityReady,
  );

  return (
    <main class="game-sokoban-page">
      <nav class="game-sokoban-topbar">
        <a class="secondary-button game-sokoban-home-link" href="/">
          返回首页
        </a>
        <div class="topbar-actions">
          <ProfileMenu
            displayName={displayName}
            initiallyOpen={initiallyOpenProfile}
            onSave={onDisplayNameChange}
          />
          <ThemeToggle />
        </div>
      </nav>

      <header class="game-sokoban-header">
        <div>
          <p class="eyebrow">单人 · 本机解谜 · Microban 经典关卡</p>
          <h1>推箱子</h1>
          <p class="game-sokoban-status" aria-live="polite">
            {!progressIdentityReady
              ? progressStatus === "offline"
                ? "暂时无法确认游客记录，正在自动重试；确认后即可开始。"
                : "正在恢复游客通关记录，确认后即可开始。"
              : game.won
                ? "全部箱子已归位！可以进入下一关。"
                : "把所有箱子推到目标点；箱子只能推，不能拉。"}
          </p>
        </div>
        <div class="game-sokoban-stat-cards" aria-label="本关统计">
          <div class="game-sokoban-stat-card">
            <small>本关步数</small>
            <strong aria-label="本关步数">{game.moves}</strong>
          </div>
          <div class="game-sokoban-stat-card">
            <small>推动次数</small>
            <strong>{game.pushes}</strong>
          </div>
          <div class="game-sokoban-stat-card">
            <small>已归位</small>
            <strong>{placedCrates}/{game.targets.length}</strong>
          </div>
          <div class="game-sokoban-stat-card">
            <small>个人最佳</small>
            <strong aria-label="本关最佳步数">
              {currentBestMoves === undefined ? "—" : currentBestMoves}
            </strong>
          </div>
        </div>
      </header>

      <div class="game-sokoban-layout">
        <section class="game-sokoban-board-column" aria-label="推箱子游戏区">
          <div class="game-sokoban-board-heading">
            <div>
              <p class="eyebrow">Microban {levelNumber}</p>
              <h2>第 {levelNumber} 关</h2>
            </div>
            <span class={`game-sokoban-state-chip${game.won ? " is-won" : ""}`}>
              {game.won ? "已完成" : `${placedCrates} / ${game.targets.length} 归位`}
            </span>
          </div>

          <div class={`game-sokoban-board-shell${game.won ? " is-won" : ""}`}>
            <div
              ref={boardRef}
              class="game-sokoban-board"
              role="grid"
              aria-label={`推箱子棋盘，第 ${levelNumber} 关，${game.height} 行 ${game.width} 列`}
              aria-rowcount={game.height}
              aria-colcount={game.width}
              aria-describedby="game-sokoban-instructions"
              aria-busy={!progressIdentityReady}
              aria-disabled={!progressIdentityReady}
              data-level={levelNumber}
              data-progress-ready={progressIdentityReady ? "true" : "false"}
              tabIndex={0}
              style={`--sokoban-columns: ${game.width}; --sokoban-rows: ${game.height};`}
              onPointerDown={(event) => {
                if (game.won || !progressIdentityReady) return;
                pointerStart.current = {
                  pointerId: event.pointerId,
                  x: event.clientX,
                  y: event.clientY,
                };
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerUp={(event) => {
                const start = pointerStart.current;
                pointerStart.current = null;
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }
                if (start === null || start.pointerId !== event.pointerId) return;
                const direction = directionForSokobanSwipe(
                  start.x,
                  start.y,
                  event.clientX,
                  event.clientY,
                );
                if (direction !== null) move(direction);
              }}
              onPointerCancel={() => {
                pointerStart.current = null;
              }}
            >
              {Array.from({ length: game.height }, (_, y) => (
                <div
                  key={y}
                  class="game-sokoban-row"
                  role="row"
                  aria-rowindex={y + 1}
                >
                  {Array.from({ length: game.width }, (_, x) => {
                    const tile = tileAt(game, x, y, crateKeys, targetKeys);
                    return (
                      <div
                        key={x}
                        class={`game-sokoban-cell game-sokoban-cell-${tile}`}
                        role="gridcell"
                        aria-colindex={x + 1}
                        aria-label={tileLabel(tile, x, y)}
                        data-state={tile}
                      >
                        {(tile === "crate" || tile === "crate-on-target") && (
                          <span class="game-sokoban-crate-face" aria-hidden="true">
                            箱
                          </span>
                        )}
                        {(tile === "player" || tile === "player-on-target") && (
                          <span class="game-sokoban-player-figure" aria-hidden="true" />
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>

          <div class="game-sokoban-controls">
            <div class="game-sokoban-direction-pad" aria-label="移动方向">
              {DIRECTION_BUTTONS.map((button) => (
                <button
                  key={button.direction}
                  class={`game-sokoban-direction game-sokoban-direction-${button.className}`}
                  type="button"
                  aria-label={button.label}
                  disabled={game.won || !progressIdentityReady}
                  onClick={() => move(button.direction)}
                >
                  <span aria-hidden="true">{button.symbol}</span>
                </button>
              ))}
            </div>
            <div class="game-sokoban-action-buttons">
              <button
                class="secondary-button"
                type="button"
                disabled={undoStack.length === 0}
                onClick={undo}
              >
                撤销一步
              </button>
              <button class="primary-button" type="button" onClick={restart}>
                重新开始
              </button>
            </div>
          </div>

          <p id="game-sokoban-instructions" class="game-sokoban-instructions">
            电脑端使用方向键或 WASD；手机在棋盘上滑动，也可以点击方向按钮。
            按 U 或退格键撤销，按 R 重新开始当前关卡。
          </p>
        </section>

        <aside class="game-sokoban-sidebar">
          <section class="game-sokoban-level-panel" aria-label="关卡选择">
            <header>
              <div>
                <p class="eyebrow">首批关卡</p>
                <h2>选择关卡</h2>
              </div>
              <span aria-live="polite">
                {visibleCompletedLevelIds.size} / {SOKOBAN_LEVELS.length} 已完成
                {progressStatus === "loading"
                  ? " · 正在恢复记录"
                  : progressStatus === "saving"
                    ? " · 正在保存"
                    : progressStatus === "offline"
                      ? " · 暂未同步"
                      : ""}
              </span>
            </header>
            <div class="game-sokoban-level-grid">
              {SOKOBAN_LEVELS.map((level, index) => {
                const isCurrent = index === levelIndex;
                const isCompleted = visibleCompletedLevelIds.has(level.id);
                const bestMoves = bestMovesByLevel.get(level.id);
                return (
                  <button
                    key={level.id}
                    class={`${isCurrent ? "is-current" : ""}${isCompleted ? " is-completed" : ""}`}
                    type="button"
                    aria-label={`第 ${index + 1} 关`}
                    aria-current={isCurrent ? "step" : undefined}
                    onClick={() => selectLevel(index)}
                  >
                    <strong>{String(index + 1).padStart(2, "0")}</strong>
                    <span>
                      {isCompleted ? "已完成" : isCurrent ? "当前" : "未完成"}
                    </span>
                    {bestMoves !== undefined && (
                      <span>最佳 {bestMoves} 步</span>
                    )}
                  </button>
                );
              })}
            </div>
            <div class="game-sokoban-level-actions">
              <button
                class="secondary-button"
                type="button"
                disabled={levelIndex === 0}
                onClick={() => selectLevel(levelIndex - 1)}
              >
                上一关
              </button>
              <button
                class="primary-button"
                type="button"
                disabled={levelIndex === SOKOBAN_LEVELS.length - 1}
                onClick={() => selectLevel(levelIndex + 1)}
              >
                下一关
              </button>
            </div>
          </section>

          <section class="game-sokoban-guide" aria-label="玩法说明">
            <p class="eyebrow">图例与规则</p>
            <h2>慢一点，别堵死</h2>
            <div class="game-sokoban-legend">
              <span><i class="is-player" aria-hidden="true" />玩家</span>
              <span><i class="is-crate" aria-hidden="true" />箱子</span>
              <span><i class="is-target" aria-hidden="true" />目标点</span>
              <span><i class="is-wall" aria-hidden="true" />墙</span>
            </div>
            <ol>
              <li>走到箱子旁边，朝空地或目标点推动。</li>
              <li>箱子不能拉动，也不能推动两个相连的箱子。</li>
              <li>把本关所有箱子都推到目标点即可过关。</li>
            </ol>
          </section>

          <p class="game-sokoban-attribution">
            关卡设计：<strong>{SOKOBAN_LEVEL_SOURCE.author}</strong> · {" "}
            <a href={SOKOBAN_LEVEL_SOURCE.url} target="_blank" rel="noreferrer">
              Microban 1–20（2000）
            </a>
            ，依原作者许可署名转载。
          </p>
        </aside>
      </div>
    </main>
  );
}
