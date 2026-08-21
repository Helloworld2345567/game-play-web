import {
  Component,
  Fragment,
  type ComponentChildren,
  type FunctionComponent,
} from "preact";
import { useEffect, useState } from "preact/hooks";
import type {
  JsonValue,
  RuleOutcome,
  RulePosition,
} from "../../core/game-rules";
import type { GameActionCommand, RoomSnapshot } from "../../shared/protocol";
import { readGomokuPosition } from "../../games/gomoku/rules";
import { readPublicDuelPosition } from "../../games/minesweeper/duel-rules";
import { readPublicRacePosition } from "../../games/minesweeper/race-rules";
import { readTicTacToePosition } from "../../games/tictactoe/rules";
import { readXiangqiPosition } from "../../games/xiangqi/rules";
import {
  getClientGameRendererLoader,
  type ClientGameRenderer,
  type ClientGameRendererLoader,
} from "./catalog";

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
  pendingCells?: ReadonlySet<string>;
  onAction(payload: JsonValue): void;
}

export interface GameAdapter {
  readonly gameType: string;
  readonly ruleSetId: string;
  readonly displayName: string;
  readonly landingLabel?: string;
  readonly createRoomLabel: string;
  readonly landingDescription: string;
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

interface GameErrorBoundaryProps {
  gameName: string;
  children: ComponentChildren;
}

interface GameErrorBoundaryState {
  hasError: boolean;
  retryKey: number;
}

/**
 * Render failures are contained at the game seam.  We intentionally expose a
 * generic recovery action and never put exception details into the page.
 */
export class GameErrorBoundary extends Component<
  GameErrorBoundaryProps,
  GameErrorBoundaryState
> {
  constructor(props: GameErrorBoundaryProps) {
    super(props);
  }

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
};

const GOMOKU_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  "gomoku.not_your_turn": "还没轮到你。",
  "gomoku.occupied": "这个交叉点已经有棋子。",
  "gomoku.out_of_bounds": "落点超出棋盘。",
  "gomoku.game_finished": "本局已经结束。",
  "gomoku.invalid_action": "无法识别这次落子。",
};

const XIANGQI_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  "xiangqi.not_your_turn": "还没轮到你。",
  "xiangqi.invalid_action": "无法识别这次走子。",
  "xiangqi.invalid_position": "棋局数据无效，请刷新后重试。",
  "xiangqi.out_of_bounds": "落点超出棋盘。",
  "xiangqi.empty_source": "这里没有可以移动的棋子。",
  "xiangqi.not_your_piece": "这不是你的棋子。",
  "xiangqi.own_piece": "目标位置已有己方棋子。",
  "xiangqi.illegal_move": "这一步不符合中国象棋走法。",
  "xiangqi.self_check": "这一步会让自己的将帅处于被将军状态。",
  "xiangqi.cannot_capture_general": "中国象棋不能直接吃掉将帅。",
  "xiangqi.game_finished": "本局已经结束。",
};

const TIC_TAC_TOE_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  "tictactoe.not_your_turn": "还没轮到你。",
  "tictactoe.occupied": "这个格子已经有标记。",
  "tictactoe.out_of_bounds": "落点超出棋盘。",
  "tictactoe.game_finished": "本局已经结束。",
  "tictactoe.invalid_action": "无法识别这次落子。",
};

const MINESWEEPER_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  "minesweeper.game_finished": "本局已经结束。",
  "minesweeper.not_a_player": "观众不能操作棋盘。",
  "minesweeper.already_ready": "本局已经准备完成。",
  "minesweeper.not_selecting": "现在不能选择起始格。",
  "minesweeper.countdown_active": "倒计时结束后再选择起始格。",
  "minesweeper.out_of_bounds": "目标格超出雷区。",
  "minesweeper.start_already_selected": "你已经提交了起始格。",
  "minesweeper.not_playing": "双方选择起始格后才能开始排雷。",
  "minesweeper.flagged": "请先取消自己的旗帜再揭开。",
  "minesweeper.invalid_action": "无法识别这次扫雷操作。",
};

const CHASE_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  "chase.game_finished": "本局已经结束。",
  "chase.not_your_turn": "还没轮到你。",
  "chase.not_a_player": "观众不能操作棋盘。",
  "chase.invalid_action": "无法识别这次走子。",
  "chase.invalid_position": "棋局数据无效，请刷新后重试。",
  "chase.occupied": "不能走到对方所在的节点。",
  "chase.illegal_move": "只能沿地图上的边走一步。",
  "chase.not_adjacent": "只能沿地图上的边走一步。",
  "chase.out_of_bounds": "目标节点不存在。",
};

const MINESWEEPER_RACE_RULE_SET_IDS = [
  "minesweeper.race.9x9x10.v1",
  "minesweeper.race.16x16x40.v1",
  "minesweeper.race.30x16x99.v1",
] as const;

const MINESWEEPER_DUEL_RULE_SET_IDS = [
  "minesweeper.duel.9x9x10.v1",
  "minesweeper.duel.16x16x40.v1",
  "minesweeper.duel.30x16x99.v1",
] as const;

function minesweeperPendingCellKey(
  command: GameActionCommand,
): string | null {
  if (
    command.gameType !== "minesweeper" ||
    typeof command.payload !== "object" ||
    command.payload === null ||
    Array.isArray(command.payload) ||
    !Number.isInteger(command.payload.x) ||
    !Number.isInteger(command.payload.y)
  ) {
    return null;
  }
  return `${String(command.payload.x)},${String(command.payload.y)}`;
}

function chasePendingCellKey(command: GameActionCommand): string | null {
  if (
    command.gameType !== "chase" ||
    typeof command.payload !== "object" ||
    command.payload === null ||
    Array.isArray(command.payload) ||
    command.payload.type !== "move" ||
    typeof command.payload.to !== "string"
  ) {
    return null;
  }
  return `move:${command.payload.to}`;
}

interface ChasePositionData {
  readonly thiefSeat: PlatformSeatId | null;
  readonly policeSeat: PlatformSeatId | null;
  readonly thiefNode: string | null;
  readonly policeNode: string | null;
  readonly moveCount: number | null;
  readonly optimalRounds: number | null;
  readonly maxRounds: number | null;
}

function readChasePositionData(position: RulePosition | null): ChasePositionData {
  const data = position?.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return {
      thiefSeat: null,
      policeSeat: null,
      thiefNode: null,
      policeNode: null,
      moveCount: null,
      optimalRounds: null,
      maxRounds: null,
    };
  }
  const record = data as Record<string, unknown>;
  const asSeat = (value: unknown): PlatformSeatId | null =>
    value === "seat-a" || value === "seat-b" ? value : null;
  const asString = (value: unknown): string | null =>
    typeof value === "string" ? value : null;
  const asInteger = (value: unknown): number | null =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? value
      : null;
  return {
    thiefSeat: asSeat(record.thiefSeat),
    policeSeat: asSeat(record.policeSeat),
    thiefNode: asString(record.thiefNode),
    policeNode: asString(record.policeNode),
    moveCount: asInteger(record.moveCount ?? record.ply),
    optimalRounds: asInteger(record.optimalRounds),
    maxRounds: asInteger(record.maxRounds ?? record.roundLimit),
  };
}

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

function requiredRendererLoader(
  gameType: string,
  ruleSetId: string,
): ClientGameRendererLoader {
  const loader = getClientGameRendererLoader(gameType, ruleSetId);
  if (loader === null) {
    // This is a programmer/configuration invariant, not a protocol error.
    // Runtime protocol values go through getGameAdapter and fail closed.
    throw new Error(`Missing renderer allowlist entry: ${gameType}/${ruleSetId}`);
  }
  return loader;
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
  metadata: Omit<GameAdapter, "Renderer" | "loadRenderer">,
): GameAdapter {
  const loadRenderer = requiredRendererLoader(
    metadata.gameType,
    metadata.ruleSetId,
  );
  return {
    ...metadata,
    loadRenderer,
    Renderer: createLazyRenderer(loadRenderer),
  };
}

export const gomokuAdapter = dynamicAdapter({
  gameType: "gomoku",
  ruleSetId: "gomoku.freestyle15.v1",
  displayName: "自由五子棋",
  landingLabel: "五子棋",
  createRoomLabel: "创建五子棋房",
  landingDescription: "15×15 · 黑先 · 连五获胜",
  getSeatPresentations(position) {
    const blackSeat =
      position === null ? "seat-a" : readGomokuPosition(position).blackSeat;
    const seatABlack = blackSeat === "seat-a";
    return {
      "seat-a": {
        label: seatABlack ? "黑方" : "白方",
        swatchClassName: seatABlack ? "black" : "white",
      },
      "seat-b": {
        label: seatABlack ? "白方" : "黑方",
        swatchClassName: seatABlack ? "white" : "black",
      },
    };
  },
  getErrorMessage(code) {
    return GOMOKU_ERROR_MESSAGES[code] ?? null;
  },
});

export const xiangqiAdapter = dynamicAdapter({
  gameType: "xiangqi",
  ruleSetId: "xiangqi.casual.v1",
  displayName: "中国象棋",
  createRoomLabel: "创建中国象棋房",
  landingDescription: "9×10 · 红先 · 将死或困毙",
  getSeatPresentations(position) {
    const redSeat =
      position === null ? "seat-a" : readXiangqiPosition(position).redSeat;
    const seatARed = redSeat === "seat-a";
    return {
      "seat-a": {
        label: seatARed ? "红方" : "黑方",
        swatchClassName: seatARed ? "xiangqi-red" : "xiangqi-black",
      },
      "seat-b": {
        label: seatARed ? "黑方" : "红方",
        swatchClassName: seatARed ? "xiangqi-black" : "xiangqi-red",
      },
    };
  },
  getErrorMessage(code) {
    return XIANGQI_ERROR_MESSAGES[code] ?? null;
  },
  getOutcomeMessage(outcome, viewer) {
    if (outcome.kind !== "win" || outcome.reason !== "checkmate") return null;
    if (viewer.selfSeat === null) {
      return viewer.winnerDisplayName === null
        ? "本局以绝杀结束"
        : `${viewer.winnerDisplayName}绝杀获胜`;
    }
    return outcome.winner === viewer.selfSeat
      ? "绝杀 · 你赢了"
      : "对手绝杀获胜";
  },
});

export const ticTacToeAdapter = dynamicAdapter({
  gameType: "tictactoe",
  ruleSetId: "tictactoe.classic3.v1",
  displayName: "井字棋",
  createRoomLabel: "创建井字棋房",
  landingDescription: "3×3 · X 先 · 三连获胜",
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
    return TIC_TAC_TOE_ERROR_MESSAGES[code] ?? null;
  },
});

function minesweeperSeatPresentations(): SeatPresentations {
  return {
    "seat-a": { label: "玩家 A", swatchClassName: "minesweeper-a" },
    "seat-b": { label: "玩家 B", swatchClassName: "minesweeper-b" },
  };
}

function createMinesweeperRaceAdapter(
  ruleSetId: string,
  displayName: string,
  landingDescription: string,
): GameAdapter {
  return dynamicAdapter({
    gameType: "minesweeper",
    ruleSetId,
    displayName,
    createRoomLabel: displayName,
    landingDescription,
    getPendingCellKey: minesweeperPendingCellKey,
    getSeatPresentations: minesweeperSeatPresentations,
    getErrorMessage(code) {
      return MINESWEEPER_ERROR_MESSAGES[code] ?? null;
    },
    getStatusMessage(position, selfSeat) {
      const data = readPublicRacePosition(position);
      if (position.outcome !== null) return "本局已结束";
      if (selfSeat === null) return "正在观战扫雷竞速";
      if (data.phase === "waiting_ready") return "等待双方准备";
      if (data.phase === "countdown") return "竞速即将开始";
      if (data.phase === "playing") return "扫雷竞速进行中";
      return "本局已结束";
    },
    getOutcomeMessage(outcome, viewer) {
      if (outcome.kind === "draw") return "本局和局";
      if (viewer.selfSeat === null) {
        return viewer.winnerDisplayName === null
          ? "扫雷竞速已经结束"
          : `${viewer.winnerDisplayName}赢得竞速`;
      }
      const won = outcome.winner === viewer.selfSeat;
      if (outcome.reason === "opponent_hit_mine") {
        return won ? "对手踩雷，你赢了" : "你踩到雷，对手获胜";
      }
      if (outcome.reason === "race_completed") {
        return won ? "你先完成，赢得竞速" : "对手先完成";
      }
      return won ? "你赢了" : "对手获胜";
    },
  });
}

function createMinesweeperDuelAdapter(
  ruleSetId: string,
  displayName: string,
  createRoomLabel: string,
  landingDescription: string,
): GameAdapter {
  return dynamicAdapter({
    gameType: "minesweeper",
    ruleSetId,
    displayName,
    createRoomLabel,
    landingDescription,
    getPendingCellKey: minesweeperPendingCellKey,
    getSeatPresentations: minesweeperSeatPresentations,
    getErrorMessage(code) {
      return MINESWEEPER_ERROR_MESSAGES[code] ?? null;
    },
    getStatusMessage(position, selfSeat) {
      const data = readPublicDuelPosition(position);
      if (position.outcome !== null) return "本局已结束";
      if (selfSeat === null) return "正在观战双人扫雷";
      if (data.phase === "waiting_ready") return "等待双方准备";
      if (data.phase === "countdown") return "倒计时后选择起始格";
      if (data.phase === "selecting") return "等待双方提交起始格";
      if (data.phase === "playing") return "双方同时排雷";
      return "本局已结束";
    },
    getOutcomeMessage(outcome, viewer) {
      if (outcome.kind === "draw") return "本局同分，和局";
      if (viewer.selfSeat === null) {
        return viewer.winnerDisplayName === null
          ? "本局已分胜负"
          : `${viewer.winnerDisplayName}获胜`;
      }
      return outcome.winner === viewer.selfSeat ? "你赢了" : "对手获胜";
    },
  });
}

export const minesweeperRaceAdapters = [
  createMinesweeperRaceAdapter(
    MINESWEEPER_RACE_RULE_SET_IDS[0],
    "双人扫雷竞速 · 小型",
    "9×9 · 10 雷 · 同图独立竞速",
  ),
  createMinesweeperRaceAdapter(
    MINESWEEPER_RACE_RULE_SET_IDS[1],
    "双人扫雷竞速 · 中型",
    "16×16 · 40 雷 · 同图独立竞速",
  ),
  createMinesweeperRaceAdapter(
    MINESWEEPER_RACE_RULE_SET_IDS[2],
    "双人扫雷竞速 · 大型",
    "30×16 · 99 雷 · 桌面完整显示",
  ),
] as const;

export const minesweeperDuelAdapters = [
  createMinesweeperDuelAdapter(
    MINESWEEPER_DUEL_RULE_SET_IDS[0],
    "双人扫雷 · 小型",
    "双人扫雷 · 小型",
    "9×9 · 10 雷 · 双方同时操作",
  ),
  createMinesweeperDuelAdapter(
    MINESWEEPER_DUEL_RULE_SET_IDS[1],
    "双人扫雷 · 中型",
    "双人扫雷 · 中型",
    "16×16 · 40 雷 · 双方同时操作",
  ),
  createMinesweeperDuelAdapter(
    MINESWEEPER_DUEL_RULE_SET_IDS[2],
    "双人扫雷 · 大型",
    "双人扫雷 · 大型",
    "30×16 · 99 雷 · 桌面完整显示",
  ),
] as const;

const CHASE_RULE_SET_IDS = [
  "chase.easy.v1",
  "chase.medium.v1",
  "chase.hard.v1",
] as const;

const CHASE_DIFFICULTIES = [
  {
    ruleSetId: CHASE_RULE_SET_IDS[0],
    displayName: "警察抓小偷 · 简单",
    landingDescription: "初始地图 · 上限15轮",
  },
  {
    ruleSetId: CHASE_RULE_SET_IDS[1],
    displayName: "警察抓小偷 · 中等",
    landingDescription: "中型闭环 · 上限25轮",
  },
  {
    ruleSetId: CHASE_RULE_SET_IDS[2],
    displayName: "警察抓小偷 · 困难",
    landingDescription: "大型闭环 · 上限45轮",
  },
] as const;

function chaseSeatPresentations(
  position: RulePosition | null,
): SeatPresentations {
  const data = readChasePositionData(position);
  const thiefSeat = data.thiefSeat ?? "seat-a";
  return {
    "seat-a": {
      label: thiefSeat === "seat-a" ? "小偷" : "警察",
      swatchClassName: thiefSeat === "seat-a" ? "chase-thief" : "chase-police",
    },
    "seat-b": {
      label: thiefSeat === "seat-b" ? "小偷" : "警察",
      swatchClassName: thiefSeat === "seat-b" ? "chase-thief" : "chase-police",
    },
  };
}

function chaseRoleForSeat(
  data: ChasePositionData,
  seat: string | null,
): "小偷" | "警察" | null {
  if (seat !== null && seat === data.thiefSeat) return "小偷";
  if (seat !== null && seat === data.policeSeat) return "警察";
  return null;
}

function createChaseAdapter(
  ruleSetId: string,
  displayName: string,
  landingDescription: string,
): GameAdapter {
  return dynamicAdapter({
    gameType: "chase",
    ruleSetId,
    displayName,
    landingLabel: "警察抓小偷",
    createRoomLabel: `创建${displayName}房`,
    landingDescription,
    getPendingCellKey: chasePendingCellKey,
    getSeatPresentations: chaseSeatPresentations,
    getErrorMessage(code) {
      return CHASE_ERROR_MESSAGES[code] ?? null;
    },
    getStatusMessage(position, selfSeat) {
      const data = readChasePositionData(position);
      if (position.outcome !== null) return "本局已结束";
      if (selfSeat === null) return "正在观战警察抓小偷";
      const role = chaseRoleForSeat(data, selfSeat);
      const moveText = data.moveCount === null
        ? ""
        : ` · 第 ${data.moveCount} 步`;
      if (position.turn === selfSeat) {
        return `轮到你${role === null ? "" : `（${role}）`}${moveText}`;
      }
      const turnRole = chaseRoleForSeat(data, position.turn);
      return `等待${turnRole ?? "对手"}走子${moveText}`;
    },
    getOutcomeMessage(outcome, viewer) {
      if (outcome.kind !== "win") return null;
      const result = outcome.reason === "thief_survived"
        ? "小偷撑过回合上限"
        : outcome.reason === "police_caught_thief"
          ? "警察抓获小偷"
          : null;
      if (result === null) return null;
      if (viewer.selfSeat === null) {
        return viewer.winnerDisplayName === null
          ? result
          : `${viewer.winnerDisplayName}（${result}）`;
      }
      return outcome.winner === viewer.selfSeat
        ? `${result} · 你赢了`
        : `${result} · 对手获胜`;
    },
  });
}

export const chaseAdapters = CHASE_DIFFICULTIES.map((difficulty) =>
  createChaseAdapter(
    difficulty.ruleSetId,
    difficulty.displayName,
    difficulty.landingDescription,
  ),
) as readonly GameAdapter[];

export const availableGameAdapters: readonly GameAdapter[] = [
  gomokuAdapter,
  xiangqiAdapter,
  ticTacToeAdapter,
  ...minesweeperRaceAdapters,
  ...minesweeperDuelAdapters,
  ...chaseAdapters,
];

const adaptersByRuleSetId = new Map<string, GameAdapter>(
  availableGameAdapters.map((adapter) => [adapter.ruleSetId, adapter]),
);

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
