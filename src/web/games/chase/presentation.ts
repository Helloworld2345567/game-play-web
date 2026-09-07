import type { RulePosition } from "../../../core/game-rules";
import type { GameActionCommand } from "../../../shared/protocol";
import type {
  GameAdapterDefinition,
  GameRendererRegistration,
  PlatformSeatId,
  SeatPresentations,
} from "../types";

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  "chase.game_finished": "本局已经结束。",
  "chase.not_your_turn": "还没轮到你。",
  "chase.not_a_player": "观众不能操作棋盘。",
  "chase.invalid_action": "无法识别这次走子。",
  "chase.invalid_position": "棋局数据无效，请刷新后重试。",
  "chase.occupied": "不能走到对方所在的节点。",
  "chase.illegal_move": "只能沿地图上的边走一步。",
  "chase.not_adjacent": "只能沿地图上的边走一步。",
  "chase.out_of_bounds": "目标节点不存在。",
};

function pendingCellKey(command: GameActionCommand): string | null {
  if (
    command.gameType !== "chase" ||
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

interface PositionData {
  readonly thiefSeat: PlatformSeatId | null;
  readonly policeSeat: PlatformSeatId | null;
  readonly thiefNode: string | null;
  readonly policeNode: string | null;
  readonly moveCount: number | null;
  readonly optimalRounds: number | null;
  readonly maxRounds: number | null;
}

function readPositionData(position: RulePosition | null): PositionData {
  const data = position?.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return {
      thiefSeat: null,
      policeSeat: null,
      thiefNode: null,
      policeNode: null,
      moveCount: null,
      optimalRounds: null,
      maxRounds: null,
    };
  }
  const record = data as Record<string, unknown>;
  const asSeat = (value: unknown): PlatformSeatId | null =>
    value === "seat-a" ||
      value === "seat-b" ||
      value === "seat-c" ||
      value === "seat-d"
      ? value
      : null;
  const asString = (value: unknown): string | null =>
    typeof value === "string" ? value : null;
  const asInteger = (value: unknown): number | null =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? value
      : null;
  return {
    thiefSeat: asSeat(record.thiefSeat),
    policeSeat: asSeat(record.policeSeat),
    thiefNode: asString(record.thiefNode),
    policeNode: asString(record.policeNode),
    moveCount: asInteger(record.moveCount ?? record.ply),
    optimalRounds: asInteger(record.optimalRounds),
    maxRounds: asInteger(record.maxRounds ?? record.roundLimit),
  };
}

function seatPresentations(position: RulePosition | null): SeatPresentations {
  const data = readPositionData(position);
  const thiefSeat = data.thiefSeat ?? "seat-a";
  return {
    "seat-a": {
      label: thiefSeat === "seat-a" ? "小偷" : "警察",
      swatchClassName: thiefSeat === "seat-a" ? "chase-thief" : "chase-police",
    },
    "seat-b": {
      label: thiefSeat === "seat-b" ? "小偷" : "警察",
      swatchClassName: thiefSeat === "seat-b" ? "chase-thief" : "chase-police",
    },
  };
}

function roleForSeat(
  data: PositionData,
  seat: string | null,
): "小偷" | "警察" | null {
  if (seat !== null && seat === data.thiefSeat) return "小偷";
  if (seat !== null && seat === data.policeSeat) return "警察";
  return null;
}

const DIFFICULTIES = [
  {
    ruleSetId: "chase.easy.v1",
    displayName: "警察抓小偷 · 简单",
    modeLabel: "简单",
    landingDescription: "初始地图 · 上限15轮",
  },
  {
    ruleSetId: "chase.medium.v1",
    displayName: "警察抓小偷 · 中等",
    modeLabel: "中等",
    landingDescription: "中型闭环 · 上限25轮",
  },
  {
    ruleSetId: "chase.hard.v1",
    displayName: "警察抓小偷 · 困难",
    modeLabel: "困难",
    landingDescription: "大型闭环 · 上限45轮",
  },
] as const;

function createPresentation(
  difficulty: (typeof DIFFICULTIES)[number],
): GameAdapterDefinition {
  return {
    gameType: "chase",
    ruleSetId: difficulty.ruleSetId,
    displayName: difficulty.displayName,
    modeLabel: difficulty.modeLabel,
    landingLabel: "警察抓小偷",
    createRoomLabel: `创建${difficulty.displayName}房`,
    landingDescription: difficulty.landingDescription,
    openingChoices: [
      {
        roleId: "thief",
        label: "小偷",
        orderLabel: "先手",
        swatchClassName: "chase-thief",
      },
      {
        roleId: "police",
        label: "警察",
        orderLabel: "后手",
        swatchClassName: "chase-police",
      },
    ],
    getPendingCellKey: pendingCellKey,
    getSeatPresentations: seatPresentations,
    getErrorMessage(code: string) {
      return ERROR_MESSAGES[code] ?? null;
    },
    getStatusMessage(position, selfSeat) {
      const data = readPositionData(position);
      if (position.outcome !== null) return "本局已结束";
      if (selfSeat === null) return "正在观战警察抓小偷";
      const role = roleForSeat(data, selfSeat);
      const moveText = data.moveCount === null
        ? ""
        : ` · 第 ${data.moveCount} 步`;
      if (position.turn === selfSeat) {
        return `轮到你${role === null ? "" : `（${role}）`}${moveText}`;
      }
      const turnRole = roleForSeat(data, position.turn);
      return `等待${turnRole ?? "对手"}走子${moveText}`;
    },
    getOutcomeMessage(outcome, viewer) {
      if (outcome.kind !== "win") return null;
      const result = outcome.reason === "thief_survived"
        ? "小偷撑过回合上限"
        : outcome.reason === "police_caught_thief"
          ? "警察抓获小偷"
          : null;
      if (result === null) return null;
      if (viewer.selfSeat === null) {
        return viewer.winnerDisplayName === null
          ? result
          : `${viewer.winnerDisplayName}（${result}）`;
      }
      return outcome.winner === viewer.selfSeat
        ? `${result} · 你赢了`
        : `${result} · 对手获胜`;
    },
  };
}

export const chasePresentations = DIFFICULTIES.map(createPresentation) as readonly GameAdapterDefinition[];

export const chaseRenderers: readonly GameRendererRegistration[] = DIFFICULTIES.map(
  (difficulty) => ({
    ruleSetId: difficulty.ruleSetId,
    load: () => import("./Board").then(({ ChaseBoard }) => ChaseBoard),
  }),
);
