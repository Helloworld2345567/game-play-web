import {
  Component,
  Fragment,
  type ComponentChildren,
  type FunctionComponent,
} from "preact";
import { useEffect, useState } from "preact/hooks";
import type { GameActionCommand, RoomSnapshot } from "../../shared/protocol";
import { clientGameRegistrations } from "./catalog";
import type {
  ClientGameRenderer,
  ClientGameRendererLoader,
  GameAdapter,
  GameAdapterDefinition,
  GameRendererProps,
  SeatPresentations,
} from "./types";

export type {
  GameAdapter,
  GameRendererProps,
  OpeningRoleChoice,
  PlatformSeatId,
  SeatPresentation,
  SeatPresentations,
} from "./types";

interface GameErrorBoundaryProps {
  gameName: string;
  children: ComponentChildren;
}

interface GameErrorBoundaryState {
  hasError: boolean;
  retryKey: number;
}

/**
 * Render failures are contained at the game seam. We intentionally expose a
 * generic recovery action and never put exception details into the page.
 */
export class GameErrorBoundary extends Component<
  GameErrorBoundaryProps,
  GameErrorBoundaryState
> {
  state: GameErrorBoundaryState = { hasError: false, retryKey: 0 };

  static getDerivedStateFromError(
    _error?: unknown,
  ): Partial<GameErrorBoundaryState> {
    return { hasError: true };
  }

  private retry = () => {
    this.setState((current) => ({
      hasError: false,
      retryKey: current.retryKey + 1,
    }));
  };

  render(props: GameErrorBoundaryProps, state: GameErrorBoundaryState) {
    if (state.hasError) {
      return (
        <section class="unsupported-game game-error-boundary" role="alert">
          <strong>这个棋盘暂时不可用</strong>
          <span>{props.gameName}</span>
          <small>棋局仍保留在房间中，可以重新加载棋盘。</small>
          <button class="secondary-button" type="button" onClick={this.retry}>
            重新加载棋盘
          </button>
        </section>
      );
    }
    return <Fragment key={state.retryKey}>{props.children}</Fragment>;
  }
}

export const unknownSeatPresentations: SeatPresentations = {
  "seat-a": { label: "席位 A", swatchClassName: "neutral" },
  "seat-b": { label: "席位 B", swatchClassName: "neutral" },
  "seat-c": { label: "席位 C", swatchClassName: "neutral" },
  "seat-d": { label: "席位 D", swatchClassName: "neutral" },
};

export function projectPendingCells(
  adapter: Pick<GameAdapter, "getPendingCellKey"> | null,
  actions: readonly GameActionCommand[],
): ReadonlySet<string> {
  const projected = new Set<string>();
  const projector = adapter?.getPendingCellKey;
  if (projector === undefined) return projected;
  for (const action of actions) {
    const key = projector(action);
    if (key !== null) projected.add(key);
  }
  return projected;
}

/**
 * Lazy component wrapper. Dynamic imports stay out of the initial bundle, and
 * a failed load renders a safe error state rather than choosing a fallback
 * component from untrusted room data.
 */
function createLazyRenderer(
  loadRenderer: ClientGameRendererLoader,
): FunctionComponent<GameRendererProps> {
  function LazyRenderer(props: GameRendererProps) {
    const [Renderer, setRenderer] = useState<ClientGameRenderer | null>(null);
    const [loadError, setLoadError] = useState<unknown>(null);

    useEffect(() => {
      let active = true;
      setRenderer(null);
      setLoadError(null);
      void loadRenderer().then(
        (nextRenderer) => {
          if (!active) return;
          setRenderer(() => nextRenderer);
        },
        () => {
          if (!active) return;
          setLoadError(new Error("game renderer failed to load"));
        },
      );
      return () => {
        active = false;
      };
    }, []);

    if (loadError !== null) throw loadError;
    if (Renderer === null) {
      return (
        <div class="board-placeholder" role="status" aria-live="polite">
          <span>正在加载棋盘…</span>
        </div>
      );
    }
    return <Renderer {...props} />;
  }

  return LazyRenderer;
}

function dynamicAdapter(
  metadata: GameAdapterDefinition,
  loadRenderer: ClientGameRendererLoader,
): GameAdapter {
  return {
    ...metadata,
    loadRenderer,
    Renderer: createLazyRenderer(loadRenderer),
  };
}

function createRegisteredAdapters(): readonly GameAdapter[] {
  return clientGameRegistrations.flatMap((registration) => {
    const renderers = new Map(
      registration.rendererLoaders.map((renderer) => [renderer.ruleSetId, renderer.load]),
    );
    return registration.adapters.map((metadata) => {
      const loadRenderer = renderers.get(metadata.ruleSetId);
      if (loadRenderer === undefined) {
        throw new Error(
          `Missing renderer allowlist entry: ${registration.gameId}/${metadata.ruleSetId}`,
        );
      }
      return dynamicAdapter(metadata, loadRenderer);
    });
  });
}

export const availableGameAdapters = createRegisteredAdapters();

const adaptersByRuleSetId = new Map<string, GameAdapter>(
  availableGameAdapters.map((adapter) => [adapter.ruleSetId, adapter]),
);

function adaptersFor(gameType: string): readonly GameAdapter[] {
  return availableGameAdapters.filter((adapter) => adapter.gameType === gameType);
}

function adapterFor(gameType: string, ruleSetId: string): GameAdapter {
  const adapter = availableGameAdapters.find(
    (candidate) =>
      candidate.gameType === gameType && candidate.ruleSetId === ruleSetId,
  );
  if (adapter === undefined) {
    throw new Error(`Missing game adapter: ${gameType}/${ruleSetId}`);
  }
  return adapter;
}

// Stable aliases keep existing game-specific tests and imports working while
// the definitions themselves now live in each game's presentation module.
export const gomokuAdapter = adapterFor("gomoku", "gomoku.freestyle15.v1");
export const xiangqiAdapter = adapterFor("xiangqi", "xiangqi.casual.v1");
export const ticTacToeAdapter = adapterFor("tictactoe", "tictactoe.classic3.v1");
export const minesweeperRaceAdapters = adaptersFor("minesweeper").filter(
  (adapter) => adapter.ruleSetId.includes(".race."),
);
export const minesweeperDuelAdapters = adaptersFor("minesweeper").filter(
  (adapter) => adapter.ruleSetId.includes(".duel."),
);
export const chaseAdapters = adaptersFor("chase");
export const tiaojiaqiAdapter = adapterFor(
  "tiaojiaqi",
  "tiaojiaqi.five-flower-diamond.v1",
);
export const chineseCheckersAdapters = adaptersFor("chinese-checkers");

export function getGameAdapter(
  gameType: string,
  ruleSetId: string,
): GameAdapter | null {
  const adapter = adaptersByRuleSetId.get(ruleSetId);
  // Check the pair, rather than trusting ruleSetId alone, so a malformed
  // room snapshot cannot select a renderer from another game family.
  return adapter?.gameType === gameType ? adapter : null;
}

/** Adapter-injected resolver used by the transport hook for game errors. */
export function resolveGameErrorMessage(
  code: string,
  snapshot: RoomSnapshot | null,
): string | null {
  if (snapshot === null) return null;
  return getGameAdapter(snapshot.gameType, snapshot.ruleSetId)
    ?.getErrorMessage(code) ?? null;
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
  return (
    <GameErrorBoundary
      key={`${gameType}:${ruleSetId}`}
      gameName={adapter.displayName}
    >
      <adapter.Renderer {...rendererProps} />
    </GameErrorBoundary>
  );
}
