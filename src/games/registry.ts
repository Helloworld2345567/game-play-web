import type { GameRules } from "../core/game-rules";
import { gomokuRules } from "./gomoku/rules";
import { minesweeperDuelRules } from "./minesweeper/duel-rules";
import { ticTacToeRules } from "./tictactoe/rules";
import { xiangqiRules } from "./xiangqi/rules";

const rulesById = new Map<string, GameRules>([
  [gomokuRules.definition.ruleSetId, gomokuRules],
  [xiangqiRules.definition.ruleSetId, xiangqiRules],
  [ticTacToeRules.definition.ruleSetId, ticTacToeRules],
  ...Object.values(minesweeperDuelRules).map(
    (rules) => [rules.definition.ruleSetId, rules] as const,
  ),
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
