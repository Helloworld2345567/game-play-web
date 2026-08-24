/**
 * The small, serialisable description of a game that is shared by the
 * server and the client.
 *
 * Keep this module deliberately free of rule or UI imports.  A manifest is
 * metadata only; the client catalog is responsible for resolving a renderer
 * or a local-game page from an explicit, trusted allowlist.
 */
export type LaunchKind =
  | "turn-room"
  | "local-game"
  | "realtime-room";

export type GameCreationPolicy = "enabled" | "legacy_only";

export interface GameManifest {
  readonly gameId: string;
  readonly title: string;
  readonly description: string;
  /** Family-level hint; `creatableRuleSetIds` is the per-rule allowlist. */
  readonly creationPolicy: GameCreationPolicy;
  readonly launchKind: LaunchKind;
  readonly ruleSetIds: readonly string[];
  /** Rule ids that the public creation flow may offer for this family. */
  readonly creatableRuleSetIds: readonly string[];
}

/**
 * Supported game families and the rule versions that can still be read.
 *
 * Minesweeper intentionally includes the old duel rule ids here.  They are
 * needed to recover an existing room, while the landing page and server
 * creation policy only expose the current race rules.
 */
export const GAME_MANIFESTS = [
  {
    gameId: "gomoku",
    title: "五子棋",
    description: "15×15 · 黑先 · 连五获胜",
    creationPolicy: "enabled",
    launchKind: "turn-room",
    ruleSetIds: ["gomoku.freestyle15.v1"],
    creatableRuleSetIds: ["gomoku.freestyle15.v1"],
  },
  {
    gameId: "xiangqi",
    title: "中国象棋",
    description: "9×10 · 红先 · 将死或困毙",
    creationPolicy: "enabled",
    launchKind: "turn-room",
    ruleSetIds: ["xiangqi.casual.v1"],
    creatableRuleSetIds: ["xiangqi.casual.v1"],
  },
  {
    gameId: "tictactoe",
    title: "井字棋",
    description: "3×3 · X 先 · 三连获胜",
    creationPolicy: "enabled",
    launchKind: "turn-room",
    ruleSetIds: ["tictactoe.classic3.v1"],
    creatableRuleSetIds: ["tictactoe.classic3.v1"],
  },
  {
    gameId: "chase",
    title: "警察抓小偷",
    description: "轮流走一步 · 警察抓到小偷获胜",
    creationPolicy: "enabled",
    launchKind: "turn-room",
    ruleSetIds: [
      "chase.easy.v1",
      "chase.medium.v1",
      "chase.hard.v1",
    ],
    creatableRuleSetIds: [
      "chase.easy.v1",
      "chase.medium.v1",
      "chase.hard.v1",
    ],
  },
  {
    gameId: "minesweeper",
    title: "扫雷",
    description: "单人计时 · 双人竞速",
    creationPolicy: "enabled",
    // The current room mode is a concurrent/realtime room.  The same family
    // also owns a local solo page; the client catalog exposes both launchers
    // while keeping one home-page entry.
    launchKind: "realtime-room",
    ruleSetIds: [
      "minesweeper.race.9x9x10.v1",
      "minesweeper.race.16x16x40.v1",
      "minesweeper.race.30x16x99.v1",
      "minesweeper.duel.9x9x10.v1",
      "minesweeper.duel.16x16x40.v1",
      "minesweeper.duel.30x16x99.v1",
    ],
    creatableRuleSetIds: [
      "minesweeper.race.9x9x10.v1",
      "minesweeper.race.16x16x40.v1",
      "minesweeper.race.30x16x99.v1",
    ],
  },
  {
    gameId: "2048",
    title: "2048",
    description: "4×4 · 单人合并 · 最高分榜",
    creationPolicy: "enabled",
    launchKind: "local-game",
    ruleSetIds: ["2048.solo.4x4.v1"],
    creatableRuleSetIds: [],
  },
] as const satisfies readonly GameManifest[];

export type GameId = (typeof GAME_MANIFESTS)[number]["gameId"];

const manifestsByGameId = new Map<string, GameManifest>(
  GAME_MANIFESTS.map((manifest) => [manifest.gameId, manifest]),
);

/** Return metadata only; callers must still validate a rule id separately. */
export function getGameManifest(gameId: string): GameManifest | null {
  return manifestsByGameId.get(gameId) ?? null;
}

/**
 * Check the protocol's game/rule pair against the shared allowlist.  This is
 * intentionally fail-closed for unknown game ids and rule versions.
 */
export function isManifestRuleSet(
  gameId: string,
  ruleSetId: string,
): boolean {
  return getGameManifest(gameId)?.ruleSetIds.includes(ruleSetId) ?? false;
}

/** Metadata-only creation hint; the server registry remains authoritative. */
export function isCreatableManifestRuleSet(
  gameId: string,
  ruleSetId: string,
): boolean {
  return getGameManifest(gameId)?.creatableRuleSetIds.includes(ruleSetId) ?? false;
}

// Friendly aliases for consumers that prefer a noun over the constant name.
export const gameManifests = GAME_MANIFESTS;
export const GameManifests = GAME_MANIFESTS;
