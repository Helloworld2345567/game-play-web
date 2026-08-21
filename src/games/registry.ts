import type { GameRules } from "../core/game-rules";
import { chaseRules } from "./chase/rules";
import { gomokuRules } from "./gomoku/rules";
import { minesweeperDuelRules } from "./minesweeper/duel-rules";
import { minesweeperRaceRules } from "./minesweeper/race-rules";
import { ticTacToeRules } from "./tictactoe/rules";
import { xiangqiRules } from "./xiangqi/rules";

export type RuleCreationPolicy = "enabled" | "legacy_only";

interface ServerRuleRegistration {
  rules: GameRules;
  creationPolicy: RuleCreationPolicy;
  /** Rules in the same explicit group may be selected for a rematch. */
  rematchGroup?: string;
}

const registrations: readonly ServerRuleRegistration[] = [
  { rules: gomokuRules, creationPolicy: "enabled" },
  { rules: xiangqiRules, creationPolicy: "enabled" },
  { rules: ticTacToeRules, creationPolicy: "enabled" },
  ...Object.values(chaseRules).map(
    (rules) => ({
      rules,
      creationPolicy: "enabled" as const,
      rematchGroup: "chase",
    }),
  ),
  ...Object.values(minesweeperDuelRules).map(
    (rules) => ({ rules, creationPolicy: "legacy_only" as const }),
  ),
  ...Object.values(minesweeperRaceRules).map(
    (rules) => ({
      rules,
      creationPolicy: "enabled" as const,
      rematchGroup: "minesweeper.race",
    }),
  ),
];

const registrationsById = new Map<string, ServerRuleRegistration>(
  registrations.map((registration) => [
    registration.rules.definition.ruleSetId,
    registration,
  ]),
);

export function getGameRules(ruleSetId: string): GameRules | null {
  return registrationsById.get(ruleSetId)?.rules ?? null;
}

export function isSupportedGame(
  gameType: string,
  ruleSetId: string,
): boolean {
  const rules = getGameRules(ruleSetId);
  return rules?.definition.gameType === gameType;
}

/** New Room creation allowlist; legacy rules remain loadable for recovery. */
export function isCreatableRuleSet(
  gameType: string,
  ruleSetId: string,
): boolean {
  const registration = registrationsById.get(ruleSetId);
  return (
    registration?.creationPolicy === "enabled" &&
    registration.rules.definition.gameType === gameType
  );
}

function openingRolesMatch(left: GameRules, right: GameRules): boolean {
  const leftRoles = left.definition.openingRoleIds;
  const rightRoles = right.definition.openingRoleIds;
  if (leftRoles === undefined || rightRoles === undefined) {
    return leftRoles === rightRoles;
  }
  return (
    leftRoles.length === rightRoles.length &&
    leftRoles.every((roleId, index) => roleId === rightRoles[index])
  );
}

function rematchRulesCompatible(
  current: GameRules,
  target: GameRules,
): boolean {
  return (
    current.definition.gameType === target.definition.gameType &&
    current.definition.actionConsistency ===
      target.definition.actionConsistency &&
    openingRolesMatch(current, target)
  );
}

/**
 * Resolve a server-registered rule for a rematch transition.
 *
 * Re-selecting the current rule is always allowed, including for legacy-only
 * rooms. Switching to another rule requires an enabled registration in the
 * same explicit rematch group with compatible room semantics.
 */
export function getRematchGameRules(
  currentRuleSetId: string,
  targetRuleSetId: string,
): GameRules | null {
  const current = registrationsById.get(currentRuleSetId);
  if (current === undefined) return null;
  if (currentRuleSetId === targetRuleSetId) return current.rules;

  const target = registrationsById.get(targetRuleSetId);
  if (
    target === undefined ||
    target.creationPolicy !== "enabled" ||
    current.rematchGroup === undefined ||
    current.rematchGroup.length === 0 ||
    target.rematchGroup !== current.rematchGroup ||
    !rematchRulesCompatible(current.rules, target.rules)
  ) {
    return null;
  }
  return target.rules;
}

/**
 * Return the stable, server-authorized rule IDs available for the next
 * rematch of a room currently bound to `currentRuleSetId`.
 */
export function getRematchRuleSetIds(
  currentRuleSetId: string,
): readonly string[] {
  const current = registrationsById.get(currentRuleSetId);
  if (current === undefined) return [];
  if (current.rematchGroup === undefined || current.rematchGroup.length === 0) {
    return [currentRuleSetId];
  }
  return registrations
    .filter(
      (registration) =>
        registration.creationPolicy === "enabled" &&
        registration.rematchGroup === current.rematchGroup &&
        rematchRulesCompatible(current.rules, registration.rules),
    )
    .map((registration) => registration.rules.definition.ruleSetId);
}
