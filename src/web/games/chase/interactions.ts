import {
  getChaseNeighbors,
  type ChaseMapDefinition,
} from "./geometry";

export type ChaseRole = "thief" | "police";

/**
 * Return the graph moves available to the actor at a position.  The thief
 * cannot step onto the police, while the police may step onto the thief to
 * finish the game.
 */
export function getChaseLegalTargets(
  map: ChaseMapDefinition,
  role: ChaseRole,
  from: string,
  opponent: string,
): readonly string[] {
  return getChaseNeighbors(map, from).filter(
    (target) => role === "police" || target !== opponent,
  );
}

export function isChaseLegalTarget(
  legalTargets: readonly string[],
  node: string,
): boolean {
  return legalTargets.includes(node);
}
