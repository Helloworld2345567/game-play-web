import type { RulePosition } from "../../../core/game-rules";
import type { GameActionCommand } from "../../../shared/protocol";
import { readTiaojiaqiPosition } from "../../../games/tiaojiaqi/rules";
import type {
  GameAdapterDefinition,
  GameRendererRegistration,
  SeatPresentations,
} from "../types";

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  "tiaojiaqi.game_finished": "本局已经结束。",
  "tiaojiaqi.not_your_turn": "还没轮到你。",
  "tiaojiaqi.not_a_player": "观众不能操作棋盘。",
  "tiaojiaqi.invalid_action": "无法识别这次走子。",
  "tiaojiaqi.invalid_position": "棋局数据无效，请刷新后重试。",
  "tiaojiaqi.out_of_bounds": "目标节点不存在。",
  "tiaojiaqi.empty_source": "这里没有可以移动的棋子。",
  "tiaojiaqi.not_your_piece": "这不是你的棋子。",
  "tiaojiaqi.occupied": "目标位置已有棋子。",
  "tiaojiaqi.illegal_move": "只能沿地图上的边移动到高亮节点。",
  "tiaojiaqi.invalid_capture": "这次夹换或挑换方式已经失效，请重新选择。",
  "tiaojiaqi.capture_required": "请选择这一步的夹换或挑换方式。",
  "tiaojiaqi.last_piece_must_reach_apex": "最后一子必须困在菱形最右尖端。",
};

function pendingCellKey(command: GameActionCommand): string | null {
  if (
    command.gameType !== "tiaojiaqi" ||
    typeof command.payload !== "object" ||
    command.payload === null ||
    Array.isArray(command.payload) ||
    command.payload.type !== "move" ||
    typeof command.payload.to !== "string"
  ) {
    return null;
  }
  return `move:${command.payload.to}`;
}

function seatPresentations(position: RulePosition | null): SeatPresentations {
  const blackSeat = position === null
    ? "seat-a"
    : readTiaojiaqiPosition(position).blackSeat;
  const seatABlack = blackSeat === "seat-a";
  return {
    "seat-a": {
      label: seatABlack ? "黑方" : "白方",
      swatchClassName: seatABlack ? "tiaojiaqi-black" : "tiaojiaqi-white",
    },
    "seat-b": {
      label: seatABlack ? "白方" : "黑方",
      swatchClassName: seatABlack ? "tiaojiaqi-white" : "tiaojiaqi-black",
    },
  };
}

export const tiaojiaqiPresentation = {
  gameType: "tiaojiaqi",
  ruleSetId: "tiaojiaqi.five-flower-diamond.v1",
  displayName: "挑夹棋",
  landingLabel: "挑夹棋",
  createRoomLabel: "创建挑夹棋房",
  landingDescription: "五花加十字菱形 · 每方五子 · 夹换/挑换",
  openingChoices: [
    {
      roleId: "black",
      label: "黑方",
      orderLabel: "先手",
      swatchClassName: "tiaojiaqi-black",
    },
    {
      roleId: "white",
      label: "白方",
      orderLabel: "后手",
      swatchClassName: "tiaojiaqi-white",
    },
  ],
  getPendingCellKey: pendingCellKey,
  getSeatPresentations: seatPresentations,
  getErrorMessage(code: string) {
    return ERROR_MESSAGES[code] ?? null;
  },
  getStatusMessage(position, selfSeat) {
    const data = readTiaojiaqiPosition(position);
    if (position.outcome !== null) return "本局已结束";
    if (selfSeat === null) return "正在观战挑夹棋";
    const side = selfSeat === data.blackSeat
      ? "黑方"
      : selfSeat === data.whiteSeat
        ? "白方"
        : "观众";
    const moveText = ` · 第 ${data.moveCount} 手`;
    return position.turn === selfSeat
      ? `轮到你（${side}）${moveText}`
      : `等待对手走子${moveText}`;
  },
  getOutcomeMessage(outcome, viewer) {
    if (outcome.kind === "draw") return "本局和局";
    const reason = outcome.reason === "all_pieces_converted"
      ? "对手棋子全部转化"
      : outcome.reason === "last_piece_trapped_at_apex"
        ? "最后一子困在菱形最右尖端"
        : outcome.reason === "opponent_immobilized"
          ? "对手无路可走"
          : "本局已结束";
    if (viewer.selfSeat === null) {
      return viewer.winnerDisplayName === null
        ? reason
        : `${viewer.winnerDisplayName}（${reason}）`;
    }
    return outcome.winner === viewer.selfSeat
      ? `${reason} · 你赢了`
      : `${reason} · 对手获胜`;
  },
} satisfies GameAdapterDefinition;

export const tiaojiaqiRenderer: GameRendererRegistration = {
  ruleSetId: "tiaojiaqi.five-flower-diamond.v1",
  load: () =>
    import("./Board").then(({ TiaojiaqiBoard }) => TiaojiaqiBoard),
};
