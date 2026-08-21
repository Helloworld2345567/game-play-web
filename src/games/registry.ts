import type { GameRules } from "../core/game-rules";
import { gomokuRules } from "./gomoku/rules";
import { minesweeperDuelRules } from "./minesweeper/duel-rules";
import { minesweeperRaceRules } from "./minesweeper/race-rules";
import { ticTacToeRules } from "./tictactoe/rules";
import { xiangqiRules } from "./xiangqi/rules";

export type RuleCreationPolicy = "enabled" | "legacy_only";

interface ServerRuleRegistration {
  rules: GameRules;
  creationPolicy: RuleCreationPolicy;
}

const registrations: readonly ServerRuleRegistration[] = [
  { rules: gomokuRules, creationPolicy: "enabled" },
  { rules: xiangqiRules, creationPolicy: "enabled" },
  { rules: ticTacToeRules, creationPolicy: "enabled" },
  ...Object.values(minesweeperDuelRules).map(
    (rules) => ({ rules, creationPolicy: "legacy_only" as const }),
  ),
  ...Object.values(minesweeperRaceRules).map(
    (rules) => ({ rules, creationPolicy: "enabled" as const }),
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
