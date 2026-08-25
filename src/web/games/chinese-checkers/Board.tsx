import { useMemo, useState } from "preact/hooks";
import {
  CHINESE_CHECKERS_EDGES,
  CHINESE_CHECKERS_HOLES,
  getChineseCheckersLegalMoves,
  type ChineseCheckersHole,
  type ChineseCheckersPlayerId,
  type ChineseCheckersPosition,
  type ChineseCheckersState,
} from "../../../games/chinese-checkers/engine";
import { readChineseCheckersPosition } from "../../../games/chinese-checkers/rules";
import type { RulePosition, SeatId } from "../../../core/game-rules";
import type { GameRendererProps } from "../registry";
import "./game.css";

interface RoomBoardState {
  readonly engine: ChineseCheckersState;
  readonly seats: readonly SeatId[];
  readonly canAct: boolean;
  readonly playerId: ChineseCheckersPlayerId | null;
  readonly selectedPosition: ChineseCheckersPosition | null;
  readonly activePosition: ChineseCheckersPosition | null;
  readonly legalSteps: readonly ChineseCheckersPosition[];
  readonly legalJumps: readonly ChineseCheckersPosition[];
}

const PLAYER_META: Readonly<
  Record<ChineseCheckersPlayerId, { className: string; symbol: string }>
> = {
  0: { className: "coral", symbol: "●" },
  1: { className: "indigo", symbol: "◆" },
  2: { className: "teal", symbol: "✦" },
  3: { className: "violet", symbol: "✚" },
};

const BOARD_CENTER_PERCENT = 50;
const BOARD_X_STEP_PERCENT = 3.6;
const BOARD_Y_STEP_PERCENT = 5.4;
const HOLES_BY_POSITION = new Map(
  CHINESE_CHECKERS_HOLES.map((hole) => [hole.key, hole] as const),
);

function holePositionPoint(
  hole: ChineseCheckersHole,
): { readonly x: number; readonly y: number } {
  return {
    x: BOARD_CENTER_PERCENT + hole.x * BOARD_X_STEP_PERCENT,
    y: BOARD_CENTER_PERCENT + hole.y * BOARD_Y_STEP_PERCENT,
  };
}

function holePositionStyle(hole: ChineseCheckersHole) {
  const point = holePositionPoint(hole);
  return { left: `${point.x}%`, top: `${point.y}%` };
}

function asPlayerId(index: number): ChineseCheckersPlayerId | null {
  return index >= 0 && index <= 3
    ? index as ChineseCheckersPlayerId
    : null;
}

export function getChineseCheckersRoomBoardState(
  position: RulePosition,
  selfSeat: string | null,
  selected: ChineseCheckersPosition | null,
): RoomBoardState {
  const data = readChineseCheckersPosition(position);
  const playerId = selfSeat === null
    ? null
    : asPlayerId(data.seats.indexOf(selfSeat));
  const canAct =
    position.outcome === null &&
    selfSeat !== null &&
    position.turn === selfSeat &&
    playerId === data.engine.currentPlayer;
  const activePosition = data.engine.activeHop?.path.at(-1) ?? null;
  const selectedPosition = activePosition ?? selected;
  const legalMoves = canAct && selectedPosition !== null
    ? getChineseCheckersLegalMoves(data.engine, selectedPosition)
    : { steps: [], jumps: [] };

  return {
    engine: data.engine,
    seats: data.seats,
    canAct,
    playerId,
    selectedPosition,
    activePosition,
    legalSteps: legalMoves.steps,
    legalJumps: legalMoves.jumps,
  };
}

function positionLabel(position: ChineseCheckersPosition): string {
  const [x, y] = position.split(",");
  return `坐标 ${x}，${y}`;
}

export function ChineseCheckersBoard({
  position,
  selfSeat,
  disabled,
  pending,
  onAction,
}: GameRendererProps) {
  const [selected, setSelected] =
    useState<ChineseCheckersPosition | null>(null);
  const board = getChineseCheckersRoomBoardState(
    position,
    selfSeat,
    selected,
  );
  const legalSteps = useMemo(
    () => new Set(board.legalSteps),
    [board.legalSteps],
  );
  const legalJumps = useMemo(
    () => new Set(board.legalJumps),
    [board.legalJumps],
  );
  const hopPath = useMemo(
    () => new Set(board.engine.activeHop?.path ?? []),
    [board.engine.activeHop],
  );
  const lastPath = useMemo(
    () => new Set(board.engine.lastMove?.path ?? []),
    [board.engine.lastMove],
  );
  const interactionDisabled = disabled || pending || !board.canAct;

  const handleHoleClick = (hole: ChineseCheckersPosition) => {
    if (interactionDisabled) return;
    const owner = board.engine.pieces[hole];

    if (board.engine.activeHop !== null) {
      if (board.activePosition !== null && legalJumps.has(hole)) {
        onAction({
          type: "move",
          from: board.activePosition,
          to: hole,
        });
      }
      return;
    }

    if (owner === board.engine.currentPlayer) {
      setSelected(board.selectedPosition === hole ? null : hole);
      return;
    }
    if (
      board.selectedPosition !== null &&
      (legalSteps.has(hole) || legalJumps.has(hole))
    ) {
      onAction({
        type: "move",
        from: board.selectedPosition,
        to: hole,
      });
      setSelected(null);
    }
  };

  const lastMove = board.engine.lastMove;
  const jumpCount = Math.max(
    0,
    (board.engine.activeHop?.path.length ?? 1) - 1,
  );

  return (
    <section class="checkers-room-board" aria-label="联网跳棋棋盘">
      <div
        class={`checkers-board-shell ${position.outcome !== null ? "is-won" : ""}`}
      >
        <div
          class="checkers-board"
          role="grid"
          aria-label="跳棋棋盘，121 个棋位"
          aria-rowcount={17}
          aria-colcount={25}
        >
          <div class="checkers-board-star" aria-hidden="true" />
          <svg
            class="checkers-board-edges"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden="true"
            focusable="false"
          >
            {CHINESE_CHECKERS_EDGES.map(([from, to]) => {
              const fromHole = HOLES_BY_POSITION.get(from);
              const toHole = HOLES_BY_POSITION.get(to);
              if (fromHole === undefined || toHole === undefined) return null;
              const fromPoint = holePositionPoint(fromHole);
              const toPoint = holePositionPoint(toHole);
              return (
                <line
                  key={`${from}-${to}`}
                  data-from={from}
                  data-to={to}
                  x1={fromPoint.x}
                  y1={fromPoint.y}
                  x2={toPoint.x}
                  y2={toPoint.y}
                />
              );
            })}
          </svg>
          {CHINESE_CHECKERS_HOLES.map((hole, index) => {
            const owner = board.engine.pieces[hole.key];
            const ownerSeat = owner === undefined
              ? undefined
              : board.seats[owner];
            const isSelected = board.selectedPosition === hole.key;
            const isLegalStep = legalSteps.has(hole.key);
            const isLegalJump = legalJumps.has(hole.key);
            const isLastFrom = lastMove?.from === hole.key;
            const isLastTo = lastMove?.to === hole.key;
            const isCurrentPiece = owner === board.engine.currentPlayer;
            const focusable =
              !interactionDisabled &&
              (isCurrentPiece || isLegalStep || isLegalJump);
            const ownerLabel = owner === undefined
              ? "空棋孔"
              : `玩家 ${owner + 1} 的棋子`;
            return (
              <button
                key={hole.key}
                class={`checkers-hole ${hole.camp === null ? "" : `camp-${hole.camp}`} ${owner === undefined ? "is-empty" : `owner-${owner}`} ${isSelected ? "is-selected" : ""} ${isLegalStep ? "is-legal-step" : ""} ${isLegalJump ? "is-legal-jump" : ""} ${isLastFrom ? "is-last-from" : ""} ${isLastTo ? "is-last-to" : ""} ${board.activePosition === hole.key ? "is-hop-end" : ""} ${hopPath.has(hole.key) ? "is-hop-visited" : ""} ${lastPath.has(hole.key) ? "is-last-path" : ""}`}
                style={holePositionStyle(hole)}
                type="button"
                role="gridcell"
                data-hole={hole.key}
                data-owner={ownerSeat}
                data-player-id={owner}
                data-camp={hole.camp ?? undefined}
                data-selected={isSelected ? "true" : undefined}
                data-legal-step={isLegalStep ? "true" : undefined}
                data-legal-jump={isLegalJump ? "true" : undefined}
                data-hop={hopPath.has(hole.key) ? "true" : undefined}
                data-last-move={isLastFrom || isLastTo ? "true" : undefined}
                aria-label={`第 ${index + 1} 个棋位，${positionLabel(hole.key)}，${ownerLabel}${isLegalStep ? "，可单步到达" : isLegalJump ? "，可跳到达" : ""}`}
                aria-pressed={isSelected}
                tabIndex={focusable ? 0 : -1}
                disabled={interactionDisabled}
                onClick={() => handleHoleClick(hole.key)}
              >
                {owner === undefined ? null : (
                  <span
                    class={`checkers-piece ${PLAYER_META[owner].className}`}
                    aria-hidden="true"
                  >
                    {PLAYER_META[owner].symbol}
                  </span>
                )}
                {isLegalStep || isLegalJump ? (
                  <span class="checkers-legal-marker" aria-hidden="true">
                    {isLegalJump ? "↗" : "·"}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      <div class="checkers-room-board-footer">
        <p>
          {board.engine.activeHop !== null
            ? `连跳进行中 · 已跳 ${jumpCount} 次`
            : lastMove === null
              ? "选择己方棋子，棋盘会标出合法落点。"
              : `最近一步：${positionLabel(lastMove.from)} → ${positionLabel(lastMove.to)}`}
        </p>
        {board.engine.activeHop !== null && (
          <button
            class="primary-button"
            type="button"
            disabled={interactionDisabled}
            onClick={() => onAction({ type: "finish_hop" })}
          >
            结束连跳
          </button>
        )}
      </div>
    </section>
  );
}
