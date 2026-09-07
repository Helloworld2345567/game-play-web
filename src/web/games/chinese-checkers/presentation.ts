import type { RulePosition } from "../../../core/game-rules";
import {
  CHINESE_CHECKERS_ROOM_RULE_SET_IDS,
  readChineseCheckersPosition,
} from "../../../games/chinese-checkers/rules";
import type {
  GameAdapterDefinition,
  GameRendererRegistration,
  SeatPresentations,
} from "../types";

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  "chinese-checkers.game_finished": "本局已经结束。",
  "chinese-checkers.not_your_turn": "还没轮到你。",
  "chinese-checkers.not_a_player": "观众不能操作棋盘。",
  "chinese-checkers.invalid_action": "无法识别这次走棋。",
  "chinese-checkers.invalid_finish_hop": "当前没有需要结束的连跳。",
  "chinese-checkers.out_of_bounds": "目标棋孔不存在。",
  "chinese-checkers.empty_source": "这里没有可以移动的棋子。",
  "chinese-checkers.not_your_piece": "这不是你的棋子。",
  "chinese-checkers.occupied": "目标棋孔已经有棋子。",
  "chinese-checkers.illegal_move": "只能移动到棋盘标出的合法落点。",
};

const SEAT_IDS = ["seat-a", "seat-b", "seat-c", "seat-d"] as const;
const SEAT_STYLES = [
  "checkers-coral",
  "checkers-indigo",
  "checkers-teal",
  "checkers-violet",
] as const;

function createPresentation(
  ruleSetId: string,
  playerCount: 2 | 3 | 4,
): GameAdapterDefinition {
  return {
    gameType: "chinese-checkers",
    ruleSetId,
    displayName: `${playerCount} 人跳棋`,
    modeLabel: `${playerCount} 人`,
    landingLabel: "跳棋",
    createRoomLabel: `创建 ${playerCount} 人跳棋房`,
    landingDescription: `标准 121 孔 · ${playerCount} 人联机对战`,
    getSeatPresentations(position: RulePosition | null): SeatPresentations {
      const seats = position === null
        ? SEAT_IDS.slice(0, playerCount)
        : readChineseCheckersPosition(position).seats;
      return Object.fromEntries(
        seats.map((seat, index) => [
          seat,
          {
            label: `玩家 ${index + 1}`,
            swatchClassName: SEAT_STYLES[index] ?? "neutral",
          },
        ]),
      );
    },
    getErrorMessage(code: string) {
      return ERROR_MESSAGES[code] ?? null;
    },
    getStatusMessage(position, selfSeat) {
      const data = readChineseCheckersPosition(position);
      if (position.outcome !== null) return "本局已结束";
      if (selfSeat === null) return "正在观战跳棋";
      const currentPlayer = position.turn === null
        ? -1
        : data.seats.indexOf(position.turn);
      return position.turn === selfSeat
        ? `轮到你 · 第 ${data.engine.turnNumber} 回合`
        : `等待玩家 ${currentPlayer + 1} 走棋 · 第 ${data.engine.turnNumber} 回合`;
    },
    getOutcomeMessage(outcome, viewer) {
      if (outcome.kind === "draw") return "本局和局";
      if (viewer.selfSeat === null) {
        return viewer.winnerDisplayName === null
          ? "已有玩家率先到达目标营地"
          : `${viewer.winnerDisplayName}率先到达目标营地`;
      }
      return outcome.winner === viewer.selfSeat
        ? "全部棋子进入目标营地 · 你赢了"
        : "其他玩家率先完成目标";
    },
  };
}

export const chineseCheckersPresentations = [
  createPresentation(CHINESE_CHECKERS_ROOM_RULE_SET_IDS[0], 2),
  createPresentation(CHINESE_CHECKERS_ROOM_RULE_SET_IDS[1], 3),
  createPresentation(CHINESE_CHECKERS_ROOM_RULE_SET_IDS[2], 4),
] as const;

export const chineseCheckersRenderers: readonly GameRendererRegistration[] =
  CHINESE_CHECKERS_ROOM_RULE_SET_IDS.map((ruleSetId) => ({
    ruleSetId,
    load: () =>
      import("./Board").then(({ ChineseCheckersBoard }) => ChineseCheckersBoard),
  }));
