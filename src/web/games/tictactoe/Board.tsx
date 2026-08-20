import { readTicTacToePosition } from "../../../games/tictactoe/rules";
import type { GameAdapter, GameRendererProps } from "../registry";

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  "tictactoe.not_your_turn": "还没轮到你。",
  "tictactoe.occupied": "这个格子已经有标记。",
  "tictactoe.out_of_bounds": "落点超出棋盘。",
  "tictactoe.game_finished": "本局已经结束。",
  "tictactoe.invalid_action": "无法识别这次落子。",
};

export function TicTacToeBoard({
  position,
  selfSeat,
  disabled,
  pending,
  onAction,
}: GameRendererProps) {
  const data = readTicTacToePosition(position);
  const ownMark =
    selfSeat === data.xSeat ? 1 : selfSeat === data.oSeat ? 2 : null;
  const canInteract =
    !disabled &&
    !pending &&
    ownMark !== null &&
    position.turn === selfSeat &&
    position.outcome === null;
  const winningCells = new Set(
    data.winningLine?.map(({ x, y }) => `${x},${y}`) ?? [],
  );

  return (
    <>
      <div class="board-shell tictactoe-board-shell">
        <div
          class="tictactoe-board"
          role="grid"
          aria-label="井字棋棋盘，三行三列"
          aria-describedby="tictactoe-board-instructions tictactoe-last-move"
        >
          {Array.from({ length: 3 }, (_, y) => (
            <div class="tictactoe-row" role="row" key={y}>
              {Array.from({ length: 3 }, (_, x) => {
                const index = y * 3 + x;
                const mark = data.board[index] ?? 0;
                const state = mark === 1 ? "x" : mark === 2 ? "o" : "empty";
                const available = canInteract && mark === 0;
                return (
                  <button
                    key={x}
                    type="button"
                    role="gridcell"
                    class={`tictactoe-cell${
                      winningCells.has(`${x},${y}`) ? " is-winning" : ""
                    }${data.lastMove?.x === x && data.lastMove.y === y ? " is-last" : ""}`}
                    data-cell={`${x},${y}`}
                    data-state={state}
                    disabled={!available}
                    aria-label={`第 ${y + 1} 行第 ${x + 1} 列，${
                      mark === 1 ? "X" : mark === 2 ? "O" : "空格"
                    }`}
                    onClick={() => {
                      if (available) onAction({ type: "place", x, y });
                    }}
                  >
                    <span aria-hidden="true">{mark === 1 ? "×" : mark === 2 ? "○" : ""}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <p id="tictactoe-board-instructions" class="sr-only">
          选择空格落子。X 先手，双方轮流，横、竖或斜线连成三个标记获胜。
        </p>
      </div>
      <p id="tictactoe-last-move" class="board-last-move" aria-live="polite">
        {data.lastMove === null
          ? "井字棋最近一手：尚未落子。"
          : `井字棋最近一手：${data.lastMove.mark === 1 ? "X" : "O"} 落在第 ${data.lastMove.y + 1} 行第 ${data.lastMove.x + 1} 列。`}
      </p>
    </>
  );
}

export const ticTacToeAdapter = {
  gameType: "tictactoe",
  ruleSetId: "tictactoe.classic3.v1",
  displayName: "井字棋",
  createRoomLabel: "创建井字棋房",
  landingDescription: "3×3 · X 先 · 三连获胜",
  Renderer: TicTacToeBoard,
  getSeatPresentations(position) {
    const xSeat = position === null
      ? "seat-a"
      : readTicTacToePosition(position).xSeat;
    const seatAX = xSeat === "seat-a";
    return {
      "seat-a": {
        label: seatAX ? "X 方" : "O 方",
        swatchClassName: seatAX ? "tictactoe-x" : "tictactoe-o",
      },
      "seat-b": {
        label: seatAX ? "O 方" : "X 方",
        swatchClassName: seatAX ? "tictactoe-o" : "tictactoe-x",
      },
    };
  },
  getErrorMessage(code) {
    return ERROR_MESSAGES[code] ?? null;
  },
} satisfies GameAdapter;
