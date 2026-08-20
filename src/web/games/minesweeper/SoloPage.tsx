import { useEffect, useState } from "preact/hooks";
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

function newSoloGame(presetId: MinefieldPresetId): SoloGameState {
  return createSoloGame(MINEFIELD_PRESETS[presetId], crypto.randomUUID());
}

export function SoloPage() {
  const [presetId, setPresetId] = useState<MinefieldPresetId>("small");
  const [game, setGame] = useState<SoloGameState>(() => newSoloGame("small"));

  useEffect(() => {
    if (game.status !== "playing") return;
    let previous = performance.now();
    const timer = globalThis.setInterval(() => {
      const now = performance.now();
      const deltaMs = now - previous;
      previous = now;
      setGame((current) =>
        applySoloAction(current, { type: "advance_time", deltaMs }).state
      );
    }, 250);
    return () => globalThis.clearInterval(timer);
  }, [game.status]);

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
    setGame((current) =>
      applySoloAction(current, {
        type: "restart",
        config: MINEFIELD_PRESETS[nextPresetId],
        seed,
      }).state
    );
  };

  const handleBoardAction = (action: MinesweeperBoardAction) => {
    if (action.type === "select_start") return;
    setGame((current) => applySoloAction(current, action).state);
  };

  return (
    <main class="minesweeper-solo-page">
      <header class="minesweeper-solo-header">
        <div>
          <p class="eyebrow">单人 · 本机游戏</p>
          <h1>扫雷</h1>
          <p class="minesweeper-solo-status" aria-live="polite">
            {STATUS_LABELS[game.status]}
          </p>
        </div>
        <a class="secondary-button minesweeper-home-link" href="/">
          返回首页
        </a>
      </header>

      <section class="minesweeper-solo-controls" aria-label="单人扫雷控制">
        <label>
          难度
          <select
            value={presetId}
            onChange={(event) => {
              const nextPresetId = event.currentTarget.value as MinefieldPresetId;
              setPresetId(nextPresetId);
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
        <button
          class="secondary-button"
          type="button"
          disabled={game.status === "ready" || game.status === "won" || game.status === "lost"}
          onClick={() => {
            setGame((current) =>
              applySoloAction(current, {
                type: current.status === "paused" ? "resume" : "pause",
              }).state
            );
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
    </main>
  );
}
