import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  createGame2048,
  GAME_2048_BOARD_SIZE,
  moveGame2048,
  type Game2048Direction,
  type Game2048State,
} from "../../../games/2048/engine";
import { ProfileMenu } from "../../ProfileMenu";
import { ThemeToggle } from "../../theme";
import { directionForKey, directionForSwipe } from "./interactions";
import {
  loadGame2048Leaderboard,
  type Game2048LeaderboardSnapshot,
  recordGame2048Score,
} from "./leaderboard-client";
import "./game.css";

interface ActiveGame2048 {
  readonly id: string;
  readonly state: Game2048State;
}

interface PointerStart {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
}

interface FailedGame2048Submission {
  readonly id: string;
  readonly score: number;
}

export function higherGame2048PersonalBest(
  current: number | null,
  incoming: number | null,
): number | null {
  if (current === null) return incoming;
  if (incoming === null) return current;
  return Math.max(current, incoming);
}

export function preferHigherGame2048Snapshot(
  current: Game2048LeaderboardSnapshot | null,
  incoming: Game2048LeaderboardSnapshot,
): Game2048LeaderboardSnapshot {
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

const DIRECTION_BUTTONS: ReadonlyArray<{
  direction: Game2048Direction;
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

function newActiveGame2048(): ActiveGame2048 {
  return {
    id: crypto.randomUUID(),
    state: createGame2048(secureRandom),
  };
}

export function formatGame2048Score(score: number): string {
  return new Intl.NumberFormat("zh-CN").format(Math.max(0, score));
}

export function isNewGame2048PersonalBest(
  previousBestScore: number | null,
  completedScore: number,
  confirmedBestScore: number | null,
  previousBestKnown: boolean,
): boolean {
  return previousBestKnown &&
    confirmedBestScore === completedScore &&
    (previousBestScore === null || completedScore > previousBestScore);
}

function statusMessage(game: Game2048State): string {
  if (game.status === "over") return "没有可移动的方块，本局结束";
  if (game.reached2048) return "已合成 2048，继续冲击更高分！";
  if (game.score === 0) return "使用方向键、WASD 或滑动开始";
  return "继续合并相同数字，向 2048 前进";
}

function tileLabel(value: number, index: number): string {
  const row = Math.floor(index / GAME_2048_BOARD_SIZE) + 1;
  const column = index % GAME_2048_BOARD_SIZE + 1;
  return value === 0
    ? `第 ${row} 行第 ${column} 列，空格`
    : `第 ${row} 行第 ${column} 列，数字 ${value}`;
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
  const [activeGame, setActiveGame] = useState(newActiveGame2048);
  const [leaderboard, setLeaderboard] =
    useState<Game2048LeaderboardSnapshot | null>(null);
  const [leaderboardStatus, setLeaderboardStatus] =
    useState<"loading" | "ready" | "offline">("loading");
  const [recordNotice, setRecordNotice] = useState<string | null>(null);
  const [failedSubmission, setFailedSubmission] =
    useState<FailedGame2048Submission | null>(null);
  const leaderboardRequest = useRef(0);
  const submissionAttempt = useRef(0);
  const visibleSubmissionAttempt = useRef<number | null>(null);
  const confirmedBestKnown = useRef(false);
  const confirmedBestScore = useRef<number | null>(null);
  const submittedGames = useRef(new Set<string>());
  const submittingGames = useRef(new Set<string>());
  const pointerStart = useRef<PointerStart | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const requestId = ++leaderboardRequest.current;
    setLeaderboardStatus("loading");
    void loadGame2048Leaderboard(displayName, controller.signal).then(
      (snapshot) => {
        if (leaderboardRequest.current !== requestId) return;
        const effectiveBest = higherGame2048PersonalBest(
          confirmedBestScore.current,
          snapshot.personalBestScore,
        );
        confirmedBestKnown.current = true;
        confirmedBestScore.current = effectiveBest;
        setLeaderboard((current) =>
          preferHigherGame2048Snapshot(current, snapshot)
        );
        setLeaderboardStatus("ready");
      },
      () => {
        if (controller.signal.aborted || leaderboardRequest.current !== requestId) {
          return;
        }
        setLeaderboardStatus("offline");
      },
    );
    return () => controller.abort();
  }, [displayName]);

  const submitScore = useCallback((gameId: string, score: number) => {
    if (
      submittedGames.current.has(gameId) ||
      submittingGames.current.has(gameId)
    ) {
      return;
    }
    submittedGames.current.add(gameId);
    submittingGames.current.add(gameId);
    const attemptId = ++submissionAttempt.current;
    visibleSubmissionAttempt.current = attemptId;
    const previousBestKnown = confirmedBestKnown.current;
    const previousBest = confirmedBestScore.current;
    setFailedSubmission((current) => current?.id === gameId ? null : current);
    setRecordNotice("正在保存分数…");
    void recordGame2048Score(displayName, score).then(
      (snapshot) => {
        submittingGames.current.delete(gameId);
        if (!mounted.current) return;
        // A completed write is authoritative for this score. Invalidate any
        // older read and never let an out-of-order lower snapshot roll the
        // confirmed personal best back.
        leaderboardRequest.current += 1;
        const effectiveBest = higherGame2048PersonalBest(
          confirmedBestScore.current,
          snapshot.personalBestScore,
        );
        confirmedBestKnown.current = true;
        confirmedBestScore.current = effectiveBest;
        setFailedSubmission((current) =>
          current !== null &&
            current.score <= (effectiveBest ?? 0)
            ? null
            : current
        );
        setLeaderboard((current) =>
          preferHigherGame2048Snapshot(current, snapshot)
        );
        setLeaderboardStatus("ready");
        if (visibleSubmissionAttempt.current === attemptId) {
          setRecordNotice(
            isNewGame2048PersonalBest(
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
        submittingGames.current.delete(gameId);
        if (!mounted.current) return;
        setFailedSubmission((current) => {
          if (
            confirmedBestScore.current !== null &&
            confirmedBestScore.current >= score
          ) {
            return current;
          }
          // The server stores only max(score), so the highest unsynced valid
          // score subsumes every lower failed attempt.
          return current === null || score > current.score
            ? { id: gameId, score }
            : current;
        });
        if (visibleSubmissionAttempt.current === attemptId) {
          setRecordNotice("分数暂未同步，可重试");
        }
      },
    );
  }, [displayName]);

  useEffect(() => {
    const game = activeGame.state;
    if (game.status === "over" && game.score > 0) {
      submitScore(activeGame.id, game.score);
    }
  }, [activeGame, submitScore]);

  const move = useCallback((direction: Game2048Direction) => {
    setActiveGame((current) => {
      const result = moveGame2048(current.state, direction, secureRandom);
      if (result.moved) {
        visibleSubmissionAttempt.current = null;
        setRecordNotice(null);
      }
      return result.state === current.state
        ? current
        : { ...current, state: result.state };
    });
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
      const direction = directionForKey(event.key);
      if (direction === null) return;
      event.preventDefault();
      move(direction);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [move]);

  const restart = () => {
    pointerStart.current = null;
    visibleSubmissionAttempt.current = null;
    setActiveGame(newActiveGame2048());
    setRecordNotice(null);
  };

  const game = activeGame.state;
  const highestTile = Math.max(...game.board);

  return (
    <main class="game-2048-page">
      <nav class="game-2048-topbar">
        <a class="secondary-button game-2048-home-link" href="/">
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

      <header class="game-2048-header">
        <div>
          <p class="eyebrow">单人 · 本机游戏 · 固定 4×4</p>
          <h1>2048</h1>
          <p class="game-2048-status" aria-live="polite">
            {statusMessage(game)}
          </p>
        </div>
        <div class="game-2048-score-cards" aria-label="本局统计">
          <div class="game-2048-score-card">
            <small>当前分数</small>
            <strong>{formatGame2048Score(game.score)}</strong>
          </div>
          <div class="game-2048-score-card">
            <small>最大数字</small>
            <strong>{formatGame2048Score(highestTile)}</strong>
          </div>
          <div class="game-2048-score-card">
            <small>个人最高</small>
            <strong>
              {leaderboard?.personalBestScore === null || leaderboard === null
                ? "—"
                : formatGame2048Score(leaderboard.personalBestScore)}
            </strong>
          </div>
        </div>
      </header>

      <div class="game-2048-layout">
        <section class="game-2048-board-column" aria-label="2048 游戏区">
          <div
            class={`game-2048-board ${game.status === "over" ? "is-over" : ""}`}
            role="grid"
            aria-label="2048 棋盘，4 行 4 列"
            aria-rowcount={GAME_2048_BOARD_SIZE}
            aria-colcount={GAME_2048_BOARD_SIZE}
            aria-describedby="game-2048-instructions"
            tabIndex={0}
            onPointerDown={(event) => {
              if (game.status === "over") return;
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
            {Array.from({ length: GAME_2048_BOARD_SIZE }, (_, row) => (
              <div
                key={row}
                class="game-2048-row"
                role="row"
                aria-rowindex={row + 1}
              >
                {game.board.slice(
                  row * GAME_2048_BOARD_SIZE,
                  (row + 1) * GAME_2048_BOARD_SIZE,
                ).map((value, column) => {
                  const index = row * GAME_2048_BOARD_SIZE + column;
                  return (
                    <div
                      key={index}
                      class="game-2048-cell"
                      role="gridcell"
                      aria-colindex={column + 1}
                      aria-label={tileLabel(value, index)}
                      data-value={value === 0 ? "empty" : value}
                      data-digits={String(value).length}
                    >
                      {value === 0 ? null : value}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          <div class="game-2048-actions">
            <div class="game-2048-direction-pad" aria-label="移动方向">
              {DIRECTION_BUTTONS.map((button) => (
                <button
                  key={button.direction}
                  class={`game-2048-direction game-2048-direction-${button.className}`}
                  type="button"
                  aria-label={button.label}
                  disabled={game.status === "over"}
                  onClick={() => move(button.direction)}
                >
                  <span aria-hidden="true">{button.symbol}</span>
                </button>
              ))}
            </div>
            <button class="primary-button" type="button" onClick={restart}>
              重新开始
            </button>
          </div>

          <p id="game-2048-instructions" class="game-2048-instructions">
            电脑端使用方向键或 WASD；手机在棋盘上滑动，也可以点击方向按钮。
            相同数字每次移动只合并一次。
          </p>
          {recordNotice && (
            <p class="game-2048-record-notice" aria-live="polite">
              {recordNotice}
            </p>
          )}
          {failedSubmission && (
            <button
              class="secondary-button game-2048-record-retry"
              type="button"
              onClick={() => {
                if (submittingGames.current.has(failedSubmission.id)) return;
                submittedGames.current.delete(failedSubmission.id);
                submitScore(failedSubmission.id, failedSubmission.score);
              }}
            >
              重试保存 {formatGame2048Score(failedSubmission.score)} 分
            </button>
          )}
        </section>

        <section class="game-2048-leaderboard" aria-label="2048 排行榜">
          <header>
            <div>
              <p class="eyebrow">休闲榜 · 4×4</p>
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
                  <span class="game-2048-leaderboard-rank">{entry.rank}</span>
                  <strong>{entry.displayName}</strong>
                  <data value={entry.score}>{formatGame2048Score(entry.score)}</data>
                </li>
              ))}
            </ol>
          ) : (
            <p class="game-2048-leaderboard-empty">
              {leaderboardStatus === "ready" ? "还没有完成纪录" : "—"}
            </p>
          )}
          <p class="game-2048-leaderboard-note">
            棋盘无法继续移动时自动记录本局分数；每位玩家仅保留个人最高分。
          </p>
        </section>
      </div>
    </main>
  );
}
