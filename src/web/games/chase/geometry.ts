import {
  CHASE_MAPS as CHASE_GRAPH_MAPS,
  type ChaseMapId,
} from "../../../games/chase/maps";

export type { ChaseMapId } from "../../../games/chase/maps";

export interface ChasePoint {
  readonly x: number;
  readonly y: number;
}

export type ChaseEdge = readonly [string, string];

export interface ChaseMapDefinition {
  readonly id: ChaseMapId;
  readonly label: string;
  readonly nodes: readonly string[];
  readonly edges: readonly ChaseEdge[];
  readonly points: Readonly<Record<string, ChasePoint>>;
}

const EASY_POINTS: Readonly<Record<string, ChasePoint>> = {
  T: { x: 50, y: 12 },
  X: { x: 19, y: 31 },
  L: { x: 25, y: 73 },
  R: { x: 75, y: 73 },
  Y: { x: 81, y: 31 },
  C: { x: 50, y: 49 },
};

function makeRingMap(
  id: ChaseMapId,
  label: string,
): ChaseMapDefinition {
  const graph = CHASE_GRAPH_MAPS[id];
  const size = graph.nodes.length;

  const points: Record<string, ChasePoint> = {};
  const radius = size === 8 ? 38 : 39;
  for (let index = 0; index < size; index += 1) {
    const angle = -Math.PI / 2 + (index * Math.PI * 2) / size;
    points[`V${index}`] = {
      x: 50 + radius * Math.cos(angle),
      y: 50 + radius * Math.sin(angle),
    };
  }

  return {
    id,
    label,
    nodes: graph.nodes,
    edges: graph.edges,
    points,
  };
}

export const CHASE_MAPS: Readonly<Record<ChaseMapId, ChaseMapDefinition>> = {
  easy: {
    id: "easy",
    label: "初始地图",
    nodes: CHASE_GRAPH_MAPS.easy.nodes,
    edges: CHASE_GRAPH_MAPS.easy.edges,
    points: EASY_POINTS,
  },
  medium: makeRingMap("medium", "中等地图"),
  hard: makeRingMap("hard", "困难地图"),
};

/** Accept both compact map ids in position.data and rule-set-shaped ids. */
export function normalizeChaseMapId(value: unknown): ChaseMapId {
  if (typeof value !== "string") return "easy";
  if (value === "medium" || value.includes(".medium.")) return "medium";
  if (value === "hard" || value.includes(".hard.")) return "hard";
  return "easy";
}

export function getChaseMap(value: unknown): ChaseMapDefinition {
  return CHASE_MAPS[normalizeChaseMapId(value)];
}

export function getChaseNeighbors(
  map: ChaseMapDefinition,
  node: string,
): readonly string[] {
  const neighbors: string[] = [];
  for (const [from, to] of map.edges) {
    if (from === node && !neighbors.includes(to)) neighbors.push(to);
    if (to === node && !neighbors.includes(from)) neighbors.push(from);
  }
  return neighbors;
}
