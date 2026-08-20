import { useEffect, useState } from "preact/hooks";
import type { RuleOutcome } from "../../../core/game-rules";
import {
  readPublicRacePosition,
  type PublicMinesweeperRaceData,
} from "../../../games/minesweeper/race-rules";
import { getMinesweeperRuleSetId } from "../../../games/minesweeper/presets";
import type {
  PublicMinefieldCell,
  PublicMinefieldView,
} from "../../../games/minesweeper/public-view";
import type { GameAdapter, GameRendererProps } from "../registry";
import { MinesweeperBoard } from "./Board";

const EMPTY_PENDING_CELLS: ReadonlySet<string> = new Set<string>();
const RACE_SEATS = ["seat-a", "seat-b"] as const;

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  "minesweeper.game_finished": "本局已经结束。",
  "minesweeper.not_a_player": "观众不能操作棋盘。",
  "minesweeper.already_ready": "本局已经准备完成。",
  "minesweeper.countdown_active": "倒计时结束后再开始排雷。",
  "minesweeper.not_playing": "双方准备后才能开始排雷。",
  "minesweeper.out_of_bounds": "目标格超出雷区。",
  "minesweeper.flagged": "请先取消旗帜再揭开。",
  "minesweeper.invalid_action": "无法识别这次扫雷操作。",
};

export function toPublicRaceMinefieldView(
  data: PublicMinesweeperRaceData,
): PublicMinefieldView {
  const cellCount = data.config.width * data.config.height;
  const revealed = new Map(data.revealed.map((cell) => [cell.index, cell]));
  const flags = new Set(data.flags);
  const mines = new Set(data.mines ?? []);
  const cells = Array.from(
    { length: cellCount },
    (_, index): PublicMinefieldCell => {
      if (mines.has(index)) return { state: "mine", flagged: false };
      const cell = revealed.get(index);
      if (cell !== undefined) {
        return {
          state: "revealed",
          flagged: false,
          adjacentMines: cell.adjacentMines,
        };
      }
      return { state: "hidden", flagged: flags.has(index) };
    },
  );
  return { ...data.config, cells };
}

function countdownSeconds(data: PublicMinesweeperRaceData, now: number): number {
  if (data.countdownEndsAt === null) return 0;
  return Math.max(0, Math.ceil((data.countdownEndsAt - now) / 1_000));
}

export function minesweeperRaceToolbarMessage(
  data: PublicMinesweeperRaceData,
  outcome: RuleOutcome | null,
  selfSeat: string | null,
  now: number,
): string {
  if (outcome !== null) return "本局已结束";
  const remaining = countdownSeconds(data, now);
  const isPlayer = selfSeat !== null && selfSeat in data.ready;
  const ownReady = isPlayer ? data.ready[selfSeat] === true : false;
  if (data.phase === "waiting_ready") {
    return ownReady ? "已准备，等待对手" : "双方准备后同时开始";
  }
  if (data.phase === "countdown" && remaining > 0) {
    return `${remaining} 秒后开始`;
  }
  if (data.phase === "countdown" || data.phase === "playing") {
    return isPlayer ? "尽快排完你的棋盘" : "双方正在独立竞速";
  }
  return "本局已结束";
}

function progressPercent(revealedCount: number, totalSafe: number): number {
  if (totalSafe <= 0) return 0;
  return Math.min(100, Math.round((revealedCount / totalSafe) * 100));
}

function formatElapsed(elapsedMs: number): string {
  const centiseconds = Math.floor(elapsedMs / 10);
  const minutes = Math.floor(centiseconds / 6_000);
  const seconds = Math.floor(centiseconds / 100) % 60;
  const remainder = centiseconds % 100;
  return [minutes, seconds, remainder]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

export function MinesweeperRaceBoard({
  position,
  selfSeat,
  disabled,
  pending,
  pendingCells = EMPTY_PENDING_CELLS,
  onAction,
}: GameRendererProps) {
  const data = readPublicRacePosition(position);
  const [now, setNow] = useState(Date.now());
  const remaining = countdownSeconds(data, now);
  const isPlayer = selfSeat !== null && selfSeat in data.ready;
  const ownReady = isPlayer ? data.ready[selfSeat] === true : false;

  useEffect(() => {
    if (data.phase !== "countdown" || remaining === 0) return;
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [data.phase, remaining]);

  const canPlay =
    !disabled &&
    isPlayer &&
    (data.phase === "playing" ||
      (data.phase === "countdown" && remaining === 0));

  return (
    <section class="minesweeper-race" aria-label="双人扫雷竞速">
      <div class="minesweeper-duel-toolbar minesweeper-race-toolbar">
        <p aria-live="polite">
          {minesweeperRaceToolbarMessage(
            data,
            position.outcome,
            selfSeat,
            now,
          )}
        </p>
        <div class="minesweeper-race-progress" aria-label="双方竞速进度">
          {RACE_SEATS.map((seat) => {
            const progress = data.progress[seat]!;
            const isSelf = seat === selfSeat;
            const label = isSelf
              ? "你"
              : seat === "seat-a"
                ? "玩家 A"
                : "玩家 B";
            return (
              <div class={`race-progress-row ${isSelf ? "is-self" : ""}`}>
                <span>
                  <strong>{label}</strong>
                  <small>
                    {progress.revealedCount} / {progress.totalSafe}
                  </small>
                </span>
                <progress
                  aria-label={`${label}完成进度`}
                  max={progress.totalSafe}
                  value={progress.revealedCount}
                />
                <b>{progressPercent(
                  progress.revealedCount,
                  progress.totalSafe,
                )}%</b>
              </div>
            );
          })}
        </div>
        {isPlayer && data.phase === "waiting_ready" ? (
          <button
            type="button"
            class="primary-button"
            disabled={disabled || pending || ownReady}
            onClick={() => onAction({ type: "ready" })}
          >
            {ownReady ? "已准备" : "准备"}
          </button>
        ) : null}
        {data.winnerCompletedMs !== null ? (
          <p class="race-winning-time">
            胜者用时 {formatElapsed(data.winnerCompletedMs)}
          </p>
        ) : null}
      </div>
      <MinesweeperBoard
        view={toPublicRaceMinefieldView(data)}
        mode={canPlay ? "playing" : "disabled"}
        pendingCells={pendingCells}
        onAction={onAction}
      />
      <p class="board-last-move">
        双方使用相同雷区、各扫各的棋盘；对手只能看到你的完成进度。
      </p>
    </section>
  );
}

function adapter(
  ruleSetId: string,
  displayName: string,
  landingDescription: string,
): GameAdapter {
  return {
    gameType: "minesweeper",
    ruleSetId,
    displayName,
    createRoomLabel: displayName,
    landingDescription,
    Renderer: MinesweeperRaceBoard,
    getSeatPresentations() {
      return {
        "seat-a": { label: "玩家 A", swatchClassName: "minesweeper-a" },
        "seat-b": { label: "玩家 B", swatchClassName: "minesweeper-b" },
      };
    },
    getErrorMessage(code) {
      return ERROR_MESSAGES[code] ?? null;
    },
    getStatusMessage(position, selfSeat) {
      const data = readPublicRacePosition(position);
      if (position.outcome !== null) return "本局已结束";
      if (selfSeat === null) return "正在观战扫雷竞速";
      if (data.phase === "waiting_ready") return "等待双方准备";
      if (data.phase === "countdown") return "竞速即将开始";
      if (data.phase === "playing") return "扫雷竞速进行中";
      return "本局已结束";
    },
    getOutcomeMessage(outcome, viewer) {
      if (outcome.kind === "draw") return "本局和局";
      if (viewer.selfSeat === null) {
        return viewer.winnerDisplayName === null
          ? "扫雷竞速已经结束"
          : `${viewer.winnerDisplayName}赢得竞速`;
      }
      const won = outcome.winner === viewer.selfSeat;
      if (outcome.reason === "opponent_hit_mine") {
        return won ? "对手踩雷，你赢了" : "你踩到雷，对手获胜";
      }
      if (outcome.reason === "race_completed") {
        return won ? "你先完成，赢得竞速" : "对手先完成";
      }
      return won ? "你赢了" : "对手获胜";
    },
  };
}

export const minesweeperRaceAdapters = [
  adapter(
    getMinesweeperRuleSetId("race", "small"),
    "双人扫雷竞速 · 小型",
    "9×9 · 10 雷 · 同图独立竞速",
  ),
  adapter(
    getMinesweeperRuleSetId("race", "medium"),
    "双人扫雷竞速 · 中型",
    "16×16 · 40 雷 · 同图独立竞速",
  ),
  adapter(
    getMinesweeperRuleSetId("race", "large"),
    "双人扫雷竞速 · 大型",
    "30×16 · 99 雷 · 可拖动大地图",
  ),
] as const;
