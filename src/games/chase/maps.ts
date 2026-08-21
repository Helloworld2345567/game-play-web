export type ChaseMapId = "easy" | "medium" | "hard";
export type ChaseNode = string;

export interface ChaseMapDefinition {
  readonly mapId: ChaseMapId;
  readonly nodes: readonly ChaseNode[];
  readonly edges: readonly (readonly [ChaseNode, ChaseNode])[];
  readonly initialThiefNode: ChaseNode;
  readonly initialPoliceNode: ChaseNode;
  /** The minimax value in completed A+B rounds. */
  readonly optimalRounds: number;
  /** The number of completed A+B rounds before the thief escapes. */
  readonly roundLimit: number;
}

const EASY_NODES = ["T", "X", "L", "R", "Y", "C"] as const;
const MEDIUM_NODES = [
  "V0",
  "V1",
  "V2",
  "V3",
  "V4",
  "V5",
  "V6",
  "V7",
] as const;
const HARD_NODES = [
  "V0",
  "V1",
  "V2",
  "V3",
  "V4",
  "V5",
  "V6",
  "V7",
  "V8",
  "V9",
  "V10",
  "V11",
] as const;

/** Authoritative immutable graph and timing definitions for every chase map. */
export const CHASE_MAPS = {
  easy: {
    mapId: "easy",
    nodes: EASY_NODES,
    edges: [
      ["T", "X"],
      ["X", "L"],
      ["L", "R"],
      ["R", "Y"],
      ["Y", "T"],
      ["T", "C"],
      ["C", "L"],
      ["C", "R"],
    ],
    initialThiefNode: "L",
    initialPoliceNode: "T",
    optimalRounds: 5,
    roundLimit: 15,
  },
  medium: {
    mapId: "medium",
    nodes: MEDIUM_NODES,
    edges: [
      ["V0", "V1"],
      ["V1", "V2"],
      ["V2", "V3"],
      ["V3", "V4"],
      ["V4", "V5"],
      ["V5", "V6"],
      ["V6", "V7"],
      ["V7", "V0"],
      ["V1", "V7"],
      ["V3", "V7"],
      ["V4", "V6"],
    ],
    initialThiefNode: "V0",
    initialPoliceNode: "V2",
    optimalRounds: 10,
    roundLimit: 25,
  },
  hard: {
    mapId: "hard",
    nodes: HARD_NODES,
    edges: [
      ["V0", "V1"],
      ["V1", "V2"],
      ["V2", "V3"],
      ["V3", "V4"],
      ["V4", "V5"],
      ["V5", "V6"],
      ["V6", "V7"],
      ["V7", "V8"],
      ["V8", "V9"],
      ["V9", "V10"],
      ["V10", "V11"],
      ["V11", "V0"],
      ["V1", "V9"],
      ["V2", "V8"],
      ["V5", "V8"],
      ["V1", "V11"],
      ["V3", "V5"],
    ],
    initialThiefNode: "V0",
    initialPoliceNode: "V6",
    optimalRounds: 20,
    roundLimit: 45,
  },
} as const satisfies Readonly<Record<ChaseMapId, ChaseMapDefinition>>;
