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
  const boardRef = useRef<HTMLDivElement>(null);
  const pointerStart = useRef<PointerStart | null>(null);

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
    setGame((current) => {
      const result = moveSokoban(current, direction);
      if (!result.moved) return current;
      setUndoStack((stack) => [...stack, current]);
      if (result.won) {
        setCompletedLevelIds((completed) => {
          if (completed.has(result.state.levelId)) return completed;
          return new Set([...completed, result.state.levelId]);
        });
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
            {game.won
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
              data-level={levelNumber}
              tabIndex={0}
              style={`--sokoban-columns: ${game.width}; --sokoban-rows: ${game.height};`}
              onPointerDown={(event) => {
                if (game.won) return;
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
                  disabled={game.won}
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
              <span>{completedLevelIds.size} / {SOKOBAN_LEVELS.length} 已完成</span>
            </header>
            <div class="game-sokoban-level-grid">
              {SOKOBAN_LEVELS.map((level, index) => {
                const isCurrent = index === levelIndex;
                const isCompleted = completedLevelIds.has(level.id);
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
                    <span>{isCompleted ? "已完成" : isCurrent ? "当前" : "未完成"}</span>
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
              Microban 1–10（2000）
            </a>
            ，依原作者许可署名转载。
          </p>
        </aside>
      </div>
    </main>
  );
}
