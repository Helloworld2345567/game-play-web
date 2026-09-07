import type { FunctionComponent } from "preact";
import type {
  JsonValue,
  RuleOutcome,
  RulePosition,
} from "../../core/game-rules";
import type { GameActionCommand } from "../../shared/protocol";

export type PlatformSeatId =
  | "seat-a"
  | "seat-b"
  | "seat-c"
  | "seat-d";

export interface SeatPresentation {
  label: string;
  swatchClassName: string;
}

export interface OpeningRoleChoice {
  roleId: string;
  label: string;
  orderLabel: "先手" | "后手";
  swatchClassName: string;
}

export type SeatPresentations = Readonly<
  Record<string, SeatPresentation>
>;

export interface GameRendererProps {
  position: RulePosition;
  selfSeat: string | null;
  disabled: boolean;
  pending: boolean;
  pendingCells?: ReadonlySet<string>;
  onAction(payload: JsonValue): void;
}

export interface GameAdapter {
  readonly gameType: string;
  readonly ruleSetId: string;
  readonly displayName: string;
  /** Short label used when choosing among modes in the same game family. */
  readonly modeLabel?: string;
  readonly landingLabel?: string;
  readonly createRoomLabel: string;
  readonly landingDescription: string;
  /** Roles/colours that players may claim before the first position exists. */
  readonly openingChoices?: readonly OpeningRoleChoice[];
  /** Kept as a component facade; the implementation is lazy. */
  readonly Renderer: FunctionComponent<GameRendererProps>;
  /** Exposed for hosts that want to preload or inspect the lazy renderer. */
  readonly loadRenderer?: ClientGameRendererLoader;
  getSeatPresentations(position: RulePosition | null): SeatPresentations;
  getErrorMessage(code: string): string | null;
  /** Project an opaque in-flight command into this game's pending UI state. */
  getPendingCellKey?(command: GameActionCommand): string | null;
  getStatusMessage?(position: RulePosition, selfSeat: string | null): string;
  getOutcomeMessage?(
    outcome: RuleOutcome,
    viewer: {
      selfSeat: string | null;
      winnerDisplayName: string | null;
    },
  ): string | null;
}

/** Adapter metadata owned by a game registration before lazy wiring. */
export type GameAdapterDefinition = Omit<
  GameAdapter,
  "Renderer" | "loadRenderer"
>;

export type ClientGameRenderer = FunctionComponent<GameRendererProps>;
export type ClientGameRendererLoader = () => Promise<ClientGameRenderer>;

/** Props shared by the small launch pickers shown on the landing page. */
export interface GameLaunchPickerProps {
  creating: boolean;
  error: string | null;
  onLaunch(target: GameLaunchTarget): void;
  onClose(): void;
}

export type GameLaunchPicker = FunctionComponent<GameLaunchPickerProps>;

export type GameLaunchTarget =
  | {
      kind: "room";
      gameType: string;
      ruleSetId: string;
    }
  | {
      kind: "navigate";
      href: string;
    };

/** Shape retained by the landing catalog for stable callers and tests. */
export type GameLandingLaunch =
  | GameLaunchTarget
  | {
      kind: "picker";
      gameType: string;
    };

export interface GameLandingRegistration {
  readonly label?: string;
  readonly ariaLabel: string;
  readonly description: string;
  readonly launch: GameLandingLaunch;
  readonly picker?: GameLaunchPicker;
}

/** Props accepted by a page for a local game. */
export interface LocalGamePageProps {
  displayName: string;
  initiallyOpenProfile?: boolean;
  onDisplayNameChange(displayName: string): void;
}

export type ClientGamePage = FunctionComponent<LocalGamePageProps>;
export type ClientGamePageLoader = () => Promise<ClientGamePage>;

export interface GameRendererRegistration {
  readonly ruleSetId: string;
  readonly load: ClientGameRendererLoader;
}

/** All browser capabilities for one game family live behind this seam. */
export interface ClientGameRegistration {
  readonly gameId: string;
  readonly adapters: readonly GameAdapterDefinition[];
  readonly rendererLoaders: readonly GameRendererRegistration[];
  readonly loadPage?: ClientGamePageLoader;
  readonly landing?: GameLandingRegistration;
}
