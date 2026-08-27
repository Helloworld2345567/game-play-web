import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  createTankBattle,
  fireTankBattle,
  moveTankBattle,
  pauseTankBattle,
  resumeTankBattle,
  startTankBattle,
  tankBattleCellState,
  tickTankBattle,
  TANK_BATTLE_BOARD_SIZE,
  type TankBattleDirection,
  type TankBattleState,
} from "../../../games/tank-battle/engine";
import { ProfileMenu } from "../../ProfileMenu";
import { ThemeToggle } from "../../theme";
import "./game.css";

const DIRECTION_BUTTONS: ReadonlyArray<{
  direction: TankBattleDirection;
  label: string;
  symbol: string;
}> = [
  { direction: "up", label: "向上移动", symbol: "↑" },
  { direction: "left", label: "向左移动", symbol: "←" },
  { direction: "down", label: "向下移动", symbol: "↓" },
  { direction: "right", label: "向右移动", symbol: "→" },
];

function directionForKey(key: string): TankBattleDirection | null {
  const directions: Readonly<Record<string, TankBattleDirection>> = {
    ArrowUp: "up",
    ArrowDown: "down",
    ArrowLeft: "left",
    ArrowRight: "right",
    w: "up",
    s: "down",
    a: "left",
    d: "right",
  };
  return directions[key] ?? directions[key.toLowerCase()] ?? null;
}

function statusMessage(game: TankBattleState): string {
  if (game.status === "ready") return "方向键或 WASD 移动，空格发射炮弹";
  if (game.status === "playing") return "摧毁全部敌方坦克即可获胜";
  if (game.status === "paused") return "战斗已暂停";
  if (game.status === "won") return "敌军已清除，战斗胜利！";
  return "你的坦克被击中，战斗结束";
}

function cellLabel(game: TankBattleState, x: number, y: number): string {
  const labels: Readonly<Record<ReturnType<typeof tankBattleCellState>, string>> = {
    wall: "砖墙",
    player: "你的坦克",
    enemy: "敌方坦克",
    "player-shell": "你的炮弹",
    "enemy-shell": "敌方炮弹",
    empty: "空地",
  };
  return `第 ${y + 1} 行第 ${x + 1} 列，${labels[tankBattleCellState(game, { x, y })]}`;
}

export function SoloPage({
  displayName,
  initiallyOpenProfile = false,
  onDisplayNameChange,
}: {
  displayName: string;
  initiallyOpenProfile?: boolean;
  onDisplayNameChange(displayName: string): void;
}) {
  const [game, setGame] = useState<TankBattleState>(createTankBattle);
  const boardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (game.status !== "playing") return;
    const timer = window.setInterval(() => {
      setGame((current) => tickTankBattle(current));
    }, 280);
    return () => window.clearInterval(timer);
  }, [game.status]);

  const pauseForBackground = useCallback(() => {
    setGame((current) => pauseTankBattle(current));
  }, []);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") pauseForBackground();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("blur", pauseForBackground);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("blur", pauseForBackground);
    };
  }, [pauseForBackground]);

  const move = useCallback((direction: TankBattleDirection) => {
    setGame((current) => moveTankBattle(startTankBattle(current), direction));
    window.setTimeout(() => boardRef.current?.focus(), 0);
  }, []);

  const fire = useCallback(() => {
    setGame((current) => fireTankBattle(startTankBattle(current)));
    window.setTimeout(() => boardRef.current?.focus(), 0);
  }, []);

  const togglePause = useCallback(() => {
    setGame((current) => {
      if (current.status === "ready") return startTankBattle(current);
      if (current.status === "playing") return pauseTankBattle(current);
      if (current.status === "paused") return resumeTankBattle(current);
      return current;
    });
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || /^(?:A|BUTTON|INPUT|SELECT|TEXTAREA)$/u.test(target.tagName))
      ) return;
      const direction = directionForKey(event.key);
      if (direction !== null) {
        event.preventDefault();
        move(direction);
        return;
      }
      if (event.key === " " || event.key === "Spacebar") {
        event.preventDefault();
        fire();
        return;
      }
      if (event.key.toLowerCase() === "p") {
        event.preventDefault();
        togglePause();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [fire, move, togglePause]);

  const restart = () => {
    setGame(createTankBattle());
    window.setTimeout(() => boardRef.current?.focus(), 0);
  };

  const canControlTank = game.status === "ready" || game.status === "playing";

  return (
    <main class="tank-battle-page">
      <nav class="tank-battle-topbar">
        <a class="secondary-button tank-battle-home-link" href="/">返回首页</a>
        <div class="topbar-actions">
          <ProfileMenu
            displayName={displayName}
            initiallyOpen={initiallyOpenProfile}
            onSave={onDisplayNameChange}
          />
          <ThemeToggle />
        </div>
      </nav>

      <header class="tank-battle-header">
        <div>
          <p class="eyebrow">单人 · 本机对战 · 13×13</p>
          <h1>坦克大战</h1>
          <p class="tank-battle-status" aria-live="polite">{statusMessage(game)}</p>
        </div>
        <div class="tank-battle-score-cards" aria-label="本局统计">
          <div class="tank-battle-score-card"><small>得分</small><strong>{game.score}</strong></div>
          <div class="tank-battle-score-card"><small>敌军</small><strong>{game.enemies.length}</strong></div>
          <div class="tank-battle-score-card"><small>状态</small><strong>{game.status === "won" ? "胜利" : game.status === "over" ? "结束" : game.status === "paused" ? "暂停" : "战斗中"}</strong></div>
        </div>
      </header>

      <section class="tank-battle-play-area" aria-label="坦克大战游戏区">
        <div
          ref={boardRef}
          class={`tank-battle-board tank-battle-status-${game.status}`}
          role="grid"
          aria-label="坦克大战地图，13 行 13 列"
          aria-rowcount={TANK_BATTLE_BOARD_SIZE}
          aria-colcount={TANK_BATTLE_BOARD_SIZE}
          tabIndex={0}
        >
          {Array.from({ length: TANK_BATTLE_BOARD_SIZE }, (_, y) => (
            <div class="tank-battle-row" key={y} role="row">
              {Array.from({ length: TANK_BATTLE_BOARD_SIZE }, (_, x) => {
                const state = tankBattleCellState(game, { x, y });
                const direction = state === "player" ? game.player.direction : game.enemies.find((enemy) => enemy.x === x && enemy.y === y)?.direction;
                return (
                  <div
                    class={`tank-battle-cell tank-battle-cell-${state}`}
                    data-direction={direction}
                    key={x}
                    role="gridcell"
                    aria-colindex={x + 1}
                    aria-label={cellLabel(game, x, y)}
                  ><span aria-hidden="true" /></div>
                );
              })}
            </div>
          ))}
        </div>

        <div class="tank-battle-controls">
          <div class="tank-battle-direction-pad" aria-label="移动方向">
            {DIRECTION_BUTTONS.map((button) => (
              <button
                class={`tank-battle-direction tank-battle-direction-${button.direction}`}
                type="button"
                key={button.direction}
                aria-label={button.label}
                disabled={!canControlTank}
                onClick={() => move(button.direction)}
              >{button.symbol}</button>
            ))}
          </div>
          <div class="tank-battle-action-buttons">
            <button class="primary-button" type="button" disabled={!canControlTank} onClick={fire}>发射炮弹</button>
            <button class="secondary-button" type="button" disabled={game.status === "over" || game.status === "won"} onClick={togglePause}>{game.status === "paused" ? "继续战斗" : "暂停"}</button>
            <button class="secondary-button" type="button" onClick={restart}>重新开始</button>
          </div>
        </div>
        <p class="tank-battle-instructions">使用方向键或 WASD 驾驶坦克，空格键发射炮弹，P 键暂停。敌方坦克会移动并开火，砖墙可以掩护你。</p>
      </section>
    </main>
  );
}
