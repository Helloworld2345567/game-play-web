import { useEffect, useMemo, useState } from "preact/hooks";
import type { RuleOutcome } from "../../../core/game-rules";
import {
  readPublicDuelPosition,
  type PublicMinesweeperDuelData,
} from "../../../games/minesweeper/duel-rules";
import { getMinesweeperRuleSetId } from "../../../games/minesweeper/presets";
import type {
  PublicMinefieldCell,
  PublicMinefieldView,
} from "../../../games/minesweeper/public-view";
import type { GameAdapter, GameRendererProps } from "../registry";
import { MinesweeperBoard } from "./Board";

const EMPTY_PENDING_CELLS: ReadonlySet<string> = new Set<string>();

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  "minesweeper.game_finished": "本局已经结束。",
  "minesweeper.not_a_player": "观众不能操作棋盘。",
  "minesweeper.already_ready": "本局已经准备完成。",
  "minesweeper.not_selecting": "现在不能选择起始格。",
  "minesweeper.countdown_active": "倒计时结束后再选择起始格。",
  "minesweeper.out_of_bounds": "目标格超出雷区。",
  "minesweeper.start_already_selected": "你已经提交了起始格。",
  "minesweeper.not_playing": "双方选择起始格后才能开始排雷。",
  "minesweeper.flagged": "请先取消自己的旗帜再揭开。",
  "minesweeper.invalid_action": "无法识别这次扫雷操作。",
};

export function toPublicMinefieldView(
  data: PublicMinesweeperDuelData,
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
          revealedBy: cell.revealedBy,
        };
      }
      return { state: "hidden", flagged: flags.has(index) };
    },
  );
  return { ...data.config, cells };
}

export function countdownSeconds(data: PublicMinesweeperDuelData, now: number): number {
  if (data.countdownEndsAt === null) return 0;
  return Math.max(0, Math.ceil((data.countdownEndsAt - now) / 1_000));
}

/** Keep the countdown clock out of the board's render path. */
function useCountdownExpired(
  phase: PublicMinesweeperDuelData["phase"],
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

function DuelCountdownMessage({
  data,
  outcome,
  selfSeat,
}: {
  data: PublicMinesweeperDuelData;
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
      {minesweeperDuelToolbarMessage(data, outcome, selfSeat, now)}
    </p>
  );
}

export function minesweeperDuelToolbarMessage(
  data: PublicMinesweeperDuelData,
  outcome: RuleOutcome | null,
  selfSeat: string | null,
  now: number,
): string {
  if (outcome !== null) return "本局已结束";
  const remaining = countdownSeconds(data, now);
  const isPlayer = selfSeat !== null && selfSeat in data.ready;
  const ownReady = isPlayer ? data.ready[selfSeat] === true : false;
  const canChooseStart =
    isPlayer &&
    data.ownStart === null &&
    (data.phase === "selecting" ||
      (data.phase === "countdown" && remaining === 0));
  return data.phase === "waiting_ready"
    ? ownReady
      ? "已准备，等待对手准备"
      : "双方准备后开始倒计时"
    : data.phase === "countdown" && remaining > 0
      ? `${remaining} 秒后选择一个起始格`
      : canChooseStart
        ? "请选择你的秘密起始格"
        : data.phase === "selecting"
          ? "起始格已提交，等待对手"
          : data.phase === "playing"
            ? "双方可同时排雷，先踩雷者失败"
            : "本局已结束";
}

export function MinesweeperDuelBoard({
  position,
  selfSeat,
  disabled,
  pending,
  pendingCells = EMPTY_PENDING_CELLS,
  onAction,
}: GameRendererProps) {
  const data = useMemo(() => readPublicDuelPosition(position), [position]);
  const view = useMemo(() => toPublicMinefieldView(data), [data]);
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

  const canChooseStart =
    isPlayer &&
    data.ownStart === null &&
    (data.phase === "selecting" ||
      (data.phase === "countdown" && countdownComplete));
  const boardMode =
    !disabled && !pending && canChooseStart
      ? "select-start" as const
      : !disabled && isPlayer && data.phase === "playing"
        ? "playing" as const
        : "disabled" as const;

  return (
    <section class="minesweeper-duel" aria-label="双人同时扫雷">
      <div class="minesweeper-duel-toolbar">
        <DuelCountdownMessage
          data={data}
          outcome={position.outcome}
          selfSeat={selfSeat}
        />
        <div class="minesweeper-duel-scores" aria-label="双方得分">
          <span>席位 A <strong>{data.scores["seat-a"] ?? 0}</strong></span>
          <span>席位 B <strong>{data.scores["seat-b"] ?? 0}</strong></span>
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
      </div>
      <MinesweeperBoard
        view={view}
        mode={boardMode}
        pendingCells={pendingCells}
        onAction={onAction}
      />
      <p class="board-last-move">
        双方操作按服务器收到的顺序生效；你的旗帜仅自己可见。
      </p>
    </section>
  );
}

function adapter(
  ruleSetId: string,
  displayName: string,
  createRoomLabel: string,
  landingDescription: string,
): GameAdapter {
  return {
    gameType: "minesweeper",
    ruleSetId,
    displayName,
    createRoomLabel,
    landingDescription,
    Renderer: MinesweeperDuelBoard,
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
      const data = readPublicDuelPosition(position);
      if (position.outcome !== null) return "本局已结束";
      if (selfSeat === null) return "正在观战双人扫雷";
      if (data.phase === "waiting_ready") return "等待双方准备";
      if (data.phase === "countdown") return "倒计时后选择起始格";
      if (data.phase === "selecting") return "等待双方提交起始格";
      if (data.phase === "playing") return "双方同时排雷";
      return "本局已结束";
    },
    getOutcomeMessage(outcome, viewer) {
      if (outcome.kind === "draw") return "本局同分，和局";
      if (viewer.selfSeat === null) {
        return viewer.winnerDisplayName === null
          ? "本局已分胜负"
          : `${viewer.winnerDisplayName}获胜`;
      }
      return outcome.winner === viewer.selfSeat ? "你赢了" : "对手获胜";
    },
  };
}

export const minesweeperDuelAdapters = [
  adapter(
    getMinesweeperRuleSetId("duel", "small"),
    "双人扫雷 · 小型",
    "双人扫雷 · 小型",
    "9×9 · 10 雷 · 双方同时操作",
  ),
  adapter(
    getMinesweeperRuleSetId("duel", "medium"),
    "双人扫雷 · 中型",
    "双人扫雷 · 中型",
    "16×16 · 40 雷 · 双方同时操作",
  ),
  adapter(
    getMinesweeperRuleSetId("duel", "large"),
    "双人扫雷 · 大型",
    "双人扫雷 · 大型",
    "30×16 · 99 雷 · 可拖动大地图",
  ),
] as const;
