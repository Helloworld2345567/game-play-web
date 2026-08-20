import type { FunctionComponent } from "preact";
import type {
  JsonValue,
  RuleOutcome,
  RulePosition,
} from "../../core/game-rules";
import { gomokuAdapter } from "./gomoku/Board";
import { xiangqiAdapter } from "./xiangqi/Board";

export type PlatformSeatId = "seat-a" | "seat-b";

export interface SeatPresentation {
  label: string;
  swatchClassName: string;
}

export type SeatPresentations = Readonly<
  Record<PlatformSeatId, SeatPresentation>
>;

export interface GameRendererProps {
  position: RulePosition;
  selfSeat: string | null;
  disabled: boolean;
  pending: boolean;
  onAction(payload: JsonValue): void;
}

export interface GameAdapter {
  readonly gameType: string;
  readonly ruleSetId: string;
  readonly displayName: string;
  readonly createRoomLabel: string;
  readonly landingDescription: string;
  readonly Renderer: FunctionComponent<GameRendererProps>;
  getSeatPresentations(position: RulePosition | null): SeatPresentations;
  getErrorMessage(code: string): string | null;
  getOutcomeMessage?(
    outcome: RuleOutcome,
    selfSeat: string | null,
  ): string | null;
}

export const unknownSeatPresentations: SeatPresentations = {
  "seat-a": { label: "席位 A", swatchClassName: "neutral" },
  "seat-b": { label: "席位 B", swatchClassName: "neutral" },
};

export const availableGameAdapters = [
  gomokuAdapter,
  xiangqiAdapter,
] as const satisfies readonly GameAdapter[];

const adaptersByRuleSetId = new Map<string, GameAdapter>(
  availableGameAdapters.map((adapter) => [adapter.ruleSetId, adapter]),
);

export function getGameAdapter(
  gameType: string,
  ruleSetId: string,
): GameAdapter | null {
  const adapter = adaptersByRuleSetId.get(ruleSetId);
  return adapter?.gameType === gameType ? adapter : null;
}

export function UnsupportedGame({
  gameType,
  ruleSetId,
}: {
  gameType: string;
  ruleSetId: string;
}) {
  return (
    <section class="unsupported-game" role="alert">
      <strong>此浏览器暂不支持这个规则版本</strong>
      <span>{gameType} · {ruleSetId}</span>
      <small>请更新页面，或让房主创建当前版本支持的棋局。</small>
    </section>
  );
}

export function GameRenderer(
  {
    gameType,
    ruleSetId,
    ...rendererProps
  }: GameRendererProps & { gameType: string; ruleSetId: string },
) {
  const adapter = getGameAdapter(gameType, ruleSetId);
  if (adapter === null) {
    return <UnsupportedGame gameType={gameType} ruleSetId={ruleSetId} />;
  }
  return <adapter.Renderer {...rendererProps} />;
}
