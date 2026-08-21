import type { FunctionComponent } from "preact";
import type {
  GameManifest,
  LaunchKind,
} from "../../shared/game-manifest";
import { GAME_MANIFESTS } from "../../shared/game-manifest";
import type { GameRendererProps } from "./registry";

/** Props accepted by a page for a local game. */
export interface LocalGamePageProps {
  displayName: string;
  initiallyOpenProfile?: boolean;
  onDisplayNameChange(displayName: string): void;
}

export type ClientGameRenderer = FunctionComponent<GameRendererProps>;
export type ClientGameRendererLoader = () => Promise<ClientGameRenderer>;
export type ClientGamePage = FunctionComponent<LocalGamePageProps>;
export type ClientGamePageLoader = () => Promise<ClientGamePage>;

export interface ClientGameCatalogEntry extends GameManifest {
  readonly loadPage?: ClientGamePageLoader;
  /** Resolve one trusted rule version through the literal renderer allowlist. */
  readonly loadRenderer?: (ruleSetId: string) => Promise<ClientGameRenderer>;
}

interface RendererRegistration {
  readonly gameId: string;
  readonly load: ClientGameRendererLoader;
}

/*
 * This is a deliberately boring allowlist.  Every import specifier is a
 * literal so a game id or rule id received over the network can never become
 * part of a module path.  Keep this map in sync with GAME_MANIFESTS and let
 * unknown pairs return null below (fail closed).
 */
const RENDERER_LOADERS = {
  "gomoku.freestyle15.v1": {
    gameId: "gomoku",
    load: () =>
      import("./gomoku/Board").then(({ GomokuBoard }) => GomokuBoard),
  },
  "xiangqi.casual.v1": {
    gameId: "xiangqi",
    load: () =>
      import("./xiangqi/Board").then(({ XiangqiBoard }) => XiangqiBoard),
  },
  "tictactoe.classic3.v1": {
    gameId: "tictactoe",
    load: () =>
      import("./tictactoe/Board").then(({ TicTacToeBoard }) => TicTacToeBoard),
  },
  "minesweeper.race.9x9x10.v1": {
    gameId: "minesweeper",
    load: () =>
      import("./minesweeper/RaceBoard").then(
        ({ MinesweeperRaceBoard }) => MinesweeperRaceBoard,
      ),
  },
  "minesweeper.race.16x16x40.v1": {
    gameId: "minesweeper",
    load: () =>
      import("./minesweeper/RaceBoard").then(
        ({ MinesweeperRaceBoard }) => MinesweeperRaceBoard,
      ),
  },
  "minesweeper.race.30x16x99.v1": {
    gameId: "minesweeper",
    load: () =>
      import("./minesweeper/RaceBoard").then(
        ({ MinesweeperRaceBoard }) => MinesweeperRaceBoard,
      ),
  },
  "minesweeper.duel.9x9x10.v1": {
    gameId: "minesweeper",
    load: () =>
      import("./minesweeper/DuelBoard").then(
        ({ MinesweeperDuelBoard }) => MinesweeperDuelBoard,
      ),
  },
  "minesweeper.duel.16x16x40.v1": {
    gameId: "minesweeper",
    load: () =>
      import("./minesweeper/DuelBoard").then(
        ({ MinesweeperDuelBoard }) => MinesweeperDuelBoard,
      ),
  },
  "minesweeper.duel.30x16x99.v1": {
    gameId: "minesweeper",
    load: () =>
      import("./minesweeper/DuelBoard").then(
        ({ MinesweeperDuelBoard }) => MinesweeperDuelBoard,
      ),
  },
} as const satisfies Readonly<Record<string, RendererRegistration>>;

/* Page imports are allowlisted independently from room renderers. */
const PAGE_LOADERS = {
  minesweeper: () =>
    import("./minesweeper/SoloPage").then(({ SoloPage }) => SoloPage),
} as const satisfies Readonly<Record<string, ClientGamePageLoader>>;

export function getClientGameRendererLoader(
  gameId: string,
  ruleSetId: string,
): ClientGameRendererLoader | null {
  const entry = getClientGameCatalogEntry(gameId);
  if (
    entry?.loadRenderer === undefined ||
    !entry.ruleSetIds.includes(ruleSetId)
  ) {
    return null;
  }
  const registration = (
    RENDERER_LOADERS as Readonly<Record<string, RendererRegistration>>
  )[ruleSetId];
  return registration?.gameId === gameId
    ? () => entry.loadRenderer!(ruleSetId)
    : null;
}

export function getClientGamePageLoader(
  gameId: string,
): ClientGamePageLoader | null {
  return (
    PAGE_LOADERS as Readonly<Record<string, ClientGamePageLoader>>
  )[gameId] ?? null;
}

/**
 * Client-side catalog.  The manifest remains the source of truth for the
 * metadata; this layer adds the trusted lazy page and renderer capabilities.
 */
function catalogEntry(
  manifest: GameManifest,
  loadPage?: ClientGamePageLoader,
): ClientGameCatalogEntry {
  return {
    ...manifest,
    ...(loadPage === undefined ? {} : { loadPage }),
    loadRenderer(ruleSetId) {
      const registration = (
        RENDERER_LOADERS as Readonly<Record<string, RendererRegistration>>
      )[ruleSetId];
      if (
        registration?.gameId !== manifest.gameId ||
        !manifest.ruleSetIds.includes(ruleSetId)
      ) {
        return Promise.reject(new Error("unsupported_game_renderer"));
      }
      return registration.load();
    },
  };
}

export const clientGameCatalog: readonly ClientGameCatalogEntry[] = [
  catalogEntry(GAME_MANIFESTS[0]),
  catalogEntry(GAME_MANIFESTS[1]),
  catalogEntry(GAME_MANIFESTS[2]),
  catalogEntry(GAME_MANIFESTS[3], PAGE_LOADERS.minesweeper),
];

export function getClientGameCatalogEntry(
  gameId: string,
): ClientGameCatalogEntry | null {
  return clientGameCatalog.find((entry) => entry.gameId === gameId) ?? null;
}

/** A compact view useful to callers that only need launch metadata. */
export function getLaunchKind(gameId: string): LaunchKind | null {
  return getClientGameCatalogEntry(gameId)?.launchKind ?? null;
}

// PascalCase aliases keep the catalog facade discoverable for older callers.
export const ClientGameCatalog = clientGameCatalog;
export const clientCatalog = clientGameCatalog;
