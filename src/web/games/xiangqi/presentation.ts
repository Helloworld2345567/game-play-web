import { readXiangqiPosition } from "../../../games/xiangqi/rules";
import type { GameAdapterDefinition, GameRendererRegistration } from "../types";

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  "xiangqi.not_your_turn": "还没轮到你。",
  "xiangqi.invalid_action": "无法识别这次走子。",
  "xiangqi.invalid_position": "棋局数据无效，请刷新后重试。",
  "xiangqi.out_of_bounds": "落点超出棋盘。",
  "xiangqi.empty_source": "这里没有可以移动的棋子。",
  "xiangqi.not_your_piece": "这不是你的棋子。",
  "xiangqi.own_piece": "目标位置已有己方棋子。",
  "xiangqi.illegal_move": "这一步不符合中国象棋走法。",
  "xiangqi.self_check": "这一步会让自己的将帅处于被将军状态。",
  "xiangqi.cannot_capture_general": "中国象棋不能直接吃掉将帅。",
  "xiangqi.game_finished": "本局已经结束。",
};

export const xiangqiPresentation = {
  gameType: "xiangqi",
  ruleSetId: "xiangqi.casual.v1",
  displayName: "中国象棋",
  createRoomLabel: "创建中国象棋房",
  landingDescription: "9×10 · 红先 · 将死或困毙",
  openingChoices: [
    {
      roleId: "red",
      label: "红方",
      orderLabel: "先手",
      swatchClassName: "xiangqi-red",
    },
    {
      roleId: "black",
      label: "黑方",
      orderLabel: "后手",
      swatchClassName: "xiangqi-black",
    },
  ],
  getSeatPresentations(position) {
    const redSeat =
      position === null ? "seat-a" : readXiangqiPosition(position).redSeat;
    const seatARed = redSeat === "seat-a";
    return {
      "seat-a": {
        label: seatARed ? "红方" : "黑方",
        swatchClassName: seatARed ? "xiangqi-red" : "xiangqi-black",
      },
      "seat-b": {
        label: seatARed ? "黑方" : "红方",
        swatchClassName: seatARed ? "xiangqi-black" : "xiangqi-red",
      },
    };
  },
  getErrorMessage(code: string) {
    return ERROR_MESSAGES[code] ?? null;
  },
  getOutcomeMessage(outcome, viewer) {
    if (outcome.kind !== "win" || outcome.reason !== "checkmate") return null;
    if (viewer.selfSeat === null) {
      return viewer.winnerDisplayName === null
        ? "本局以绝杀结束"
        : `${viewer.winnerDisplayName}绝杀获胜`;
    }
    return outcome.winner === viewer.selfSeat
      ? "绝杀 · 你赢了"
      : "对手绝杀获胜";
  },
} satisfies GameAdapterDefinition;

export const xiangqiRenderer: GameRendererRegistration = {
  ruleSetId: "xiangqi.casual.v1",
  load: () =>
    import("./Board").then(({ XiangqiBoard }) => XiangqiBoard),
};
