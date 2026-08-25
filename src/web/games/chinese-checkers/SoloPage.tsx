import { useMemo, useRef, useState } from "preact/hooks";
import {
  CHINESE_CHECKERS_HOLES,
  createChineseCheckers,
  finishChineseCheckersHop,
  getChineseCheckersCamp,
  getChineseCheckersLegalMoves,
  moveChineseCheckers,
  type ChineseCheckersCamp,
  type ChineseCheckersPlayerId,
  type ChineseCheckersPlayerCount,
  type ChineseCheckersPosition,
  type ChineseCheckersState,
} from "../../../games/chinese-checkers/engine";
import { ProfileMenu } from "../../ProfileMenu";
import { ThemeToggle } from "../../theme";
import type { LocalGamePageProps } from "../catalog";
import "./game.css";

export const CHINESE_CHECKERS_PLAYER_COUNTS = [2, 3, 4] as const;

interface ChineseCheckersPlayerMeta {
  readonly name: string;
  readonly color: string;
  readonly className: string;
  readonly symbol: string;
}

const PLAYER_META: Readonly<
  Record<ChineseCheckersPlayerId, ChineseCheckersPlayerMeta>
> = {
  0: { name: "绯红", color: "珊瑚红", className: "coral", symbol: "●" },
  1: { name: "靛蓝", color: "靛蓝色", className: "indigo", symbol: "◆" },
  2: { name: "青绿", color: "青绿色", className: "teal", symbol: "✦" },
  3: { name: "紫藤", color: "紫藤色", className: "violet", symbol: "✚" },
};

const CAMP_NAMES: Readonly<Record<ChineseCheckersCamp, string>> = {
  0: "北尖角",
  1: "东北尖角",
  2: "东南尖角",
  3: "南尖角",
  4: "西南尖角",
  5: "西北尖角",
};

/** Return how many of a player's ten pieces currently occupy their target. */
export function getChineseCheckersTargetProgress(
  state: ChineseCheckersState,
  playerId: ChineseCheckersPlayerId,
): { readonly filled: number; readonly total: number } {
  const player = state.players.find((candidate) => candidate.id === playerId);
  const target = player === undefined
    ? []
    : getChineseCheckersCamp(player.targetCamp);
  return {
    filled: target.filter((position) => state.pieces[position] === playerId)
      .length,
    total: target.length,
  };
}

function metaFor(playerId: ChineseCheckersPlayerId): ChineseCheckersPlayerMeta {
  return PLAYER_META[playerId];
}

function playerTitle(playerId: ChineseCheckersPlayerId): string {
  return `玩家 ${playerId + 1} · ${metaFor(playerId).name}`;
}

function positionLabel(position: ChineseCheckersPosition): string {
  const [x, y] = position.split(",");
  return `坐标 ${x}，${y}`;
}

function campLabel(camp: ChineseCheckersCamp): string {
  return CAMP_NAMES[camp];
}

function moveLabel(
  state: ChineseCheckersState,
  position: ChineseCheckersPosition,
): string {
  const owner = state.pieces[position];
  if (owner === undefined) return "空棋孔";
  return `${playerTitle(owner)}的棋子`;
}

function turnLabel(state: ChineseCheckersState): string {
  if (state.status === "won" && state.winner !== null) {
    return `${playerTitle(state.winner)}获胜`;
  }
  return `轮到${playerTitle(state.currentPlayer)}`;
}

function jumpCount(state: ChineseCheckersState): number {
  const pathLength = state.activeHop?.path.length ?? 0;
  return Math.max(0, pathLength - 1);
}

function holePositionStyle(hole: (typeof CHINESE_CHECKERS_HOLES)[number]) {
  return {
    left: `${50 + hole.x * 3.6}%`,
    top: `${50 + hole.y * 5.4}%`,
  };
}

export function SoloPage({
  displayName,
  initiallyOpenProfile = false,
  onDisplayNameChange,
}: LocalGamePageProps) {
  const [game, setGame] = useState<ChineseCheckersState>(() =>
    createChineseCheckers(2)
  );
  const [selected, setSelected] = useState<ChineseCheckersPosition | null>(null);
  const [announcement, setAnnouncement] = useState(
    "选择当前玩家的一枚棋子开始走棋。",
  );
  const holeRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const activePosition = game.activeHop?.path.at(-1) ?? null;
  const selectedPosition = activePosition ?? selected;
  const legalMoves = useMemo(
    () => selectedPosition === null
      ? { steps: [] as readonly ChineseCheckersPosition[], jumps: [] as readonly ChineseCheckersPosition[] }
      : getChineseCheckersLegalMoves(game, selectedPosition),
    [game, selectedPosition],
  );
  const legalSteps = useMemo(() => new Set(legalMoves.steps), [legalMoves.steps]);
  const legalJumps = useMemo(() => new Set(legalMoves.jumps), [legalMoves.jumps]);
  const hopPath = useMemo(
    () => new Set(game.activeHop?.path ?? []),
    [game.activeHop],
  );
  const lastPath = useMemo(
    () => new Set(game.lastMove?.path ?? []),
    [game.lastMove],
  );

  const focusHole = (position: ChineseCheckersPosition) => {
    window.setTimeout(() => holeRefs.current[position]?.focus(), 0);
  };

  const announceTurn = (state: ChineseCheckersState, prefix: string) => {
    if (state.status === "won" && state.winner !== null) {
      setAnnouncement(`${prefix}${playerTitle(state.winner)}获胜！可以重新开始。`);
      return;
    }
    setAnnouncement(`${prefix}${turnLabel(state)}，第 ${state.turnNumber} 回合。`);
  };

  const selectPiece = (position: ChineseCheckersPosition) => {
    setSelected(position);
    focusHole(position);
    const moves = getChineseCheckersLegalMoves(game, position);
    const moveCount = moves.steps.length + moves.jumps.length;
    setAnnouncement(
      `${playerTitle(game.currentPlayer)}已选择棋子，${moveCount > 0 ? `有 ${moveCount} 个合法落点` : "当前没有可用落点"}。`,
    );
  };

  const playMove = (
    from: ChineseCheckersPosition,
    to: ChineseCheckersPosition,
  ) => {
    const result = moveChineseCheckers(game, from, to);
    if (!result.moved) {
      setAnnouncement("这不是合法落点，请查看高亮棋孔。 ");
      return;
    }
    setGame(result.state);
    focusHole(to);
    if (result.kind === "jump") {
      setSelected(to);
      const moreJumps = getChineseCheckersLegalMoves(result.state, to).jumps;
      setAnnouncement(
        `已跳跃至${positionLabel(to)}。${moreJumps.length > 0 ? "可以继续跳跃，或结束连跳。" : "这枚棋子暂时没有下一跳，请结束连跳。"}`,
      );
      return;
    }
    setSelected(null);
    announceTurn(result.state, `已单步移动至${positionLabel(to)}。`);
  };

  const handleHoleClick = (position: ChineseCheckersPosition) => {
    if (game.status !== "playing") return;
    const owner = game.pieces[position];

    if (game.activeHop !== null) {
      if (position === activePosition) {
        focusHole(position);
        setAnnouncement("这枚棋子已锁定在连跳中，请选择高亮跳点或结束连跳。 ");
        return;
      }
      if (legalJumps.has(position) && activePosition !== null) {
        playMove(activePosition, position);
      } else {
        setAnnouncement("连跳进行中，只能操作当前锁定棋子或点击结束连跳。 ");
      }
      return;
    }

    if (selectedPosition === null) {
      if (owner === game.currentPlayer) selectPiece(position);
      else setAnnouncement(`请先选择${playerTitle(game.currentPlayer)}的棋子。`);
      return;
    }

    if (owner === game.currentPlayer) {
      if (position === selectedPosition) {
        setSelected(null);
        setAnnouncement("已取消选择，请选择一枚当前玩家的棋子。 ");
      } else {
        selectPiece(position);
      }
      return;
    }

    if (legalSteps.has(position) || legalJumps.has(position)) {
      playMove(selectedPosition, position);
      return;
    }
    setAnnouncement("这不是合法落点，请点击带有高亮的棋孔。 ");
  };

  const restart = (nextPlayerCount: ChineseCheckersPlayerCount = game.playerCount) => {
    const nextGame = createChineseCheckers(nextPlayerCount);
    setGame(nextGame);
    setSelected(null);
    setAnnouncement(`${nextPlayerCount} 人新局已开始，${turnLabel(nextGame)}。`);
  };

  const finishHop = () => {
    if (game.activeHop === null) return;
    const next = finishChineseCheckersHop(game);
    setGame(next);
    setSelected(null);
    announceTurn(next, "连跳已结束。 ");
  };

  const currentPlayer = game.players.find(
    (player) => player.id === game.currentPlayer,
  ) ?? game.players[0];
  const currentMeta = currentPlayer === undefined
    ? PLAYER_META[0]
    : metaFor(currentPlayer.id);
  const lastMove = game.lastMove;

  return (
    <main class="checkers-page">
      <nav class="checkers-topbar" aria-label="游戏导航">
        <a class="checkers-home-link" href="/" aria-label="返回首页">
          <span class="checkers-home-mark" aria-hidden="true">←</span>
          <span>返回首页</span>
        </a>
        <div class="topbar-actions">
          <ProfileMenu
            displayName={displayName}
            initiallyOpen={initiallyOpenProfile}
            onSave={onDisplayNameChange}
          />
          <ThemeToggle />
        </div>
      </nav>

      <header class="checkers-heading">
        <div>
          <p class="eyebrow">同屏桌游 · 六角星棋盘</p>
          <h1>跳棋</h1>
          <p class="checkers-intro">
            轮流把自己的棋子送进对面的尖角营地。支持 2、3、4 人围坐一局。
          </p>
        </div>
        <fieldset class="checkers-player-picker">
          <legend>本局人数</legend>
          <div class="checkers-player-options">
            {CHINESE_CHECKERS_PLAYER_COUNTS.map((count) => (
              <button
                class={`checkers-player-option ${game.playerCount === count ? "is-selected" : ""}`}
                type="button"
                aria-label={`开始 ${count} 人跳棋新局`}
                title={`开始 ${count} 人跳棋新局`}
                aria-pressed={game.playerCount === count}
                onClick={() => restart(count)}
              >
                <strong>{count}</strong>
                <span>人</span>
              </button>
            ))}
          </div>
        </fieldset>
      </header>

      <div class="checkers-layout">
        <section class="checkers-board-column" aria-labelledby="checkers-board-title">
          <div class="checkers-board-heading">
            <div>
              <p class="eyebrow">第 {game.turnNumber} 回合</p>
              <h2 id="checkers-board-title">六角星棋盘</h2>
            </div>
            <div class={`checkers-turn-chip player-${game.currentPlayer}`}>
              <span class={`checkers-mini-symbol ${currentMeta.className}`} aria-hidden="true">
                {currentMeta.symbol}
              </span>
              <span>{game.status === "won" ? "本局结束" : turnLabel(game)}</span>
            </div>
          </div>

          <div
            class={`checkers-board-shell ${game.status === "won" ? "is-won" : ""}`}
            aria-label="121 孔六角星跳棋棋盘"
          >
            <div
              class="checkers-board"
              role="grid"
              aria-label="跳棋棋盘，121 个棋位"
              aria-rowcount={17}
              aria-colcount={25}
            >
              <div class="checkers-board-star" aria-hidden="true" />
              {CHINESE_CHECKERS_HOLES.map((hole, index) => {
                const owner = game.pieces[hole.key];
                const isSelected = selectedPosition === hole.key;
                const isLegalStep = legalSteps.has(hole.key);
                const isLegalJump = legalJumps.has(hole.key);
                const isLastFrom = lastMove?.from === hole.key;
                const isLastTo = lastMove?.to === hole.key;
                const isHopEnd = activePosition === hole.key;
                const isCurrentPiece = owner === game.currentPlayer;
                const focusable = game.status === "playing" &&
                  (isCurrentPiece || isSelected || isLegalStep || isLegalJump);
                const stateText = owner === undefined
                  ? "空棋孔"
                  : `${moveLabel(game, hole.key)}，符号 ${metaFor(owner).symbol}`;
                const actionText = isLegalStep
                  ? "可单步到达"
                  : isLegalJump
                    ? "可跳到达"
                    : isCurrentPiece
                      ? "可选择"
                      : "不可操作";
                return (
                  <button
                    key={hole.key}
                    ref={(element) => {
                      holeRefs.current[hole.key] = element;
                    }}
                    class={`checkers-hole ${hole.camp === null ? "" : `camp-${hole.camp}`} ${owner === undefined ? "is-empty" : `owner-${owner}`} ${isSelected ? "is-selected" : ""} ${isLegalStep ? "is-legal-step" : ""} ${isLegalJump ? "is-legal-jump" : ""} ${isLastFrom ? "is-last-from" : ""} ${isLastTo ? "is-last-to" : ""} ${isHopEnd ? "is-hop-end" : ""} ${hopPath.has(hole.key) ? "is-hop-visited" : ""} ${lastPath.has(hole.key) ? "is-last-path" : ""}`}
                    style={holePositionStyle(hole)}
                    type="button"
                    role="gridcell"
                    aria-label={`第 ${index + 1} 个棋位，${positionLabel(hole.key)}，${stateText}，${actionText}`}
                    aria-pressed={isSelected}
                    tabIndex={focusable ? 0 : -1}
                    disabled={game.status === "won"}
                    onClick={() => handleHoleClick(hole.key)}
                  >
                    {owner === undefined ? null : (
                      <span class={`checkers-piece ${metaFor(owner).className}`} aria-hidden="true">
                        {metaFor(owner).symbol}
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

          <div class="checkers-board-meta">
            <div class="checkers-legend" aria-label="棋子图例">
              <span><i class="checkers-legend-dot is-step" aria-hidden="true">·</i>单步落点</span>
              <span><i class="checkers-legend-dot is-jump" aria-hidden="true">↗</i>跳跃落点</span>
              <span><i class="checkers-legend-dot is-recent" aria-hidden="true">◌</i>最近一步</span>
            </div>
            <p class="checkers-recent-move">
              {lastMove === null
                ? "最近一步：尚未开始"
                : `最近一步：${playerTitle(lastMove.player)} ${positionLabel(lastMove.from)} → ${positionLabel(lastMove.to)}${lastMove.path.length > 2 ? `（${lastMove.path.length - 1} 跳）` : ""}`}
            </p>
          </div>
        </section>

        <aside class="checkers-sidebar" aria-label="跳棋信息与操作">
          <section class={`checkers-turn-panel player-${game.currentPlayer}`} aria-live="polite">
            <div class="checkers-turn-panel-topline">
              <span class={`checkers-turn-symbol ${currentMeta.className}`} aria-hidden="true">{currentMeta.symbol}</span>
              <span>{game.status === "won" ? "胜负已定" : "当前行动"}</span>
            </div>
            <h2>{turnLabel(game)}</h2>
            <p>
              {game.status === "won"
                ? "对面营地已全部占满。"
                : game.activeHop !== null
                  ? `连跳进行中 · 已跳 ${jumpCount(game)} 次`
                  : "选择一枚棋子，棋盘会标出合法落点。"}
            </p>
          </section>

          <section class="checkers-players" aria-labelledby="checkers-players-title">
            <div class="checkers-section-heading">
              <div>
                <p class="eyebrow">玩家状态</p>
                <h2 id="checkers-players-title">本局玩家</h2>
              </div>
              <span class="checkers-player-count">{game.playerCount} 人</span>
            </div>
            <div class="checkers-player-cards">
              {game.players.map((player) => {
                const meta = metaFor(player.id);
                const progress = getChineseCheckersTargetProgress(game, player.id);
                const isCurrent = game.status === "playing" && player.id === game.currentPlayer;
                const isWinner = game.status === "won" && game.winner === player.id;
                const progressPercent = progress.total === 0
                  ? 0
                  : Math.round((progress.filled / progress.total) * 100);
                return (
                  <div
                    key={player.id}
                    class={`checkers-player-card ${meta.className} ${isCurrent ? "is-current" : ""} ${isWinner ? "is-winner" : ""}`}
                    aria-label={`${playerTitle(player.id)}，${isCurrent ? "当前行动" : isWinner ? "获胜" : "等待行动"}`}
                  >
                    <div class="checkers-player-card-heading">
                      <span class={`checkers-player-symbol ${meta.className}`} aria-hidden="true">{meta.symbol}</span>
                      <div>
                        <strong>{playerTitle(player.id)}</strong>
                        <small>{meta.color} · 目标：{campLabel(player.targetCamp)}</small>
                      </div>
                      <span class="checkers-player-status">
                        {isCurrent ? "当前" : isWinner ? "获胜" : "等待"}
                      </span>
                    </div>
                    <div class="checkers-progress" aria-label={`目标营地进度 ${progress.filled} / ${progress.total}`}>
                      <span class="checkers-progress-track"><span style={{ width: `${progressPercent}%` }} /></span>
                      <small>{progress.filled} / {progress.total} 入营</small>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <div class="checkers-actions">
            <button
              class="primary-button"
              type="button"
              aria-label="重新开始当前人数的跳棋"
              onClick={() => restart()}
            >
              重新开始
            </button>
            <button
              class="secondary-button"
              type="button"
              aria-label="结束当前棋子的连跳"
              disabled={game.activeHop === null || game.status === "won"}
              onClick={finishHop}
            >
              结束连跳
            </button>
          </div>

          <section class="checkers-rules" aria-labelledby="checkers-rules-title">
            <p class="eyebrow">快速规则</p>
            <h2 id="checkers-rules-title">三步上手</h2>
            <ol>
              <li>点击当前玩家棋子，再点击高亮棋孔。</li>
              <li>相邻空孔可单步；隔着任意棋子可跳跃。</li>
              <li>跳跃可连续进行，结束连跳后交给下一位。</li>
            </ol>
            <p>先把自己的 10 枚棋子全部送入对面尖角营地即可获胜。</p>
          </section>
        </aside>
      </div>

      <div class="checkers-live-region" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </main>
  );
}
