import { readTicTacToePosition } from "../../../games/tictactoe/rules";
import type { GameAdapterDefinition, GameRendererRegistration } from "../types";

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  "tictactoe.not_your_turn": "还没轮到你。",
  "tictactoe.occupied": "这个格子已经有标记。",
  "tictactoe.out_of_bounds": "落点超出棋盘。",
  "tictactoe.game_finished": "本局已经结束。",
  "tictactoe.invalid_action": "无法识别这次落子。",
};

export const ticTacToePresentation = {
  gameType: "tictactoe",
  ruleSetId: "tictactoe.classic3.v1",
  displayName: "井字棋",
  createRoomLabel: "创建井字棋房",
  landingDescription: "3×3 · X 先 · 三连获胜",
  openingChoices: [
    {
      roleId: "x",
      label: "X 方",
      orderLabel: "先手",
      swatchClassName: "tictactoe-x",
    },
    {
      roleId: "o",
      label: "O 方",
      orderLabel: "后手",
      swatchClassName: "tictactoe-o",
    },
  ],
  getSeatPresentations(position) {
    const xSeat = position === null
      ? "seat-a"
      : readTicTacToePosition(position).xSeat;
    const seatAX = xSeat === "seat-a";
    return {
      "seat-a": {
        label: seatAX ? "X 方" : "O 方",
        swatchClassName: seatAX ? "tictactoe-x" : "tictactoe-o",
      },
      "seat-b": {
        label: seatAX ? "O 方" : "X 方",
        swatchClassName: seatAX ? "tictactoe-o" : "tictactoe-x",
      },
    };
  },
  getErrorMessage(code: string) {
    return ERROR_MESSAGES[code] ?? null;
  },
} satisfies GameAdapterDefinition;

export const ticTacToeRenderer: GameRendererRegistration = {
  ruleSetId: "tictactoe.classic3.v1",
  load: () =>
    import("./Board").then(({ TicTacToeBoard }) => TicTacToeBoard),
};
