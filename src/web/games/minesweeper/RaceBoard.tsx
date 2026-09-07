import { useEffect, useMemo, useState } from "preact/hooks";
import type { RuleOutcome } from "../../../core/game-rules";
import {
  readPublicRacePosition,
  type PublicMinesweeperRaceData,
} from "../../../games/minesweeper/race-rules";
import type {
  PublicMinefieldCell,
  PublicMinefieldView,
} from "../../../games/minesweeper/public-view";
import type { GameAdapter, GameRendererProps } from "../registry";
import { MinesweeperBoard } from "./Board";
import { minesweeperRacePresentations } from "./presentation";

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

export function countdownSeconds(data: PublicMinesweeperRaceData, now: number): number {
  if (data.countdownEndsAt === null) return 0;
  return Math.max(0, Math.ceil((data.countdownEndsAt - now) / 1_000));
}

/**
 * Keep the 100ms countdown state local to the toolbar.  The board projection
 * is driven only by a room snapshot, so it does not re-render for each clock
 * tick.
 */
function useCountdownExpired(
  phase: PublicMinesweeperRaceData["phase"],
  countdownEndsAt: number | null,
): boolean {
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    if (phase !== "countdown" || countdownEndsAt === null) {
      setExpired(true);
      return;
    }
    const delay = Math.max(0, countdownEndsAt - Date.now());
    setExpired(delay === 0);
    if (delay === 0) return;
    const timeout = window.setTimeout(() => setExpired(true), delay);
    return () => window.clearTimeout(timeout);
  }, [phase, countdownEndsAt]);

  return expired;
}

function RaceCountdownMessage({
  data,
  outcome,
  selfSeat,
}: {
  data: PublicMinesweeperRaceData;
  outcome: RuleOutcome | null;
  selfSeat: string | null;
}) {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const refresh = () => setNow(Date.now());
    refresh();
    if (data.phase !== "countdown" || data.countdownEndsAt === null) return;

    let timer: number | undefined;
    const tick = () => {
      const nextNow = Date.now();
      setNow(nextNow);
      if (data.countdownEndsAt !== null && nextNow >= data.countdownEndsAt) {
        if (timer !== undefined) window.clearInterval(timer);
      }
    };
    timer = window.setInterval(tick, 100);
    tick();
    return () => {
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [data.phase, data.countdownEndsAt]);

  return (
    <p aria-live="polite">
      {minesweeperRaceToolbarMessage(data, outcome, selfSeat, now)}
    </p>
  );
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
  const data = useMemo(() => readPublicRacePosition(position), [position]);
  const view = useMemo(() => toPublicRaceMinefieldView(data), [data]);
  const countdownExpired = useCountdownExpired(
    data.phase,
    data.countdownEndsAt,
  );
  const countdownComplete =
    data.phase !== "countdown" ||
    data.countdownEndsAt === null ||
    data.countdownEndsAt <= Date.now() ||
    countdownExpired;
  const isPlayer = selfSeat !== null && selfSeat in data.ready;
  const ownReady = isPlayer ? data.ready[selfSeat] === true : false;

  const canPlay =
    !disabled &&
    isPlayer &&
    (data.phase === "playing" ||
      (data.phase === "countdown" && countdownComplete));

  return (
    <section class="minesweeper-race" aria-label="双人扫雷竞速">
      <div class="minesweeper-duel-toolbar minesweeper-race-toolbar">
        <RaceCountdownMessage
          data={data}
          outcome={position.outcome}
          selfSeat={selfSeat}
        />
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
        view={view}
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

export const minesweeperRaceAdapters = [
  { ...minesweeperRacePresentations[0], Renderer: MinesweeperRaceBoard },
  { ...minesweeperRacePresentations[1], Renderer: MinesweeperRaceBoard },
  { ...minesweeperRacePresentations[2], Renderer: MinesweeperRaceBoard },
] as const satisfies readonly GameAdapter[];
