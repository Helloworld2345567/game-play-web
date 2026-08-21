import type { RulePosition } from "../../../core/game-rules";
import type { GameRendererProps } from "../registry";
import {
  getChaseMap,
  normalizeChaseMapId,
  type ChaseMapDefinition,
} from "./geometry";
import {
  getChaseLegalTargets,
  isChaseLegalTarget,
  type ChaseRole,
} from "./interactions";

interface ChaseLastMove {
  readonly seat: string | null;
  readonly from: string | null;
  readonly to: string;
}

export interface ChaseBoardData {
  readonly mapId: "easy" | "medium" | "hard";
  readonly thiefSeat: string;
  readonly policeSeat: string;
  readonly thiefNode: string;
  readonly policeNode: string;
  readonly moveCount: number;
  readonly completedRounds: number;
  readonly optimalRounds: number;
  readonly roundLimit: number;
  readonly lastMove: ChaseLastMove | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function integerOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : fallback;
}

function readLastMove(value: unknown): ChaseLastMove | null {
  if (!isRecord(value) || typeof value.to !== "string") return null;
  return {
    seat:
      typeof value.seat === "string"
        ? value.seat
        : typeof value.actor === "string"
          ? value.actor
          : null,
    from: typeof value.from === "string" ? value.from : null,
    to: value.to,
  };
}

/** Keep rendering defensive: a stale/unknown room should not crash the page. */
export function readChaseBoardData(position: RulePosition): ChaseBoardData {
  const raw = isRecord(position.data) ? position.data : {};
  const mapId = normalizeChaseMapId(raw.mapId);
  const map = getChaseMap(mapId);
  const thiefNode = stringOr(raw.thiefNode, map.nodes[0] ?? "");
  const policeNode = stringOr(raw.policeNode, map.nodes[1] ?? map.nodes[0] ?? "");
  const moveCount = integerOr(raw.moveCount ?? raw.ply, 0);
  const optimalRounds = integerOr(raw.optimalRounds, 0);
  const completedRounds = integerOr(raw.completedRounds, Math.floor(moveCount / 2));
  const roundLimit = integerOr(
    raw.roundLimit ?? raw.maxRounds,
    optimalRounds > 0 ? optimalRounds * 2 + 5 : 0,
  );
  return {
    mapId,
    thiefSeat: stringOr(raw.thiefSeat, "seat-a"),
    policeSeat: stringOr(raw.policeSeat, "seat-b"),
    thiefNode,
    policeNode,
    moveCount,
    completedRounds,
    optimalRounds,
    roundLimit,
    lastMove: readLastMove(raw.lastMove),
  };
}

function occupantAt(
  data: ChaseBoardData,
  node: string,
): "thief" | "police" | "empty" {
  // Police takes visual precedence on a capture node.  The is-caught marker
  // still exposes that both pieces share the node.
  if (node === data.policeNode) return "police";
  if (node === data.thiefNode) return "thief";
  return "empty";
}

function roleLabel(role: ChaseRole): string {
  return role === "thief" ? "小偷" : "警察";
}

function nodeAriaLabel(
  data: ChaseBoardData,
  node: string,
  legal: boolean,
): string {
  const sameNode = node === data.thiefNode && node === data.policeNode;
  const occupant = occupantAt(data, node);
  const occupantText = sameNode
    ? "警察与小偷（已抓获）"
    : occupant === "empty"
      ? "空位"
      : roleLabel(occupant);
  return `节点 ${node}，${occupantText}${legal ? "，可走" : ""}`;
}

function lastMoveText(
  data: ChaseBoardData,
  map: ChaseMapDefinition,
): string {
  if (data.lastMove === null) return "上一步：尚未走子。";
  const role = data.lastMove.seat === data.thiefSeat
    ? "小偷"
    : data.lastMove.seat === data.policeSeat
      ? "警察"
      : "玩家";
  const from = data.lastMove.from;
  // Unknown node ids can exist briefly while an old client receives a newer
  // position.  Keep the text useful without making the board throw.
  const destination = map.nodes.includes(data.lastMove.to)
    ? data.lastMove.to
    : `${data.lastMove.to}（未知节点）`;
  return `上一步：${role} ${from === null ? `走到 ${destination}` : `${from} → ${destination}`}。`;
}

export function ChaseBoard({
  position,
  selfSeat,
  disabled,
  pending,
  pendingCells,
  onAction,
}: GameRendererProps) {
  const data = readChaseBoardData(position);
  const map = getChaseMap(data.mapId);
  const isThief = selfSeat !== null && selfSeat === data.thiefSeat;
  const isPolice = selfSeat !== null && selfSeat === data.policeSeat;
  const role: ChaseRole | null = isThief ? "thief" : isPolice ? "police" : null;
  const canInteract =
    !disabled &&
    !pending &&
    role !== null &&
    position.turn === selfSeat &&
    position.outcome === null;
  const legalTargets = canInteract
    ? getChaseLegalTargets(
        map,
        role,
        role === "thief" ? data.thiefNode : data.policeNode,
        role === "thief" ? data.policeNode : data.thiefNode,
      )
    : [];
  const pendingSet = pendingCells ?? new Set<string>();
  const currentTurnLabel = position.outcome !== null
    ? "本局已结束"
    : selfSeat === null
      ? "观战中"
      : position.turn === selfSeat
        ? "轮到你走"
        : position.turn === data.thiefSeat
          ? "轮到小偷走"
          : "轮到警察走";
  const mapLabel = map.label;

  return (
    <>
      <section
        class="board-shell chase-board-shell"
        aria-label={`警察抓小偷，${mapLabel}`}
      >
        <div class="chase-board" role="group" aria-label={`${mapLabel}图棋盘`}>
          <svg
            class="chase-board-edges"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden="true"
            focusable="false"
          >
            {map.edges.map(([from, to]) => {
              const fromPoint = map.points[from];
              const toPoint = map.points[to];
              if (fromPoint === undefined || toPoint === undefined) return null;
              return (
                <line
                  key={`${from}-${to}`}
                  x1={fromPoint.x}
                  y1={fromPoint.y}
                  x2={toPoint.x}
                  y2={toPoint.y}
                />
              );
            })}
          </svg>
          <div class="chase-node-layer">
            {map.nodes.map((node) => {
              const point = map.points[node];
              if (point === undefined) return null;
              const legal = isChaseLegalTarget(legalTargets, node);
              const pendingTarget = pendingSet.has(`move:${node}`);
              const isCaught = node === data.thiefNode && node === data.policeNode;
              const occupant = occupantAt(data, node);
              const available = legal && !pendingTarget;
              return (
                <button
                  key={node}
                  type="button"
                  class={`chase-node chase-node-${occupant}${
                    legal ? " is-legal" : ""
                  }${pendingTarget ? " is-pending" : ""}${
                    isCaught ? " is-caught" : ""
                  }`}
                  style={{ left: `${point.x}%`, top: `${point.y}%` }}
                  data-node={node}
                  data-occupant={occupant}
                  {...(pendingTarget ? { "data-pending": "true" } : {})}
                  disabled={!available}
                  aria-label={nodeAriaLabel(data, node, available)}
                  onClick={() => {
                    if (available) onAction({ type: "move", to: node });
                  }}
                >
                  <span aria-hidden="true" class="chase-node-token">
                    {isCaught ? (
                      <>
                        <span class="chase-token chase-token-police">B</span>
                        <span class="chase-token chase-token-caught">A</span>
                      </>
                    ) : occupant === "empty" ? null : (
                      <span class={`chase-token chase-token-${occupant}`}>
                        {occupant === "thief" ? "A" : "B"}
                      </span>
                    )}
                  </span>
                  <span aria-hidden="true" class="chase-node-label">{node}</span>
                </button>
              );
            })}
          </div>
        </div>
        <p class="sr-only">
          小偷只能走到相邻且不含警察的节点，警察可以走到相邻的小偷节点完成抓捕。
          选择一个可走节点后按回车或空格确认。
        </p>
      </section>

      <div class="chase-board-info" aria-live="polite">
        <div class="chase-board-legend" aria-label="角色图例">
          <span class="chase-legend-item">
            <span class="chase-token chase-token-thief" aria-hidden="true">A</span>
            小偷
          </span>
          <span class="chase-legend-item">
            <span class="chase-token chase-token-police" aria-hidden="true">B</span>
            警察
          </span>
        </div>
        <p class="chase-board-status">
          {currentTurnLabel} · 已完成 {data.completedRounds} 回合 / 上限 {data.roundLimit} 回合
        </p>
        <p class="chase-board-limit-note">
          警察完成第 {data.roundLimit} 回合仍未抓到小偷，小偷获胜。
        </p>
        <p class="board-last-move chase-last-move">
          {lastMoveText(data, map)}
        </p>
      </div>
    </>
  );
}
