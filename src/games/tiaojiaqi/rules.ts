import type {
  GameRules,
  JsonValue,
  RuleCommand,
  RulePosition,
  SeatId,
  Seats,
} from "../../core/game-rules";

export type TiaojiaqiStone = 0 | 1 | 2;
export type TiaojiaqiNode = string;
export type TiaojiaqiBoard = Record<TiaojiaqiNode, TiaojiaqiStone>;

export interface TiaojiaqiPoint {
  readonly id: TiaojiaqiNode;
  readonly x: number;
  readonly y: number;
}

export type TiaojiaqiCaptureKind = "clamp" | "pick";

export interface TiaojiaqiCaptureOption {
  readonly id: string;
  readonly kind: TiaojiaqiCaptureKind;
  readonly convertedNodes: readonly TiaojiaqiNode[];
}

export interface TiaojiaqiMove {
  readonly seat: SeatId;
  readonly from: TiaojiaqiNode;
  readonly to: TiaojiaqiNode;
  readonly captureKind: TiaojiaqiCaptureKind | null;
  readonly convertedNodes: readonly TiaojiaqiNode[];
}

export interface TiaojiaqiPosition {
  readonly board: TiaojiaqiBoard;
  readonly blackSeat: SeatId;
  readonly whiteSeat: SeatId;
  readonly moveCount: number;
  readonly lastMove: TiaojiaqiMove | null;
}

function nodeId(x: number, y: number): TiaojiaqiNode {
  return `${x},${y}`;
}

export const TIAOJIAQI_NODES: readonly TiaojiaqiPoint[] = [
  ...Array.from({ length: 5 }, (_, y) =>
    Array.from({ length: 5 }, (_, x) => ({ id: nodeId(x, y), x, y })),
  ).flat(),
  { id: nodeId(5, 1), x: 5, y: 1 },
  { id: nodeId(5, 2), x: 5, y: 2 },
  { id: nodeId(6, 2), x: 6, y: 2 },
  { id: nodeId(5, 3), x: 5, y: 3 },
];

// The diamond's outer tip: the vertex furthest from the five-flower board.
export const TIAOJIAQI_DIAMOND_APEX = nodeId(6, 2);

/**
 * Maximal straight paths on the supplied board.  Movement may continue only
 * within one entry: crossing at a node never permits a turn.  The middle row
 * and the two diagonals through the attachment node deliberately continue
 * into the side diamond.
 */
const TIAOJIAQI_LINES: readonly (readonly TiaojiaqiNode[])[] = [
  ...[0, 1, 3, 4].map((y) =>
    Array.from({ length: 5 }, (_, x) => nodeId(x, y)),
  ),
  [
    nodeId(0, 2),
    nodeId(1, 2),
    nodeId(2, 2),
    nodeId(3, 2),
    nodeId(4, 2),
    nodeId(5, 2),
    nodeId(6, 2),
  ],
  ...Array.from({ length: 5 }, (_, x) =>
    Array.from({ length: 5 }, (_, y) => nodeId(x, y)),
  ),
  [nodeId(5, 1), nodeId(5, 2), nodeId(5, 3)],
  [nodeId(0, 0), nodeId(1, 1), nodeId(2, 2), nodeId(3, 3), nodeId(4, 4)],
  [nodeId(4, 0), nodeId(3, 1), nodeId(2, 2), nodeId(1, 3), nodeId(0, 4)],
  [nodeId(2, 0), nodeId(1, 1), nodeId(0, 2)],
  [nodeId(2, 0), nodeId(3, 1), nodeId(4, 2), nodeId(5, 3)],
  [nodeId(0, 2), nodeId(1, 3), nodeId(2, 4)],
  [nodeId(2, 4), nodeId(3, 3), nodeId(4, 2), nodeId(5, 1)],
  [nodeId(5, 1), nodeId(6, 2)],
  [nodeId(5, 3), nodeId(6, 2)],
];

function makeEdges(): readonly (
  readonly [TiaojiaqiNode, TiaojiaqiNode]
)[] {
  const seen = new Set<string>();
  const edges: [TiaojiaqiNode, TiaojiaqiNode][] = [];
  for (const line of TIAOJIAQI_LINES) {
    for (let index = 1; index < line.length; index += 1) {
      const from = line[index - 1];
      const to = line[index];
      if (from === undefined || to === undefined) continue;
      const key = [from, to].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push([from, to]);
    }
  }
  return edges;
}

export const TIAOJIAQI_EDGES = makeEdges();

const NODE_IDS = new Set(TIAOJIAQI_NODES.map(({ id }) => id));
const NODE_ORDER = new Map(
  TIAOJIAQI_NODES.map(({ id }, index) => [id, index]),
);

function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMovePayload(
  value: JsonValue,
): value is {
  type: "move";
  from: string;
  to: string;
  captureId?: string;
} {
  return (
    isRecord(value) &&
    value.type === "move" &&
    typeof value.from === "string" &&
    typeof value.to === "string" &&
    (value.captureId === undefined || typeof value.captureId === "string")
  );
}

function initialBoard(): TiaojiaqiBoard {
  const board = Object.fromEntries(
    TIAOJIAQI_NODES.map(({ id }) => [id, 0 as TiaojiaqiStone]),
  ) as TiaojiaqiBoard;
  for (let x = 0; x < 5; x += 1) {
    board[nodeId(x, 0)] = 2;
    board[nodeId(x, 4)] = 1;
  }
  return board;
}

export function readTiaojiaqiPosition(
  position: RulePosition,
): TiaojiaqiPosition {
  return position.data as unknown as TiaojiaqiPosition;
}

export function getTiaojiaqiLegalTargets(
  board: TiaojiaqiBoard,
  from: TiaojiaqiNode,
): readonly TiaojiaqiNode[] {
  if (!NODE_IDS.has(from) || board[from] === 0 || board[from] === undefined) {
    return [];
  }

  const targets = new Set<TiaojiaqiNode>();
  for (const line of TIAOJIAQI_LINES) {
    const originIndex = line.indexOf(from);
    if (originIndex < 0) continue;
    for (const direction of [-1, 1] as const) {
      for (
        let index = originIndex + direction;
        index >= 0 && index < line.length;
        index += direction
      ) {
        const target = line[index];
        if (target === undefined || board[target] !== 0) break;
        targets.add(target);
      }
    }
  }
  return [...targets].sort(
    (left, right) =>
      (NODE_ORDER.get(left) ?? Number.MAX_SAFE_INTEGER) -
      (NODE_ORDER.get(right) ?? Number.MAX_SAFE_INTEGER),
  );
}

export function getTiaojiaqiCaptureOptionsForMove(
  board: TiaojiaqiBoard,
  from: TiaojiaqiNode,
  to: TiaojiaqiNode,
): readonly TiaojiaqiCaptureOption[] {
  const movingStone = board[from];
  if (
    (movingStone !== 1 && movingStone !== 2) ||
    board[to] !== 0 ||
    !getTiaojiaqiLegalTargets(board, from).includes(to)
  ) {
    return [];
  }

  const movedBoard: TiaojiaqiBoard = {
    ...board,
    [from]: 0,
    [to]: movingStone,
  };
  return findCaptureOptions(movedBoard, to, movingStone);
}

function findCaptureOptions(
  board: TiaojiaqiBoard,
  movedTo: TiaojiaqiNode,
  movingStone: Exclude<TiaojiaqiStone, 0>,
): readonly TiaojiaqiCaptureOption[] {
  const opponentStone: Exclude<TiaojiaqiStone, 0> = movingStone === 1 ? 2 : 1;
  const opponentCount = Object.values(board).filter(
    (stone) => stone === opponentStone,
  ).length;
  const options: TiaojiaqiCaptureOption[] = [];

  for (const line of TIAOJIAQI_LINES) {
    const movedIndex = line.indexOf(movedTo);
    if (movedIndex < 0 || line.length < 3) continue;
    const firstStart = Math.max(0, movedIndex - 2);
    const lastStart = Math.min(movedIndex, line.length - 3);
    for (let start = firstStart; start <= lastStart; start += 1) {
      const window = line.slice(start, start + 3);
      const [left, middle, right] = window;
      if (left === undefined || middle === undefined || right === undefined) {
        continue;
      }
      // This variant's “两端无子” rule applies to the whole remaining line,
      // rather than only the immediately adjacent point beyond the trio.
      const tailsEmpty =
        line.slice(0, start).every((node) => board[node] === 0) &&
        line.slice(start + 3).every((node) => board[node] === 0);
      if (!tailsEmpty) continue;

      const clamp =
        opponentCount > 1 &&
        board[left] === movingStone &&
        board[middle] === opponentStone &&
        board[right] === movingStone &&
        (movedIndex === start || movedIndex === start + 2);
      if (clamp) {
        options.push({
          id: `clamp:${window.join(">")}`,
          kind: "clamp",
          convertedNodes: [middle],
        });
        continue;
      }

      const pick =
        opponentCount > 2 &&
        board[left] === opponentStone &&
        board[middle] === movingStone &&
        board[right] === opponentStone &&
        movedIndex === start + 1;
      if (pick) {
        options.push({
          id: `pick:${window.join(">")}`,
          kind: "pick",
          convertedNodes: [left, right],
        });
      }
    }
  }
  return options;
}

export const tiaojiaqiRules = {
  definition: {
    gameType: "tiaojiaqi",
    ruleSetId: "tiaojiaqi.five-flower-diamond.v1",
    actionConsistency: "strict_revision",
    openingRoleIds: ["black", "white"],
  } as const,

  create([blackSeat, whiteSeat]: Seats): RulePosition {
    return {
      data: {
        board: initialBoard(),
        blackSeat,
        whiteSeat,
        moveCount: 0,
        lastMove: null,
      } as unknown as JsonValue,
      turn: blackSeat,
      outcome: null,
    };
  },

  apply(current: RulePosition, command: RuleCommand) {
    if (current.outcome !== null || current.turn === null) {
      return { ok: false as const, code: "tiaojiaqi.game_finished" };
    }
    if (command.seat !== current.turn) {
      return { ok: false as const, code: "tiaojiaqi.not_your_turn" };
    }
    if (!isMovePayload(command.payload)) {
      return { ok: false as const, code: "tiaojiaqi.invalid_action" };
    }

    const { from, to } = command.payload;
    if (!NODE_IDS.has(from) || !NODE_IDS.has(to)) {
      return { ok: false as const, code: "tiaojiaqi.out_of_bounds" };
    }
    const data = readTiaojiaqiPosition(current);
    const movingStone: TiaojiaqiStone = command.seat === data.blackSeat
      ? 1
      : command.seat === data.whiteSeat
        ? 2
        : 0;
    if (movingStone === 0) {
      return { ok: false as const, code: "tiaojiaqi.not_a_player" };
    }
    if (data.board[from] === 0) {
      return { ok: false as const, code: "tiaojiaqi.empty_source" };
    }
    if (data.board[from] !== movingStone) {
      return { ok: false as const, code: "tiaojiaqi.not_your_piece" };
    }
    if (data.board[to] !== 0) {
      return { ok: false as const, code: "tiaojiaqi.occupied" };
    }
    if (!getTiaojiaqiLegalTargets(data.board, from).includes(to)) {
      return { ok: false as const, code: "tiaojiaqi.illegal_move" };
    }

    const captureOptions = getTiaojiaqiCaptureOptionsForMove(
      data.board,
      from,
      to,
    );
    const requestedCapture = command.payload.captureId;
    if (captureOptions.length > 1 && requestedCapture === undefined) {
      return { ok: false as const, code: "tiaojiaqi.capture_required" };
    }
    const capture = requestedCapture === undefined
      ? captureOptions[0] ?? null
      : captureOptions.find(({ id }) => id === requestedCapture) ?? null;
    if (requestedCapture !== undefined && capture === null) {
      return { ok: false as const, code: "tiaojiaqi.invalid_capture" };
    }

    const board: TiaojiaqiBoard = {
      ...data.board,
      [from]: 0,
      [to]: movingStone,
    };
    for (const convertedNode of capture?.convertedNodes ?? []) {
      board[convertedNode] = movingStone;
    }
    const nextSeat = movingStone === 1 ? data.whiteSeat : data.blackSeat;
    const opponentStone: Exclude<TiaojiaqiStone, 0> = movingStone === 1 ? 2 : 1;
    const opponentNodes = TIAOJIAQI_NODES
      .map(({ id }) => id)
      .filter((node) => board[node] === opponentStone);
    const opponentCanMove = opponentNodes.some(
      (node) => getTiaojiaqiLegalTargets(board, node).length > 0,
    );
    if (
      opponentNodes.length === 1 &&
      !opponentCanMove &&
      opponentNodes[0] !== TIAOJIAQI_DIAMOND_APEX
    ) {
      return {
        ok: false as const,
        code: "tiaojiaqi.last_piece_must_reach_apex",
      };
    }
    const outcome = opponentNodes.length === 0
      ? {
          kind: "win" as const,
          winner: command.seat,
          reason: "all_pieces_converted",
        }
      : !opponentCanMove
        ? {
            kind: "win" as const,
            winner: command.seat,
            reason: opponentNodes.length === 1
              ? "last_piece_trapped_at_apex"
              : "opponent_immobilized",
          }
        : null;
    return {
      ok: true as const,
      next: {
        data: {
          ...data,
          board,
          moveCount: data.moveCount + 1,
          lastMove: {
            seat: command.seat,
            from,
            to,
            captureKind: capture?.kind ?? null,
            convertedNodes: capture?.convertedNodes ?? [],
          },
        } as unknown as JsonValue,
        turn: outcome === null ? nextSeat : null,
        outcome,
      },
    };
  },

  project(position: RulePosition, _viewerSeat: SeatId | null): RulePosition {
    return position;
  },
} satisfies GameRules;
