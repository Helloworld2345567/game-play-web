import { readGomokuPosition } from "../../../games/gomoku/rules";
import type {
  GameAdapterDefinition,
  GameRendererRegistration,
  SeatPresentations,
} from "../types";

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  "gomoku.not_your_turn": "还没轮到你。",
  "gomoku.occupied": "这个交叉点已经有棋子。",
  "gomoku.out_of_bounds": "落点超出棋盘。",
  "gomoku.game_finished": "本局已经结束。",
  "gomoku.invalid_action": "无法识别这次落子。",
};

export const gomokuPresentation = {
  gameType: "gomoku",
  ruleSetId: "gomoku.freestyle15.v1",
  displayName: "自由五子棋",
  landingLabel: "五子棋",
  createRoomLabel: "创建五子棋房",
  landingDescription: "15×15 · 黑先 · 连五获胜",
  openingChoices: [
    {
      roleId: "black",
      label: "黑方",
      orderLabel: "先手",
      swatchClassName: "black",
    },
    {
      roleId: "white",
      label: "白方",
      orderLabel: "后手",
      swatchClassName: "white",
    },
  ],
  getSeatPresentations(position): SeatPresentations {
    const blackSeat =
      position === null ? "seat-a" : readGomokuPosition(position).blackSeat;
    const seatABlack = blackSeat === "seat-a";
    return {
      "seat-a": {
        label: seatABlack ? "黑方" : "白方",
        swatchClassName: seatABlack ? "black" : "white",
      },
      "seat-b": {
        label: seatABlack ? "白方" : "黑方",
        swatchClassName: seatABlack ? "white" : "black",
      },
    };
  },
  getErrorMessage(code: string) {
    return ERROR_MESSAGES[code] ?? null;
  },
} satisfies GameAdapterDefinition;

export const gomokuRenderer: GameRendererRegistration = {
  ruleSetId: "gomoku.freestyle15.v1",
  load: () =>
    import("./Board").then(({ GomokuBoard }) => GomokuBoard),
};
