import type { RulePosition } from "../../../core/game-rules";
import type { GameActionCommand } from "../../../shared/protocol";
import { getMinesweeperRuleSetId } from "../../../games/minesweeper/presets";
import { readPublicDuelPosition } from "../../../games/minesweeper/duel-rules";
import { readPublicRacePosition } from "../../../games/minesweeper/race-rules";
import type {
  GameAdapterDefinition,
  GameRendererRegistration,
  SeatPresentations,
} from "../types";

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

function pendingCellKey(command: GameActionCommand): string | null {
  if (
    command.gameType !== "minesweeper" ||
    typeof command.payload !== "object" ||
    command.payload === null ||
    Array.isArray(command.payload) ||
    !Number.isInteger(command.payload.x) ||
    !Number.isInteger(command.payload.y)
  ) {
    return null;
  }
  return `${String(command.payload.x)},${String(command.payload.y)}`;
}

function seatPresentations(): SeatPresentations {
  return {
    "seat-a": { label: "玩家 A", swatchClassName: "minesweeper-a" },
    "seat-b": { label: "玩家 B", swatchClassName: "minesweeper-b" },
  };
}

function createRacePresentation(
  ruleSetId: string,
  displayName: string,
  modeLabel: string,
  landingDescription: string,
): GameAdapterDefinition {
  return {
    gameType: "minesweeper",
    ruleSetId,
    displayName,
    modeLabel,
    createRoomLabel: displayName,
    landingDescription,
    getPendingCellKey: pendingCellKey,
    getSeatPresentations: seatPresentations,
    getErrorMessage(code: string) {
      return ERROR_MESSAGES[code] ?? null;
    },
    getStatusMessage(position: RulePosition, selfSeat: string | null) {
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

function createDuelPresentation(
  ruleSetId: string,
  displayName: string,
  createRoomLabel: string,
  landingDescription: string,
): GameAdapterDefinition {
  return {
    gameType: "minesweeper",
    ruleSetId,
    displayName,
    createRoomLabel,
    landingDescription,
    getPendingCellKey: pendingCellKey,
    getSeatPresentations: seatPresentations,
    getErrorMessage(code: string) {
      return ERROR_MESSAGES[code] ?? null;
    },
    getStatusMessage(position: RulePosition, selfSeat: string | null) {
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

export const minesweeperRacePresentations = [
  createRacePresentation(
    getMinesweeperRuleSetId("race", "small"),
    "双人扫雷竞速 · 小型",
    "小型",
    "9×9 · 10 雷 · 同图独立竞速",
  ),
  createRacePresentation(
    getMinesweeperRuleSetId("race", "medium"),
    "双人扫雷竞速 · 中型",
    "中型",
    "16×16 · 40 雷 · 同图独立竞速",
  ),
  createRacePresentation(
    getMinesweeperRuleSetId("race", "large"),
    "双人扫雷竞速 · 大型",
    "大型",
    "30×16 · 99 雷 · 桌面完整显示",
  ),
] as const;

export const minesweeperDuelPresentations = [
  createDuelPresentation(
    getMinesweeperRuleSetId("duel", "small"),
    "双人扫雷 · 小型",
    "双人扫雷 · 小型",
    "9×9 · 10 雷 · 双方同时操作",
  ),
  createDuelPresentation(
    getMinesweeperRuleSetId("duel", "medium"),
    "双人扫雷 · 中型",
    "双人扫雷 · 中型",
    "16×16 · 40 雷 · 双方同时操作",
  ),
  createDuelPresentation(
    getMinesweeperRuleSetId("duel", "large"),
    "双人扫雷 · 大型",
    "双人扫雷 · 大型",
    "30×16 · 99 雷 · 桌面完整显示",
  ),
] as const;

export const minesweeperRaceRenderers: readonly GameRendererRegistration[] =
  minesweeperRacePresentations.map(({ ruleSetId }) => ({
    ruleSetId,
    load: () =>
      import("./RaceBoard").then(({ MinesweeperRaceBoard }) => MinesweeperRaceBoard),
  }));

export const minesweeperDuelRenderers: readonly GameRendererRegistration[] =
  minesweeperDuelPresentations.map(({ ruleSetId }) => ({
    ruleSetId,
    load: () =>
      import("./DuelBoard").then(({ MinesweeperDuelBoard }) => MinesweeperDuelBoard),
  }));
