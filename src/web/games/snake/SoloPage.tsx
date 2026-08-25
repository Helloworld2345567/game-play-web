import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  createGameSnake,
  pauseGameSnake,
  queueGameSnakeDirection,
  resumeGameSnake,
  startGameSnake,
  tickGameSnake,
  type GameSnakeDirection,
  type GameSnakeState,
} from "../../../games/snake/engine";
import {
  SNAKE_BOARD_SIZE,
  SNAKE_MAX_SCORE,
} from "../../../shared/game-snake-rules";
import { ProfileMenu } from "../../ProfileMenu";
import { ThemeToggle } from "../../theme";
import { directionForKey, directionForSwipe } from "./interactions";
import {
  loadGameSnakeLeaderboard,
  type SnakeLeaderboardSnapshot,
  recordGameSnakeScore,
} from "./leaderboard-client";
import "./game.css";

interface ActiveGameSnake {
  readonly id: string;
  readonly state: GameSnakeState;
}

interface PointerStart {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
}

interface FailedGameSnakeSubmission {
  readonly id: string;
  readonly score: number;
}

interface GameSnakeSubmissionRequest {
  readonly controller: AbortController;
  readonly timeoutId: number;
}

export function higherGameSnakePersonalBest(
  current: number | null,
  incoming: number | null,
): number | null {
  if (current === null) return incoming;
  if (incoming === null) return current;
  return Math.max(current, incoming);
}

export function preferHigherGameSnakeSnapshot(
  current: SnakeLeaderboardSnapshot | null,
  incoming: SnakeLeaderboardSnapshot,
): SnakeLeaderboardSnapshot {
  if (current !== null && current.ruleVersion !== incoming.ruleVersion) {
    return incoming;
  }
  const incomingBest = incoming.personalBestScore;
  if (
    current !== null &&
    current.personalBestScore !== null &&
    (incomingBest === null || incomingBest < current.personalBestScore)
  ) {
    return current;
  }
  return incoming;
}

/**
 * A score response confirms the personal best, but its Top 10 may have been
 * projected before another in-flight write. Keep the visible ranking until a
 * fresh read after the write supplies an authoritative list.
 */
export function applyGameSnakeRecordSnapshot(
  current: SnakeLeaderboardSnapshot | null,
  incoming: SnakeLeaderboardSnapshot,
): SnakeLeaderboardSnapshot {
  if (current === null || current.ruleVersion !== incoming.ruleVersion) {
    return incoming;
  }
  return withSnakePersonalBest(
    current,
    higherGameSnakePersonalBest(
      current.personalBestScore,
      incoming.personalBestScore,
    ),
  );
}

export function isNewGameSnakePersonalBest(
  previousBestScore: number | null,
  completedScore: number,
  confirmedBestScore: number | null,
  previousBestKnown: boolean,
): boolean {
  return previousBestKnown &&
    confirmedBestScore === completedScore &&
    (previousBestScore === null || completedScore > previousBestScore);
}

export function formatGameSnakeScore(score: number): string {
  return new Intl.NumberFormat("zh-CN").format(Math.max(0, score));
}

/** Milliseconds between cell advances; each food slightly speeds the game. */
export function snakeTickIntervalMs(score: number): number {
  return Math.max(70, 180 - Math.max(0, Math.floor(score)) * 4);
}

const SCORE_SUBMISSION_TIMEOUT_MS = 10_000;

const DIRECTION_BUTTONS: ReadonlyArray<{
  direction: GameSnakeDirection;
  label: string;
  symbol: string;
  className: string;
}> = [
  { direction: "up", label: "向上移动", symbol: "↑", className: "up" },
  { direction: "left", label: "向左移动", symbol: "←", className: "left" },
  { direction: "down", label: "向下移动", symbol: "↓", className: "down" },
  { direction: "right", label: "向右移动", symbol: "→", className: "right" },
];

function secureRandom(): number {
  const value = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  return value / 0x1_0000_0000;
}

function newActiveGameSnake(): ActiveGameSnake {
  return {
    id: crypto.randomUUID(),
    state: createGameSnake(secureRandom),
  };
}

function pointKey(x: number, y: number): string {
  return `${x},${y}`;
}

function snakeCellLabel(
  x: number,
  y: number,
  game: GameSnakeState,
  snakeIndex: number | undefined,
): string {
  const cell = `第 ${y + 1} 行第 ${x + 1} 列`;
  if (game.food?.x === x && game.food.y === y) return `${cell}，食物`;
  if (snakeIndex === 0) return `${cell}，蛇头`;
  if (snakeIndex !== undefined) return `${cell}，蛇身`;
  return `${cell}，空格`;
}

function statusMessage(game: GameSnakeState): string {
  if (game.status === "ready") return "按方向键、WASD 或滑动开始";
  if (game.status === "playing") return "吃到食物会得分并逐渐加速";
  if (game.status === "paused") return "已暂停，按空格或继续按钮恢复";
  if (game.status === "won") return "棋盘已填满，你赢了！";
  return "撞到墙或自己，本局结束";
}

function withSnakePersonalBest(
  snapshot: SnakeLeaderboardSnapshot,
  personalBestScore: number | null,
): SnakeLeaderboardSnapshot {
  return snapshot.personalBestScore === personalBestScore
    ? snapshot
    : { ...snapshot, personalBestScore };
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
  const [activeGame, setActiveGame] = useState<ActiveGameSnake>(
    newActiveGameSnake,
  );
  const game = activeGame.state;
  const [leaderboard, setLeaderboard] =
    useState<SnakeLeaderboardSnapshot | null>(null);
  const [leaderboardStatus, setLeaderboardStatus] =
    useState<"loading" | "ready" | "offline">("loading");
  const [recordNotice, setRecordNotice] = useState<string | null>(null);
  const [failedSubmission, setFailedSubmission] =
    useState<FailedGameSnakeSubmission | null>(null);
  const leaderboardRequest = useRef(0);
  const currentDisplayName = useRef(displayName);
  const submissionAttempt = useRef(0);
  const visibleSubmissionAttempt = useRef<number | null>(null);
  const confirmedBestScore = useRef<number | null>(null);
  const confirmedBestKnown = useRef(false);
  const submittedGames = useRef(new Set<string>());
  const submittingGames = useRef(new Set<string>());
  const submissionRequests = useRef(
    new Map<string, GameSnakeSubmissionRequest>(),
  );
  const pointerStart = useRef<PointerStart | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  currentDisplayName.current = displayName;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const request of submissionRequests.current.values()) {
        window.clearTimeout(request.timeoutId);
        request.controller.abort();
      }
      submissionRequests.current.clear();
    };
  }, []);

  const acceptLeaderboardSnapshot = useCallback(
    (snapshot: SnakeLeaderboardSnapshot) => {
      const effectiveBest = higherGameSnakePersonalBest(
        confirmedBestScore.current,
        snapshot.personalBestScore,
      );
      confirmedBestScore.current = effectiveBest;
      confirmedBestKnown.current = true;
      const effectiveSnapshot = withSnakePersonalBest(snapshot, effectiveBest);
      setLeaderboard((current) =>
        preferHigherGameSnakeSnapshot(current, effectiveSnapshot)
      );
      setLeaderboardStatus("ready");
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    const requestId = ++leaderboardRequest.current;
    setLeaderboard(null);
    setLeaderboardStatus("loading");
    void loadGameSnakeLeaderboard(displayName, controller.signal).then(
      (snapshot) => {
        if (
          !mounted.current ||
          controller.signal.aborted ||
          leaderboardRequest.current !== requestId
        ) return;
        acceptLeaderboardSnapshot(snapshot);
      },
      () => {
        if (controller.signal.aborted || leaderboardRequest.current !== requestId) {
          return;
        }
        setLeaderboardStatus("offline");
      },
    );
    return () => controller.abort();
  }, [acceptLeaderboardSnapshot, displayName]);

  const refreshLeaderboardAfterRecord = useCallback(() => {
    const requestId = ++leaderboardRequest.current;
    void loadGameSnakeLeaderboard(currentDisplayName.current).then(
      (snapshot) => {
        if (!mounted.current || leaderboardRequest.current !== requestId) return;
        acceptLeaderboardSnapshot(snapshot);
      },
      () => {
        // The write response still confirms the personal best. Keep that
        // useful state visible and let the next page load or write refresh Top 10.
      },
    );
  }, [acceptLeaderboardSnapshot]);

  const submitScore = useCallback((gameId: string, score: number) => {
    if (
      score < 1 ||
      score > SNAKE_MAX_SCORE ||
      submittedGames.current.has(gameId) ||
      submittingGames.current.has(gameId)
    ) {
      return;
    }
    submittedGames.current.add(gameId);
    submittingGames.current.add(gameId);
    const attemptId = ++submissionAttempt.current;
    visibleSubmissionAttempt.current = attemptId;
    const previousBest = confirmedBestScore.current;
    const previousBestKnown = confirmedBestKnown.current;
    const controller = new AbortController();
    const timeoutId = window.setTimeout(
      () => controller.abort(),
      SCORE_SUBMISSION_TIMEOUT_MS,
    );
    submissionRequests.current.set(gameId, { controller, timeoutId });
    const finishRequest = () => {
      const request = submissionRequests.current.get(gameId);
      if (request?.controller !== controller) return;
      window.clearTimeout(request.timeoutId);
      submissionRequests.current.delete(gameId);
    };
    setFailedSubmission((current) => current?.id === gameId ? null : current);
    setRecordNotice("正在保存分数…");
    void recordGameSnakeScore(displayName, score, controller.signal).then(
      (snapshot) => {
        finishRequest();
        submittingGames.current.delete(gameId);
        if (!mounted.current) return;
        const effectiveBest = higherGameSnakePersonalBest(
          confirmedBestScore.current,
          snapshot.personalBestScore,
        );
        confirmedBestScore.current = effectiveBest;
        confirmedBestKnown.current = true;
        setFailedSubmission((current) =>
          current !== null && current.score <= (effectiveBest ?? 0)
            ? null
            : current
        );
        const effectiveSnapshot = withSnakePersonalBest(snapshot, effectiveBest);
        setLeaderboard((current) =>
          applyGameSnakeRecordSnapshot(current, effectiveSnapshot)
        );
        setLeaderboardStatus("ready");
        refreshLeaderboardAfterRecord();
        if (visibleSubmissionAttempt.current === attemptId) {
          setRecordNotice(
            isNewGameSnakePersonalBest(
              previousBest,
              score,
              effectiveBest,
              previousBestKnown,
            )
              ? "新的个人最高分！"
              : "分数已记录",
          );
        }
      },
      () => {
        finishRequest();
        submittingGames.current.delete(gameId);
        submittedGames.current.delete(gameId);
        if (!mounted.current) return;
        if (
          confirmedBestScore.current === null ||
          confirmedBestScore.current < score
        ) {
          setFailedSubmission((current) =>
            current === null || score > current.score
              ? { id: gameId, score }
              : current
          );
        }
        if (visibleSubmissionAttempt.current === attemptId) {
          setRecordNotice("分数暂未同步，可重试");
        }
      },
    );
  }, [displayName, refreshLeaderboardAfterRecord]);

  useEffect(() => {
    if (
      (game.status === "over" || game.status === "won") &&
      game.score > 0
    ) {
      submitScore(activeGame.id, game.score);
    }
  }, [activeGame.id, game.score, game.status, submitScore]);

  useEffect(() => {
    if (game.status !== "playing") return;
    const timer = window.setInterval(() => {
      setActiveGame((current) => ({
        ...current,
        state: tickGameSnake(current.state, secureRandom),
      }));
    }, snakeTickIntervalMs(game.score));
    return () => window.clearInterval(timer);
  }, [game.score, game.status]);

  const pauseForBackground = useCallback(() => {
    setActiveGame((current) => ({
      ...current,
      state: pauseGameSnake(current.state),
    }));
  }, []);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") pauseForBackground();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("blur", pauseForBackground);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("blur", pauseForBackground);
    };
  }, [pauseForBackground]);

  const move = useCallback((direction: GameSnakeDirection) => {
    setActiveGame((current) => {
      if (current.state.status === "over" || current.state.status === "won") {
        return current;
      }
      let nextState = queueGameSnakeDirection(current.state, direction);
      if (nextState.status === "ready") {
        if (
          nextState === current.state &&
          direction !== current.state.direction
        ) {
          return current;
        }
        nextState = startGameSnake(nextState);
      }
      return nextState === current.state
        ? current
        : { ...current, state: nextState };
    });
    visibleSubmissionAttempt.current = null;
    setRecordNotice(null);
    window.setTimeout(() => boardRef.current?.focus(), 0);
  }, []);

  const togglePause = useCallback(() => {
    setActiveGame((current) => {
      if (current.state.status === "playing") {
        return { ...current, state: pauseGameSnake(current.state) };
      }
      if (current.state.status === "paused") {
        return { ...current, state: resumeGameSnake(current.state) };
      }
      if (current.state.status === "ready") {
        return { ...current, state: startGameSnake(current.state) };
      }
      return current;
    });
    window.setTimeout(() => boardRef.current?.focus(), 0);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          /^(?:A|BUTTON|INPUT|SELECT|TEXTAREA)$/u.test(target.tagName))
      ) {
        return;
      }
      if (event.key === " " || event.key === "Spacebar") {
        event.preventDefault();
        togglePause();
        return;
      }
      const direction = directionForKey(event.key);
      if (direction === null) return;
      event.preventDefault();
      move(direction);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [move, togglePause]);

  const restart = () => {
    pointerStart.current = null;
    visibleSubmissionAttempt.current = null;
    setActiveGame(newActiveGameSnake());
    setRecordNotice(null);
    window.setTimeout(() => boardRef.current?.focus(), 0);
  };

  const snakePositions = new Map(
    game.snake.map((point, index) => [pointKey(point.x, point.y), index] as const),
  );

  return (
    <main class="game-snake-page">
      <nav class="game-snake-topbar">
        <a class="secondary-button game-snake-home-link" href="/">
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

      <header class="game-snake-header">
        <div>
          <p class="eyebrow">单人 · 本机游戏 · 20×20</p>
          <h1>贪吃蛇</h1>
          <p class="game-snake-status" aria-live="polite">
            {statusMessage(game)}
          </p>
        </div>
        <div class="game-snake-score-cards" aria-label="本局统计">
          <div class="game-snake-score-card">
            <small>当前分数</small>
            <strong>{formatGameSnakeScore(game.score)}</strong>
          </div>
          <div class="game-snake-score-card">
            <small>蛇身长度</small>
            <strong>{game.snake.length}</strong>
          </div>
          <div class="game-snake-score-card">
            <small>个人最高</small>
            <strong>
              {leaderboard?.personalBestScore === null || leaderboard === null
                ? "—"
                : formatGameSnakeScore(leaderboard.personalBestScore)}
            </strong>
          </div>
        </div>
      </header>

      <div class="game-snake-layout">
        <section class="game-snake-board-column" aria-label="贪吃蛇游戏区">
          <div
            ref={boardRef}
            class={`game-snake-board game-snake-status-${game.status}`}
            role="grid"
            aria-label="贪吃蛇棋盘，20 行 20 列"
            aria-rowcount={SNAKE_BOARD_SIZE}
            aria-colcount={SNAKE_BOARD_SIZE}
            data-direction={game.direction}
            aria-describedby="game-snake-instructions"
            tabIndex={0}
            onPointerDown={(event) => {
              if (game.status === "over" || game.status === "won") return;
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
              const direction = directionForSwipe(
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
            {Array.from({ length: SNAKE_BOARD_SIZE }, (_, y) => (
              <div
                key={y}
                class="game-snake-row"
                role="row"
                aria-rowindex={y + 1}
              >
                {Array.from({ length: SNAKE_BOARD_SIZE }, (_, x) => {
                  const index = snakePositions.get(pointKey(x, y));
                  const isFood = game.food?.x === x && game.food.y === y;
                  const cellState = isFood
                    ? "food"
                    : index === 0
                      ? "head"
                      : index === undefined
                        ? "empty"
                        : "body";
                  return (
                    <div
                      key={x}
                      class={`game-snake-cell game-snake-cell-${cellState}`}
                      role="gridcell"
                      aria-colindex={x + 1}
                      aria-label={snakeCellLabel(x, y, game, index)}
                      data-state={cellState}
                    />
                  );
                })}
              </div>
            ))}
          </div>

          <div class="game-snake-actions">
            <div class="game-snake-direction-pad" aria-label="移动方向">
              {DIRECTION_BUTTONS.map((button) => (
                <button
                  key={button.direction}
                  class={`game-snake-direction game-snake-direction-${button.className}`}
                  type="button"
                  aria-label={button.label}
                  disabled={game.status === "over" || game.status === "won"}
                  onClick={() => move(button.direction)}
                >
                  <span aria-hidden="true">{button.symbol}</span>
                </button>
              ))}
            </div>
            <div class="game-snake-action-buttons">
              <button
                class="secondary-button"
                type="button"
                disabled={
                  game.status === "over" ||
                  game.status === "won"
                }
                onClick={togglePause}
              >
                {game.status === "ready"
                  ? "开始"
                  : game.status === "paused"
                    ? "继续"
                    : "暂停"}
              </button>
              <button class="primary-button" type="button" onClick={restart}>
                重新开始
              </button>
            </div>
          </div>

          <p id="game-snake-instructions" class="game-snake-instructions">
            电脑端使用方向键或 WASD；手机在棋盘上滑动，也可以点击方向按钮。
            空格键可开始、暂停和继续，撞墙或撞到自己会结束本局。
          </p>
          {recordNotice && (
            <p class="game-snake-record-notice" aria-live="polite">
              {recordNotice}
            </p>
          )}
          {failedSubmission && (
            <button
              class="secondary-button game-snake-record-retry"
              type="button"
              onClick={() => {
                if (submittingGames.current.has(failedSubmission.id)) return;
                submitScore(failedSubmission.id, failedSubmission.score);
              }}
            >
              重试保存 {formatGameSnakeScore(failedSubmission.score)} 分
            </button>
          )}
        </section>

        <section class="game-snake-leaderboard" aria-label="贪吃蛇排行榜">
          <header>
            <div>
              <p class="eyebrow">休闲榜 · 20×20</p>
              <h2>最高分 · 前 10</h2>
            </div>
            <span>
              {leaderboardStatus === "loading"
                ? "正在加载…"
                : leaderboardStatus === "offline"
                  ? "暂时无法连接排行榜"
                  : "按分数从高到低"}
            </span>
          </header>
          {leaderboard !== null && leaderboard.top.length > 0 ? (
            <ol>
              {leaderboard.top.map((entry) => (
                <li key={`${entry.rank}-${entry.displayName}-${entry.score}`}>
                  <span class="game-snake-leaderboard-rank">{entry.rank}</span>
                  <strong>{entry.displayName}</strong>
                  <data value={entry.score}>{formatGameSnakeScore(entry.score)}</data>
                </li>
              ))}
            </ol>
          ) : (
            <p class="game-snake-leaderboard-empty">
              {leaderboardStatus === "ready" ? "还没有完成纪录" : "—"}
            </p>
          )}
          <p class="game-snake-leaderboard-note">
            至少吃到一个食物后，本局结束时自动记录分数；每个规则版本独立保留个人最高分。
          </p>
        </section>
      </div>
    </main>
  );
}
