import type { GameRules } from "../core/game-rules";
import { gomokuRules } from "./gomoku/rules";
import { xiangqiRules } from "./xiangqi/rules";

const rulesById = new Map<string, GameRules>([
  [gomokuRules.definition.ruleSetId, gomokuRules],
  [xiangqiRules.definition.ruleSetId, xiangqiRules],
]);

export function getGameRules(ruleSetId: string): GameRules | null {
  return rulesById.get(ruleSetId) ?? null;
}

export function isSupportedGame(
  gameType: string,
  ruleSetId: string,
): boolean {
  const rules = getGameRules(ruleSetId);
  return rules?.definition.gameType === gameType;
}
