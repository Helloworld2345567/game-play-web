import type { FunctionComponent } from "preact";
import type { JsonValue, RulePosition } from "../../core/game-rules";
import { GomokuBoard } from "./gomoku/Board";

export interface GameRendererProps {
  position: RulePosition;
  selfSeat: string | null;
  disabled: boolean;
  pending: boolean;
  onAction(payload: JsonValue): void;
}

const renderers: Record<string, FunctionComponent<GameRendererProps>> = {
  gomoku: GomokuBoard,
};

export function GameRenderer(
  props: GameRendererProps & { gameType: string },
) {
  const Renderer = renderers[props.gameType];
  if (Renderer === undefined) {
    return <p class="panel error-panel">此浏览器不支持该棋种。</p>;
  }
  return <Renderer {...props} />;
}

