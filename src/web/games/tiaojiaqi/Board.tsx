import { useEffect, useMemo, useState } from "preact/hooks";
import type { JsonValue } from "../../../core/game-rules";
import {
  getTiaojiaqiLegalTargets,
  readTiaojiaqiPosition,
  TIAOJIAQI_DIAMOND_APEX,
  TIAOJIAQI_EDGES,
  TIAOJIAQI_NODES,
  type TiaojiaqiBoard,
  type TiaojiaqiCaptureOption,
  type TiaojiaqiNode,
  type TiaojiaqiStone,
} from "../../../games/tiaojiaqi/rules";
import type { GameRendererProps } from "../registry";
import {
  createTiaojiaqiCaptureAction,
  EMPTY_TIAOJIAQI_SELECTION,
  resolveTiaojiaqiMove,
  transitionTiaojiaqiSelection,
  type TiaojiaqiSelectionState,
} from "./interactions";

interface PendingTiaojiaqiCapture {
  readonly from: TiaojiaqiNode;
  readonly to: TiaojiaqiNode;
  readonly options: readonly TiaojiaqiCaptureOption[];
}

function stoneLabel(stone: TiaojiaqiStone): string {
  return stone === 1 ? "黑子" : stone === 2 ? "白子" : "空位";
}

function captureKindLabel(kind: TiaojiaqiCaptureOption["kind"]): string {
  return kind === "clamp" ? "夹换" : "挑换";
}

function sideLabel(
  stone: TiaojiaqiStone,
  blackSeat: string,
  whiteSeat: string,
): string {
  if (stone === 1) return `黑方（${blackSeat}）`;
  if (stone === 2) return `白方（${whiteSeat}）`;
  return "空位";
}

function coordinateLabel(x: number, y: number): string {
  return `第 ${y + 1} 行第 ${x + 1} 列`;
}

function lastMoveMessage(
  lastMove: ReturnType<typeof readTiaojiaqiPosition>["lastMove"],
  blackSeat: string,
  whiteSeat: string,
): string {
  if (lastMove === null) return "挑夹棋最近一手：尚未走子。";
  const side = lastMove.seat === blackSeat
    ? "黑方"
    : lastMove.seat === whiteSeat
      ? "白方"
      : "玩家";
  const capture = lastMove.captureKind === null
    ? ""
    : `，${captureKindLabel(lastMove.captureKind)}节点 ${lastMove.convertedNodes.length > 0
        ? lastMove.convertedNodes.join("、")
        : "棋子"}`;
  return `挑夹棋最近一手：${side} ${lastMove.from} → ${lastMove.to}${capture}。`;
}

function countStones(board: TiaojiaqiBoard): { black: number; white: number } {
  let black = 0;
  let white = 0;
  for (const stone of Object.values(board)) {
    if (stone === 1) black += 1;
    else if (stone === 2) white += 1;
  }
  return { black, white };
}

export function TiaojiaqiBoard({
  position,
  selfSeat,
  disabled,
  pending,
  pendingCells,
  onAction,
}: GameRendererProps) {
  const data = readTiaojiaqiPosition(position);
  const board = data.board;
  const ownStone: Exclude<TiaojiaqiStone, 0> | null =
    selfSeat === data.blackSeat
      ? 1
      : selfSeat === data.whiteSeat
        ? 2
        : null;
  const baseInteractable =
    !disabled &&
    !pending &&
    ownStone !== null &&
    position.turn === selfSeat &&
    position.outcome === null;
  const [selection, setSelection] = useState<TiaojiaqiSelectionState>(
    EMPTY_TIAOJIAQI_SELECTION,
  );
  const [captureChoice, setCaptureChoice] =
    useState<PendingTiaojiaqiCapture | null>(null);

  const ownNodes = useMemo(() => {
    const nodes = new Set<TiaojiaqiNode>();
    if (ownStone === null) return nodes;
    for (const node of TIAOJIAQI_NODES) {
      if (board[node.id] === ownStone) nodes.add(node.id);
    }
    return nodes;
  }, [board, ownStone]);

  const legalTargets =
    baseInteractable &&
      selection.selectedNode !== null &&
      captureChoice === null
      ? getTiaojiaqiLegalTargets(board, selection.selectedNode)
      : [];
  const legalTargetSet = useMemo(
    () => new Set(legalTargets),
    [legalTargets],
  );
  const pendingSet = pendingCells ?? new Set<string>();
  const convertedNodes = useMemo(
    () => new Set(data.lastMove?.convertedNodes ?? []),
    [data.lastMove?.convertedNodes],
  );
  const counts = useMemo(() => countStones(board), [board]);

  useEffect(() => {
    setSelection(EMPTY_TIAOJIAQI_SELECTION);
    setCaptureChoice(null);
  }, [
    data.moveCount,
    data.lastMove?.from,
    data.lastMove?.to,
    disabled,
    pending,
    position.turn,
    selfSeat,
  ]);

  const submitMove = (from: TiaojiaqiNode, to: TiaojiaqiNode) => {
    const resolution = resolveTiaojiaqiMove(board, from, to);
    if (resolution.kind === "choose-capture") {
      setCaptureChoice({ from, to, options: resolution.options });
      setSelection({ selectedNode: from, destinationNode: to });
      return;
    }
    if (resolution.kind === "submit") {
      onAction(resolution.action as unknown as JsonValue);
      setSelection(EMPTY_TIAOJIAQI_SELECTION);
    }
  };

  const cancelCaptureChoice = () => {
    setCaptureChoice(null);
    setSelection((current) => ({
      selectedNode: current.selectedNode,
      destinationNode: null,
    }));
  };

  const handleNodeClick = (node: TiaojiaqiNode) => {
    if (!baseInteractable) return;

    // The player may change source without losing the pending capture dialog;
    // this keeps the graph usable with keyboard and touch alike.
    if (captureChoice !== null) {
      if (ownNodes.has(node)) {
        const next = transitionTiaojiaqiSelection(
          selection,
          node,
          ownNodes,
          [],
          true,
        );
        setCaptureChoice(null);
        setSelection(next);
      }
      return;
    }

    const next = transitionTiaojiaqiSelection(
      selection,
      node,
      ownNodes,
      legalTargets,
      true,
    );
    if (
      next.destinationNode !== null &&
      selection.selectedNode !== null
    ) {
      submitMove(selection.selectedNode, next.destinationNode);
      return;
    }
    setSelection(next);
  };

  const currentTurnLabel = position.outcome !== null
    ? "本局已结束"
    : selfSeat === null
      ? "观战中"
      : disabled
        ? "棋盘暂不可操作"
        : pending
          ? "正在提交走子…"
          : position.turn === selfSeat
            ? `轮到你（${ownStone === 1 ? "黑方" : "白方"}）`
            : "等待对手走子";

  return (
    <>
      <section
        class="board-shell tiaojiaqi-board-shell"
        aria-labelledby="tiaojiaqi-board-title"
      >
        <h2 id="tiaojiaqi-board-title" class="sr-only">挑夹棋棋盘</h2>
        <div
          class="tiaojiaqi-board"
          role="group"
          aria-label="挑夹棋五花加十字菱形棋盘"
          aria-describedby="tiaojiaqi-board-instructions"
        >
          <svg
            class="tiaojiaqi-board-edges"
            viewBox="0 0 6 4"
            preserveAspectRatio="none"
            aria-hidden="true"
            focusable="false"
          >
            {TIAOJIAQI_EDGES.map(([from, to]) => {
              const fromPoint = TIAOJIAQI_NODES.find(({ id }) => id === from);
              const toPoint = TIAOJIAQI_NODES.find(({ id }) => id === to);
              if (fromPoint === undefined || toPoint === undefined) return null;
              return (
                <line
                  key={`${from}-${to}`}
                  x1={fromPoint.x}
                  y1={fromPoint.y}
                  x2={toPoint.x}
                  y2={toPoint.y}
                />
              );
            })}
          </svg>
          <div class="tiaojiaqi-node-layer">
            {TIAOJIAQI_NODES.map((point) => {
              const node = point.id;
              const stone = board[node] ?? 0;
              const own = ownNodes.has(node);
              const legal = legalTargetSet.has(node) && stone === 0;
              const selected = selection.selectedNode === node;
              const destination = selection.destinationNode === node;
              const lastFrom = data.lastMove?.from === node;
              const lastTo = data.lastMove?.to === node;
              const converted = convertedNodes.has(node);
              const pendingTarget = pendingSet.has(`move:${node}`);
              const available = baseInteractable &&
                (own || (captureChoice === null && legal && !pendingTarget));
              const ariaText = `${coordinateLabel(point.x, point.y)}，${stoneLabel(stone)}${
                own ? "，己方棋子" : ""
              }${selected ? "，已选中" : ""}${legal ? "，可移动到此处" : ""}${
                pendingTarget ? "，正在提交" : ""
              }`;
              return (
                <button
                  key={node}
                  type="button"
                  class={`tiaojiaqi-node tiaojiaqi-node-stone-${stone}${
                    own ? " is-own" : ""
                  }${selected ? " is-selected" : ""}${
                    destination ? " is-destination" : ""
                  }${legal ? " is-legal" : ""}${lastFrom ? " is-last-from" : ""}${
                    lastTo ? " is-last-to" : ""
                  }${converted ? " is-converted" : ""}${
                    node === TIAOJIAQI_DIAMOND_APEX ? " is-diamond-apex" : ""
                  }${pendingTarget ? " is-pending" : ""}`}
                  style={{
                    left: `${(point.x / 6) * 100}%`,
                    top: `${(point.y / 4) * 100}%`,
                  }}
                  data-node={node}
                  data-stone={stone}
                  aria-label={ariaText}
                  aria-pressed={selected}
                  disabled={!available}
                  onClick={() => handleNodeClick(node)}
                >
                  <span class="tiaojiaqi-node-stone" aria-hidden="true">
                    {stone === 1 ? "●" : stone === 2 ? "○" : ""}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        <p id="tiaojiaqi-board-instructions" class="sr-only">
          轮到你时，先选择己方棋子，再选择高亮的空节点移动。再次点击已选棋子可取消；若同一落点有多种夹换或挑换方式，请在下方选择。
        </p>
      </section>

      {captureChoice !== null && (
        <section
          class="tiaojiaqi-capture-panel"
          aria-labelledby="tiaojiaqi-capture-title"
          role="dialog"
        >
          <div class="tiaojiaqi-capture-heading">
            <div>
              <p class="eyebrow">需要选择</p>
              <h2 id="tiaojiaqi-capture-title">选择这一步的夹换或挑换方式</h2>
            </div>
            <button
              class="dialog-close"
              type="button"
              aria-label="取消选择夹换或挑换方式"
              onClick={cancelCaptureChoice}
            >
              ×
            </button>
          </div>
          <p class="tiaojiaqi-capture-note">
            {captureChoice.from} → {captureChoice.to} 有多种夹换/挑换结果，请选择一种后提交。
          </p>
          <div class="tiaojiaqi-capture-options">
            {captureChoice.options.map((option) => (
              <button
                key={option.id}
                type="button"
                class="tiaojiaqi-capture-option"
                disabled={disabled || pending}
                onClick={() => {
                  onAction(
                    createTiaojiaqiCaptureAction(
                      captureChoice.from,
                      captureChoice.to,
                      option,
                    ) as unknown as JsonValue,
                  );
                  setCaptureChoice(null);
                  setSelection(EMPTY_TIAOJIAQI_SELECTION);
                }}
              >
                <strong>{captureKindLabel(option.kind)}</strong>
                <span>
                  转换节点：{option.convertedNodes.length > 0
                    ? option.convertedNodes.join("、")
                    : "无"}
                </span>
              </button>
            ))}
          </div>
          <button
            class="secondary-button tiaojiaqi-capture-cancel"
            type="button"
            onClick={cancelCaptureChoice}
            disabled={disabled || pending}
          >
            取消，重新选择落点
          </button>
        </section>
      )}

      <div class="tiaojiaqi-board-info" aria-live="polite">
        <div class="tiaojiaqi-board-legend" aria-label="棋子图例">
          <span class="tiaojiaqi-legend-item">
            <span class="tiaojiaqi-legend-stone tiaojiaqi-legend-black" aria-hidden="true">●</span>
            黑方 {counts.black} 子
          </span>
          <span class="tiaojiaqi-legend-item">
            <span class="tiaojiaqi-legend-stone tiaojiaqi-legend-white" aria-hidden="true">○</span>
            白方 {counts.white} 子
          </span>
        </div>
        <p class="tiaojiaqi-board-status">{currentTurnLabel} · 已走 {data.moveCount} 手</p>
        <p class="tiaojiaqi-board-note">
          双方各五子，沿棋盘线移动；形成夹换或挑换时，按提示确定换子结果。二子不挑、独子不夹；最后一子须困在菱形最右尖端。
        </p>
        <p class="board-last-move tiaojiaqi-last-move">
          {lastMoveMessage(data.lastMove, data.blackSeat, data.whiteSeat)}
        </p>
        <p class="sr-only">
          当前棋盘有 {counts.black} 枚黑子和 {counts.white} 枚白子，菱形尖端节点为 {TIAOJIAQI_DIAMOND_APEX}。
          {sideLabel(ownStone ?? 0, data.blackSeat, data.whiteSeat)}
        </p>
      </div>
    </>
  );
}

export type { TiaojiaqiSelectionState };
