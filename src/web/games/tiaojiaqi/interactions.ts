import {
  getTiaojiaqiCaptureOptionsForMove,
  getTiaojiaqiLegalTargets,
  type TiaojiaqiBoard,
  type TiaojiaqiCaptureOption,
  type TiaojiaqiNode,
} from "../../../games/tiaojiaqi/rules";

/** The action payload submitted to the room when a move is confirmed. */
export interface TiaojiaqiMoveAction {
  readonly type: "move";
  readonly from: TiaojiaqiNode;
  readonly to: TiaojiaqiNode;
  readonly captureId?: string;
}

export interface TiaojiaqiSelectionState {
  readonly selectedNode: TiaojiaqiNode | null;
  /** A destination waiting for the player to choose a capture variant. */
  readonly destinationNode: TiaojiaqiNode | null;
}

export const EMPTY_TIAOJIAQI_SELECTION: TiaojiaqiSelectionState = {
  selectedNode: null,
  destinationNode: null,
};

export type TiaojiaqiMoveResolution =
  | { readonly kind: "submit"; readonly action: TiaojiaqiMoveAction }
  | {
      readonly kind: "choose-capture";
      readonly options: readonly TiaojiaqiCaptureOption[];
    }
  | { readonly kind: "invalid" };

/**
 * Resolve a destination through the rules' capture-option seam.
 *
 * A move with no capture, or with exactly one possible capture, is ready to
 * submit immediately.  The capture id is intentionally omitted in the
 * single-option case: the server treats that as the automatic choice.  A
 * destination with multiple choices is returned to the renderer so it can
 * ask the player to choose an id explicitly.
 */
export function resolveTiaojiaqiMove(
  board: TiaojiaqiBoard,
  from: TiaojiaqiNode,
  to: TiaojiaqiNode,
): TiaojiaqiMoveResolution {
  if (!getTiaojiaqiLegalTargets(board, from).includes(to)) {
    return { kind: "invalid" };
  }
  const options = getTiaojiaqiCaptureOptionsForMove(board, from, to);
  if (options.length > 1) {
    return { kind: "choose-capture", options };
  }
  return {
    kind: "submit",
    action: { type: "move", from, to },
  };
}

/** Build the explicit action after the player chooses a capture variant. */
export function createTiaojiaqiCaptureAction(
  from: TiaojiaqiNode,
  to: TiaojiaqiNode,
  option: Pick<TiaojiaqiCaptureOption, "id">,
): TiaojiaqiMoveAction {
  return { type: "move", from, to, captureId: option.id };
}

/**
 * Apply one graph-node click to the local selection state.
 *
 * Own stones are always selectable while interaction is enabled.  Clicking
 * the selected stone clears it; clicking another own stone changes the
 * source.  Empty non-legal nodes do not disturb the current source.
 */
export function transitionTiaojiaqiSelection(
  state: TiaojiaqiSelectionState,
  clickedNode: TiaojiaqiNode,
  ownNodes: ReadonlySet<TiaojiaqiNode>,
  legalTargets: readonly TiaojiaqiNode[],
  interactive: boolean,
): TiaojiaqiSelectionState {
  if (!interactive) return state;

  if (ownNodes.has(clickedNode)) {
    return state.selectedNode === clickedNode
      ? EMPTY_TIAOJIAQI_SELECTION
      : { selectedNode: clickedNode, destinationNode: null };
  }

  if (
    state.selectedNode !== null &&
    legalTargets.includes(clickedNode)
  ) {
    return { selectedNode: state.selectedNode, destinationNode: clickedNode };
  }

  return state;
}
