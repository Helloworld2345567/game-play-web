import type {
  ClientGamePage,
  ClientGamePageLoader,
  ClientGameRegistration,
  ClientGameRenderer,
  ClientGameRendererLoader,
  GameLandingLaunch,
  GameLaunchTarget,
  GameLaunchPicker,
  GameRendererProps,
  LocalGamePageProps,
} from "./types";
import type { GameManifest, LaunchKind } from "../../shared/game-manifest";
import { GAME_MANIFESTS } from "../../shared/game-manifest";
import { MinesweeperPicker } from "./minesweeper/launch";
import {
  minesweeperDuelPresentations,
  minesweeperDuelRenderers,
  minesweeperRacePresentations,
  minesweeperRaceRenderers,
} from "./minesweeper/presentation";
import { ChasePicker } from "./chase/launch";
import { chasePresentations, chaseRenderers } from "./chase/presentation";
import { ChineseCheckersPicker } from "./chinese-checkers/launch";
import {
  chineseCheckersPresentations,
  chineseCheckersRenderers,
} from "./chinese-checkers/presentation";
import { gomokuPresentation, gomokuRenderer } from "./gomoku/presentation";
import { xiangqiPresentation, xiangqiRenderer } from "./xiangqi/presentation";
import {
  ticTacToePresentation,
  ticTacToeRenderer,
} from "./tictactoe/presentation";
import {
  tiaojiaqiPresentation,
  tiaojiaqiRenderer,
} from "./tiaojiaqi/presentation";

export type {
  ClientGamePage,
  ClientGamePageLoader,
  ClientGameRenderer,
  ClientGameRendererLoader,
  GameLandingLaunch,
  GameLaunchTarget,
  GameLaunchPicker,
  GameRendererProps,
  LocalGamePageProps,
} from "./types";

/**
 * The catalog is the browser seam for game capabilities. A game owns its
 * presentation and launch modules; this file only composes those static
 * registrations with the metadata-only server manifest.
 */
export const clientGameRegistrations: readonly ClientGameRegistration[] = [
  {
    gameId: "gomoku",
    adapters: [gomokuPresentation],
    rendererLoaders: [gomokuRenderer],
  },
  {
    gameId: "xiangqi",
    adapters: [xiangqiPresentation],
    rendererLoaders: [xiangqiRenderer],
  },
  {
    gameId: "tictactoe",
    adapters: [ticTacToePresentation],
    rendererLoaders: [ticTacToeRenderer],
  },
  {
    gameId: "tiaojiaqi",
    adapters: [tiaojiaqiPresentation],
    rendererLoaders: [tiaojiaqiRenderer],
  },
  {
    gameId: "chase",
    adapters: chasePresentations,
    rendererLoaders: chaseRenderers,
    landing: {
      ariaLabel: "警察抓小偷，选择地图难度",
      description: "轮流走一步 · 警察抓住小偷获胜",
      launch: { kind: "picker", gameType: "chase" },
      picker: ChasePicker,
    },
  },
  {
    gameId: "minesweeper",
    adapters: [
      ...minesweeperRacePresentations,
      ...minesweeperDuelPresentations,
    ],
    rendererLoaders: [
      ...minesweeperRaceRenderers,
      ...minesweeperDuelRenderers,
    ],
    loadPage: () =>
      import("./minesweeper/SoloPage").then(({ SoloPage }) => SoloPage),
    landing: {
      ariaLabel: "扫雷，选择玩法和难度",
      description: "单人计时 · 双人竞速",
      launch: { kind: "picker", gameType: "minesweeper" },
      picker: MinesweeperPicker,
    },
  },
  {
    gameId: "chinese-checkers",
    adapters: chineseCheckersPresentations,
    rendererLoaders: chineseCheckersRenderers,
    landing: {
      ariaLabel: "跳棋，选择联机人数",
      description: "标准 121 孔 · 2 / 3 / 4 人联机对战",
      launch: { kind: "picker", gameType: "chinese-checkers" },
      picker: ChineseCheckersPicker,
    },
  },
  {
    gameId: "2048",
    adapters: [],
    rendererLoaders: [],
    loadPage: () => import("./2048/SoloPage").then(({ SoloPage }) => SoloPage),
  },
  {
    gameId: "snake",
    adapters: [],
    rendererLoaders: [],
    loadPage: () => import("./snake/SoloPage").then(({ SoloPage }) => SoloPage),
  },
  {
    gameId: "sokoban",
    adapters: [],
    rendererLoaders: [],
    loadPage: () => import("./sokoban/SoloPage").then(({ SoloPage }) => SoloPage),
  },
  {
    gameId: "stack-game",
    adapters: [],
    rendererLoaders: [],
    loadPage: () =>
      import("./stack-game/SoloPage").then(({ SoloPage }) => SoloPage),
  },
  {
    gameId: "sliding-puzzle",
    adapters: [],
    rendererLoaders: [],
    loadPage: () =>
      import("./sliding-puzzle/SoloPage").then(({ SoloPage }) => SoloPage),
  },
] as const;

const registrationsByGameId = new Map<string, ClientGameRegistration>(
  clientGameRegistrations.map((registration) => [registration.gameId, registration]),
);

function getRegistration(gameId: string): ClientGameRegistration | null {
  return registrationsByGameId.get(gameId) ?? null;
}

function catalogEntry(
  manifest: GameManifest,
  registration: ClientGameRegistration | null,
): ClientGameCatalogEntry {
  const loadRenderer = (ruleSetId: string): Promise<ClientGameRenderer> => {
    const renderer = registration?.rendererLoaders.find(
      (candidate) => candidate.ruleSetId === ruleSetId,
    );
    if (
      renderer === undefined ||
      !manifest.ruleSetIds.includes(ruleSetId) ||
      renderer.ruleSetId !== ruleSetId
    ) {
      return Promise.reject(new Error("unsupported_game_renderer"));
    }
    return renderer.load();
  };
  return {
    ...manifest,
    ...(registration?.loadPage === undefined
      ? {}
      : { loadPage: registration.loadPage }),
    ...(registration?.landing === undefined
      ? {}
      : { landing: registration.landing }),
    loadRenderer,
  };
}

export interface ClientGameCatalogEntry extends GameManifest {
  readonly loadPage?: ClientGamePageLoader;
  /** Resolve one trusted rule version through the literal renderer allowlist. */
  readonly loadRenderer?: (ruleSetId: string) => Promise<ClientGameRenderer>;
  readonly landing?: ClientGameRegistration["landing"];
}

export const clientGameCatalog: readonly ClientGameCatalogEntry[] =
  GAME_MANIFESTS.map((manifest) =>
    catalogEntry(manifest, getRegistration(manifest.gameId)),
  );

const catalogByGameId = new Map<string, ClientGameCatalogEntry>(
  clientGameCatalog.map((entry) => [entry.gameId, entry]),
);

export function getClientGameCatalogEntry(
  gameId: string,
): ClientGameCatalogEntry | null {
  return catalogByGameId.get(gameId) ?? null;
}

export function getClientGameRendererLoader(
  gameId: string,
  ruleSetId: string,
): ClientGameRendererLoader | null {
  const entry = getClientGameCatalogEntry(gameId);
  if (
    entry?.loadRenderer === undefined ||
    !entry.ruleSetIds.includes(ruleSetId) ||
    getRegistration(gameId)?.rendererLoaders.length === 0
  ) {
    return null;
  }
  return () => entry.loadRenderer!(ruleSetId);
}

export function getClientGamePageLoader(
  gameId: string,
): ClientGamePageLoader | null {
  return getClientGameCatalogEntry(gameId)?.loadPage ?? null;
}

function landingEntry(
  manifest: GameManifest,
  registration: ClientGameRegistration,
): LandingGameCatalogEntry | null {
  if (manifest.creationPolicy !== "enabled") return null;
  if (registration.landing !== undefined) {
    return {
      id: manifest.gameId,
      label: registration.landing.label ?? manifest.title,
      ariaLabel: registration.landing.ariaLabel,
      description: registration.landing.description,
      launch: registration.landing.launch,
      ...(registration.landing.picker === undefined
        ? {}
        : { picker: registration.landing.picker }),
    };
  }
  if (manifest.launchKind === "local-game") {
    if (registration.loadPage === undefined) return null;
    return {
      id: manifest.gameId,
      label: manifest.title,
      ariaLabel: `${manifest.title}，开始本机游戏`,
      description: manifest.description,
      launch: { kind: "navigate", href: `/${manifest.gameId}` },
    };
  }
  if (manifest.launchKind !== "turn-room") return null;
  const ruleSetId = manifest.creatableRuleSetIds[0];
  if (ruleSetId === undefined) return null;
  const adapter = registration.adapters.find(
    (candidate) => candidate.ruleSetId === ruleSetId,
  );
  if (adapter === undefined) return null;
  return {
    id: manifest.gameId,
    label: adapter.landingLabel ?? manifest.title,
    ariaLabel: adapter.createRoomLabel,
    description: manifest.description,
    launch: {
      kind: "room",
      gameType: manifest.gameId,
      ruleSetId,
    },
  };
}

export interface LandingGameCatalogEntry {
  readonly id: string;
  readonly label: string;
  readonly ariaLabel: string;
  readonly description: string;
  readonly launch: GameLandingLaunch;
  readonly picker?: GameLaunchPicker;
}

/**
 * One generic landing list. Registration order is intentional: each game can
 * choose its own home-page position without a game-specific branch in App.
 */
export const LANDING_GAME_CATALOG: readonly LandingGameCatalogEntry[] =
  clientGameRegistrations.flatMap((registration) => {
    const manifest = GAME_MANIFESTS.find(
      (candidate) => candidate.gameId === registration.gameId,
    );
    if (manifest === undefined) return [];
    const entry = landingEntry(manifest, registration);
    return entry === null ? [] : [entry];
  });

/** External destinations that are presented separately from the game catalog. */
export const OTHER_SERVICE_LINKS = [
  {
    id: "image",
    label: "图片服务",
    href: "https://image.ym0v0.com/",
    description: "image.ym0v0.com",
  },
] as const;

/** Resolve only server-approved rule ids that also have a trusted adapter. */
export function resolveRematchModeOptions(
  gameType: string,
  rematchOptions: import("../../shared/protocol").RematchOptionsView | null | undefined,
): readonly {
  ruleSetId: string;
  label: string;
  description: string;
}[] {
  if (rematchOptions === null || rematchOptions === undefined) return [];
  const registration = getRegistration(gameType);
  if (registration === null) return [];
  return rematchOptions.ruleSetIds.flatMap((ruleSetId) => {
    const adapter = registration.adapters.find(
      (candidate) => candidate.ruleSetId === ruleSetId,
    );
    if (adapter === undefined) return [];
    return [{
      ruleSetId,
      label: adapter.modeLabel ?? adapter.displayName,
      description: adapter.landingDescription,
    }];
  });
}

/** A compact view useful to callers that only need launch metadata. */
export function getLaunchKind(gameId: string): LaunchKind | null {
  return getClientGameCatalogEntry(gameId)?.launchKind ?? null;
}

// PascalCase aliases keep the catalog facade discoverable for older callers.
export const ClientGameCatalog = clientGameCatalog;
export const clientCatalog = clientGameCatalog;
