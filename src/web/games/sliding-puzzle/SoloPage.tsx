import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  createSlidingPuzzle,
  moveSlidingPuzzle,
  moveSlidingPuzzleDirection,
  type SlidingPuzzleDirection,
  type SlidingPuzzleState,
} from "../../../games/sliding-puzzle/engine";
import {
  readSlidingPuzzleBest,
  recordSlidingPuzzleBest,
  SLIDING_PUZZLE_DEFAULT_ID,
} from "./best-storage";
import { ProfileMenu } from "../../ProfileMenu";
import { ThemeToggle } from "../../theme";
import "./game.css";

const PUZZLE_IMAGE = {
  id: SLIDING_PUZZLE_DEFAULT_ID,
  src: "/images/sliding-puzzle-1.jpg",
  alt: "暗红色背景上的人物插画",
} as const;

interface ActivePuzzle {
  readonly id: string;
  readonly state: SlidingPuzzleState;
}

interface PointerStart {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
}

let puzzleSequence = 0;

const DIRECTIONS: ReadonlyArray<{
  readonly direction: SlidingPuzzleDirection;
  readonly label: string;
  readonly symbol: string;
  readonly className: string;
}> = [
  { direction: "up", label: "向上移动空位", symbol: "↑", className: "up" },
  { direction: "left", label: "向左移动空位", symbol: "←", className: "left" },
  { direction: "down", label: "向下移动空位", symbol: "↓", className: "down" },
  { direction: "right", label: "向右移动空位", symbol: "→", className: "right" },
];

function randomValue(): number {
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const values = new Uint32Array(1);
    crypto.getRandomValues(values);
    return (values[0] ?? 0) / 0x1_0000_0000;
  }
  return Math.random();
}

function newPuzzle(): ActivePuzzle {
  puzzleSequence += 1;
  return {
    id: `${Date.now().toString(36)}-${puzzleSequence}`,
    state: createSlidingPuzzle(randomValue),
  };
}

function directionForKey(key: string): SlidingPuzzleDirection | null {
  const directions: Readonly<Record<string, SlidingPuzzleDirection>> = {
    ArrowUp: "up",
    ArrowLeft: "left",
    ArrowDown: "down",
    ArrowRight: "right",
    w: "up",
    a: "left",
    s: "down",
    d: "right",
  };
  return directions[key] ?? directions[key.toLowerCase()] ?? null;
}

function directionForSwipe(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): SlidingPuzzleDirection | null {
  const deltaX = endX - startX;
  const deltaY = endY - startY;
  const distance = Math.max(Math.abs(deltaX), Math.abs(deltaY));
  if (distance < 28) return null;
  if (Math.abs(deltaX) > Math.abs(deltaY)) {
    // A swipe moves the empty space in the same visual direction.
    return deltaX > 0 ? "right" : "left";
  }
  return deltaY > 0 ? "down" : "up";
}

function tileLabel(tile: number, index: number, empty: boolean): string {
  const row = Math.floor(index / 3) + 1;
  const column = (index % 3) + 1;
  return empty
    ? `第 ${row} 行第 ${column} 列，空位`
    : `第 ${row} 行第 ${column} 列，图片第 ${tile + 1} 块`;
}

function statusMessage(game: SlidingPuzzleState): string {
  return game.status === "won"
    ? "拼图完成！这张图已经复原。"
    : game.moves === 0
      ? "点击相邻图片，或用方向键移动空位。"
      : "继续移动相邻图片，把整张图复原。";
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
  const [activePuzzle, setActivePuzzle] = useState<ActivePuzzle>(newPuzzle);
  const [bestMoves, setBestMoves] = useState<number | null>(() =>
    readSlidingPuzzleBest(PUZZLE_IMAGE.id)
  );
  const [completionNotice, setCompletionNotice] = useState<string | null>(null);
  const pointerStart = useRef<PointerStart | null>(null);
  const suppressNextClick = useRef(false);
  const boardRef = useRef<HTMLDivElement>(null);
  const recordedPuzzleId = useRef<string | null>(null);
  const game = activePuzzle.state;

  useEffect(() => {
    if (game.status !== "won" || recordedPuzzleId.current === activePuzzle.id) return;
    recordedPuzzleId.current = activePuzzle.id;
    const result = recordSlidingPuzzleBest(PUZZLE_IMAGE.id, game.moves);
    setBestMoves(result.best);
    setCompletionNotice(
      result.isNewBest
        ? `新的个人最佳：${result.best} 步`
        : `本局完成：${game.moves} 步 · 个人最佳：${result.best} 步`,
    );
  }, [activePuzzle.id, game.moves, game.status]);

  const moveTile = useCallback((tileIndex: number) => {
    setActivePuzzle((current) => {
      const result = moveSlidingPuzzle(current.state, tileIndex);
      return result.moved ? { ...current, state: result.state } : current;
    });
    window.setTimeout(() => boardRef.current?.focus(), 0);
  }, []);

  const moveDirection = useCallback((direction: SlidingPuzzleDirection) => {
    setActivePuzzle((current) => {
      const result = moveSlidingPuzzleDirection(current.state, direction);
      return result.moved ? { ...current, state: result.state } : current;
    });
    window.setTimeout(() => boardRef.current?.focus(), 0);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || /^(?:A|BUTTON|INPUT|SELECT|TEXTAREA)$/u.test(target.tagName))
      ) return;
      const direction = directionForKey(event.key);
      if (direction === null) return;
      event.preventDefault();
      moveDirection(direction);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [moveDirection]);

  const restart = useCallback(() => {
    pointerStart.current = null;
    suppressNextClick.current = false;
    setCompletionNotice(null);
    setActivePuzzle(newPuzzle());
    window.setTimeout(() => boardRef.current?.focus(), 0);
  }, []);

  return (
    <main class="game-sliding-puzzle-page">
      <nav class="game-sliding-puzzle-topbar">
        <a class="secondary-button game-sliding-puzzle-home-link" href="/">
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

      <header class="game-sliding-puzzle-header">
        <div>
          <p class="eyebrow">单人 · 本机游戏 · 九宫格</p>
          <h1>拼图</h1>
          <p class="game-sliding-puzzle-status" aria-live="polite">
            {statusMessage(game)}
          </p>
        </div>
        <div class="game-sliding-puzzle-stat-cards" aria-label="本局统计">
          <div class="game-sliding-puzzle-stat-card">
            <small>当前步数</small>
            <strong>{game.moves}</strong>
          </div>
          <div class="game-sliding-puzzle-stat-card">
            <small>个人最佳</small>
            <strong>{bestMoves === null ? "—" : `${bestMoves} 步`}</strong>
          </div>
          <div class="game-sliding-puzzle-stat-card">
            <small>棋盘</small>
            <strong>3×3</strong>
          </div>
        </div>
      </header>

      <div class="game-sliding-puzzle-layout">
        <section class="game-sliding-puzzle-board-column" aria-label="拼图游戏区">
          <div class={`game-sliding-puzzle-board-shell ${game.status === "won" ? "is-won" : ""}`}>
            <div
              ref={boardRef}
              class="game-sliding-puzzle-board"
              role="grid"
              tabIndex={0}
              aria-label="九宫格滑块拼图"
              aria-rowcount={3}
              aria-colcount={3}
              data-status={game.status}
              data-moves={game.moves}
              aria-describedby="game-sliding-puzzle-instructions"
              onPointerDown={(event) => {
                suppressNextClick.current = false;
                // Mouse clicks should reach the tile button directly. Only
                // capture touch pointers here so a tap is never swallowed by
                // the swipe recognizer.
                if (event.pointerType !== "touch") return;
                if (game.status === "won") return;
                pointerStart.current = {
                  pointerId: event.pointerId,
                  x: event.clientX,
                  y: event.clientY,
                };
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerUp={(event) => {
                if (event.pointerType !== "touch") return;
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
                if (direction !== null) {
                  suppressNextClick.current = true;
                  moveDirection(direction);
                }
              }}
              onPointerCancel={(event) => {
                if (event.pointerType !== "touch") return;
                pointerStart.current = null;
              }}
            >
              {game.board.map((tile, index) => {
                const empty = tile === 8;
                const row = Math.floor(tile / 3);
                const column = tile % 3;
                return (
                  <button
                    key={index}
                    class={`game-sliding-puzzle-tile ${empty ? "is-empty" : ""}`}
                    type="button"
                    role="gridcell"
                    aria-label={tileLabel(tile, index, empty)}
                    aria-rowindex={Math.floor(index / 3) + 1}
                    aria-colindex={(index % 3) + 1}
                    data-position={index}
                    data-tile={empty ? "empty" : tile}
                    disabled={empty || game.status === "won"}
                    onClick={() => {
                      if (suppressNextClick.current) {
                        suppressNextClick.current = false;
                        return;
                      }
                      moveTile(index);
                    }}
                  >
                    {empty ? (
                      <span class="game-sliding-puzzle-empty-mark" aria-hidden="true">·</span>
                    ) : (
                      <img
                        src={PUZZLE_IMAGE.src}
                        alt=""
                        draggable={false}
                        style={`left: ${-column * 100}%; top: ${-row * 100}%;`}
                      />
                    )}
                  </button>
                );
              })}
              {game.status === "won" && (
                <div class="game-sliding-puzzle-win-badge" role="status">
                  <span aria-hidden="true">✓</span>
                  <strong>完成</strong>
                  <small>{game.moves} 步</small>
                </div>
              )}
            </div>
          </div>

          <div class="game-sliding-puzzle-controls">
            <div class="game-sliding-puzzle-direction-pad" aria-label="移动空位">
              {DIRECTIONS.map((button) => (
                <button
                  key={button.direction}
                  class={`game-sliding-puzzle-direction game-sliding-puzzle-direction-${button.className}`}
                  type="button"
                  aria-label={button.label}
                  disabled={game.status === "won"}
                  onClick={() => moveDirection(button.direction)}
                >
                  <span aria-hidden="true">{button.symbol}</span>
                </button>
              ))}
            </div>
            <button class="primary-button game-sliding-puzzle-restart" type="button" onClick={restart}>
              重新开始
            </button>
          </div>

          <p id="game-sliding-puzzle-instructions" class="game-sliding-puzzle-instructions">
            点击与空位相邻的图片即可移动；电脑端也可以使用方向键或 WASD，手机端支持在棋盘上滑动。
          </p>
          {completionNotice !== null && (
            <p class="game-sliding-puzzle-record-notice" aria-live="polite">
              {completionNotice}
            </p>
          )}
        </section>

        <aside class="game-sliding-puzzle-sidebar">
          <section class="game-sliding-puzzle-info-card">
            <p class="eyebrow">当前图片</p>
            <div class="game-sliding-puzzle-thumbnail">
              <img src={PUZZLE_IMAGE.src} alt={PUZZLE_IMAGE.alt} />
            </div>
            <h2>图片拼图</h2>
            <p>把九块图片按原来的顺序排列，空位会帮助你逐步还原画面。</p>
          </section>
          <section class="game-sliding-puzzle-guide">
            <p class="eyebrow">玩法</p>
            <h2>步数越少越好</h2>
            <ol>
              <li>每次只能移动空位旁边的一块图片。</li>
              <li>完成后会自动保存你的个人最佳步数。</li>
              <li>记录保存在当前浏览器，不参与全局排名。</li>
            </ol>
          </section>
        </aside>
      </div>
    </main>
  );
}
