import {
  ArrowLeft,
  Pause,
  Play,
  RotateCcw,
  Volume2,
  VolumeX,
} from "lucide-preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  createStackGame,
  placeStackGame,
  stackGameMissSide,
  startStackGame,
  tickStackGame,
  type StackGameBlock,
  type StackGameSlice,
  type StackGameState,
} from "../../../games/stack-game/engine";
import {
  StackScene,
  type StackBlockVisual,
  type StackFragmentVisual,
} from "./StackScene";
import { StackSound } from "./sound";
import "./game.css";

const BEST_SCORE_KEY = "stack-game-best-v1";
const SOUND_ENABLED_KEY = "stack-game-sound-enabled-v1";
const BLOCK_VISUAL_CACHE = new WeakMap<
  readonly StackGameBlock[],
  readonly StackBlockVisual[]
>();

function readStoredBest(): number {
  try {
    const value = Number.parseInt(localStorage.getItem(BEST_SCORE_KEY) ?? "0", 10);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function readStoredSoundPreference(): boolean {
  try {
    return localStorage.getItem(SOUND_ENABLED_KEY) !== "0";
  } catch {
    return true;
  }
}

function blockVisual(block: StackGameBlock, kind: "block" | "active"): StackBlockVisual {
  return {
    id: `${kind}-${block.layer}`,
    level: block.layer,
    x: block.centerX,
    z: block.centerZ,
    width: block.width,
    depth: block.depth,
  };
}

function fragmentVisual(slice: StackGameSlice, index: number): StackFragmentVisual {
  return {
    ...blockVisual(slice.block, "block"),
    id: `fragment-${slice.block.layer}-${slice.side}-${index}`,
    axis: slice.axis,
    side: slice.side,
  };
}

function placedBlockVisuals(
  blocks: readonly StackGameBlock[],
): readonly StackBlockVisual[] {
  const cached = BLOCK_VISUAL_CACHE.get(blocks);
  if (cached !== undefined) return cached;
  const visuals = blocks.map((block) => blockVisual(block, "block"));
  BLOCK_VISUAL_CACHE.set(blocks, visuals);
  return visuals;
}

function syncScene(scene: StackScene | null, game: StackGameState): void {
  if (scene === null) return;
  const active = game.active !== null && game.status !== "over"
    ? blockVisual(game.active, "active")
    : null;
  scene.sync(placedBlockVisuals(game.blocks), active);
}

function stageLabel(game: StackGameState, paused: boolean): string {
  if (paused) return `叠叠高游戏区，已暂停，当前 ${game.score} 层`;
  if (game.status === "ready") return "叠叠高游戏区，轻触开始";
  if (game.status === "over") return `叠叠高游戏区，本局结束，共 ${game.score} 层`;
  return `叠叠高游戏区，当前 ${game.score} 层，按下落块`;
}

function vibrate(pattern: number | number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // Haptics are an optional enhancement and may be blocked by the browser.
  }
}

export function SoloPage() {
  const [game, setGame] = useState<StackGameState>(createStackGame);
  const [bestScore, setBestScore] = useState(readStoredBest);
  const [soundEnabled, setSoundEnabled] = useState(readStoredSoundPreference);
  const [paused, setPaused] = useState(false);
  const [feedback, setFeedback] = useState<{ readonly id: number; readonly text: string } | null>(null);
  const [renderReady, setRenderReady] = useState(false);
  const [renderError, setRenderError] = useState(false);
  const [contextLost, setContextLost] = useState(false);
  const gameRef = useRef(game);
  const pausedRef = useRef(paused);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLButtonElement>(null);
  const sceneRef = useRef<StackScene | null>(null);
  const soundRef = useRef<StackSound | null>(null);
  const feedbackTimerRef = useRef<number | null>(null);

  if (soundRef.current === null) soundRef.current = new StackSound(soundEnabled);

  const commitGame = useCallback((nextGame: StackGameState) => {
    gameRef.current = nextGame;
    setGame(nextGame);
    syncScene(sceneRef.current, nextGame);
  }, []);

  const showFeedback = useCallback((text: string) => {
    if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current);
    setFeedback({ id: Date.now(), text });
    feedbackTimerRef.current = window.setTimeout(() => {
      feedbackTimerRef.current = null;
      setFeedback(null);
    }, 850);
  }, []);

  const rememberBest = useCallback((score: number) => {
    setBestScore((current) => {
      if (score <= current) return current;
      try {
        localStorage.setItem(BEST_SCORE_KEY, String(score));
      } catch {
        // A disabled storage area should not prevent a local game.
      }
      return score;
    });
  }, []);

  const startOrPlace = useCallback(() => {
    if (pausedRef.current || renderError || contextLost) return;
    const current = gameRef.current;
    if (current.status === "ready") {
      const started = startStackGame(current);
      commitGame(started);
      soundRef.current?.play("start");
      stageRef.current?.focus({ preventScroll: true });
      return;
    }
    if (current.status !== "playing") return;

    const placement = placeStackGame(current);
    commitGame(placement.state);
    if (placement.result === "miss") {
      const support = current.blocks[current.blocks.length - 1];
      if (current.active !== null && support !== undefined) {
        sceneRef.current?.dropMiss({
          ...blockVisual(current.active, "active"),
          axis: current.axis,
          side: stackGameMissSide(support, current.active, current.axis),
        });
      }
      soundRef.current?.play("miss");
      vibrate([28, 28, 46]);
      return;
    }

    for (const [index, slice] of placement.slices.entries()) {
      sceneRef.current?.dropFragment(fragmentVisual(slice, index));
    }
    rememberBest(placement.state.score);
    if (placement.result === "perfect" && placement.placed !== null) {
      sceneRef.current?.celebratePerfect(
        placement.placed.layer,
        placement.state.combo,
      );
      soundRef.current?.play("perfect", placement.state.combo);
      showFeedback(
        placement.state.combo > 1
          ? `完美 ×${placement.state.combo}`
          : "完美",
      );
      vibrate(12);
    } else {
      soundRef.current?.play("place");
      vibrate(7);
    }
  }, [commitGame, contextLost, rememberBest, renderError, showFeedback]);

  const restart = useCallback(() => {
    const restarted = createStackGame();
    pausedRef.current = false;
    setPaused(false);
    setFeedback(null);
    commitGame(restarted);
    stageRef.current?.focus({ preventScroll: true });
  }, [commitGame]);

  const togglePause = useCallback(() => {
    if (gameRef.current.status !== "playing") return;
    const nextPaused = !pausedRef.current;
    pausedRef.current = nextPaused;
    setPaused(nextPaused);
    stageRef.current?.focus({ preventScroll: true });
  }, []);

  const toggleSound = useCallback(() => {
    const nextEnabled = !soundEnabled;
    setSoundEnabled(nextEnabled);
    soundRef.current?.setEnabled(nextEnabled);
    try {
      localStorage.setItem(SOUND_ENABLED_KEY, nextEnabled ? "1" : "0");
    } catch {
      // Keep the in-memory preference when storage is unavailable.
    }
    if (nextEnabled) soundRef.current?.play("place");
  }, [soundEnabled]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let scene: StackScene;
    try {
      scene = new StackScene(canvas, reducedMotion);
    } catch {
      setRenderError(true);
      return;
    }
    sceneRef.current = scene;
    syncScene(scene, gameRef.current);
    setRenderReady(true);

    let animationFrame = 0;
    let animationRunning = false;
    let lastFrame = performance.now();
    const animate = (now: number) => {
      if (!animationRunning) return;
      const deltaSeconds = Math.min(0.05, Math.max(0, (now - lastFrame) / 1_000));
      lastFrame = now;
      if (gameRef.current.status === "playing" && !pausedRef.current) {
        gameRef.current = tickStackGame(gameRef.current, deltaSeconds);
      }
      syncScene(scene, gameRef.current);
      scene.render(deltaSeconds);
      if (animationRunning) animationFrame = window.requestAnimationFrame(animate);
    };
    const suspendAnimation = () => {
      if (!animationRunning) return;
      animationRunning = false;
      window.cancelAnimationFrame(animationFrame);
    };
    const resumeAnimation = () => {
      if (animationRunning) return;
      animationRunning = true;
      lastFrame = performance.now();
      animationFrame = window.requestAnimationFrame(animate);
    };

    const onContextLost = (event: Event) => {
      event.preventDefault();
      suspendAnimation();
      if (gameRef.current.status === "playing") {
        pausedRef.current = true;
        setPaused(true);
      }
      setContextLost(true);
      setRenderReady(false);
    };
    const onContextRestored = () => {
      scene.resize();
      syncScene(scene, gameRef.current);
      setContextLost(false);
      setRenderError(false);
      setRenderReady(true);
      resumeAnimation();
    };
    canvas.addEventListener("webglcontextlost", onContextLost);
    canvas.addEventListener("webglcontextrestored", onContextRestored);

    const resize = () => scene.resize();
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(resize);
    resizeObserver?.observe(canvas);
    window.addEventListener("resize", resize);

    resumeAnimation();

    return () => {
      suspendAnimation();
      resizeObserver?.disconnect();
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    const pauseForBackground = () => {
      if (document.visibilityState !== "hidden" || gameRef.current.status !== "playing") return;
      pausedRef.current = true;
      setPaused(true);
    };
    document.addEventListener("visibilitychange", pauseForBackground);
    return () => document.removeEventListener("visibilitychange", pauseForBackground);
  }, []);

  useEffect(() => () => {
    if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current);
    soundRef.current?.dispose();
  }, []);

  const onStageKeyDown = (event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key.toLowerCase() === "p" || event.key === "Escape") {
      event.preventDefault();
      togglePause();
    }
  };

  const reloadPage = () => location.reload();

  const stateLayer = renderError
    ? (
      <div class="stack-game-state-copy">
        <h1>无法启动 3D 场景</h1>
        <p>当前浏览器或设备未提供可用的 WebGL 渲染能力。</p>
        <button class="stack-game-primary-action" type="button" onClick={reloadPage}>
          <RotateCcw aria-hidden="true" size={18} strokeWidth={2.2} />
          重新载入
        </button>
      </div>
    )
    : contextLost
    ? (
      <div class="stack-game-state-copy">
        <h1>正在恢复画面</h1>
        <p>3D 渲染连接刚刚中断，浏览器正在重建场景。</p>
        <button class="stack-game-primary-action" type="button" onClick={reloadPage}>
          <RotateCcw aria-hidden="true" size={18} strokeWidth={2.2} />
          重新载入
        </button>
      </div>
    )
    : game.status === "ready"
    ? (
      <div class="stack-game-state-copy">
        <h1>叠叠高</h1>
        <p>让每一层稳稳落在塔顶。</p>
        <button class="stack-game-primary-action" type="button" onClick={startOrPlace}>
          <Play aria-hidden="true" size={18} strokeWidth={2.2} />
          开始堆叠
        </button>
      </div>
    )
    : paused
    ? (
      <div class="stack-game-state-copy">
        <h1>已暂停</h1>
        <p>{game.score} 层 · 最佳 {bestScore} 层</p>
        <button class="stack-game-primary-action" type="button" onClick={togglePause}>
          <Play aria-hidden="true" size={18} strokeWidth={2.2} />
          继续
        </button>
      </div>
    )
    : game.status === "over"
    ? (
      <div class="stack-game-state-copy">
        <h1>{game.score} 层</h1>
        <p>{game.score >= bestScore && game.score > 0 ? "本局最佳" : `最佳 ${bestScore} 层`}</p>
        <button class="stack-game-primary-action" type="button" onClick={restart}>
          <RotateCcw aria-hidden="true" size={18} strokeWidth={2.2} />
          再来一局
        </button>
      </div>
    )
    : null;

  return (
    <main class="stack-game-page">
      <button
        ref={stageRef}
        class="stack-game-stage"
        type="button"
        aria-label={stageLabel(game, paused)}
        data-game-status={game.status}
        data-paused={paused ? "true" : "false"}
        data-render-ready={renderReady ? "true" : "false"}
        data-render-state={renderError ? "unavailable" : contextLost ? "lost" : renderReady ? "ready" : "loading"}
        data-score={game.score}
        data-combo={game.combo}
        onClick={startOrPlace}
        onKeyDown={onStageKeyDown}
      >
        <canvas ref={canvasRef} class="stack-game-canvas" aria-hidden="true" />
      </button>
      <div class="stack-game-vignette" aria-hidden="true" />

      <nav class="stack-game-topbar" aria-label="叠叠高工具栏">
        <div class="stack-game-brand">
          <a
            class="stack-game-icon-button"
            href="/"
            aria-label="返回首页"
            data-tooltip="返回首页"
          >
            <ArrowLeft aria-hidden="true" size={20} strokeWidth={2} />
          </a>
          <div class="stack-game-brand-copy">
            <strong>叠叠高</strong>
            <span>最佳 {bestScore} 层</span>
          </div>
        </div>
        <div class="stack-game-controls">
          <button
            class="stack-game-icon-button"
            type="button"
            aria-label={soundEnabled ? "关闭音效" : "开启音效"}
            data-tooltip={soundEnabled ? "关闭音效" : "开启音效"}
            onClick={toggleSound}
          >
            {soundEnabled
              ? <Volume2 aria-hidden="true" size={19} strokeWidth={2} />
              : <VolumeX aria-hidden="true" size={19} strokeWidth={2} />}
          </button>
          <button
            class="stack-game-icon-button"
            type="button"
            aria-label={paused ? "继续游戏" : "暂停游戏"}
            data-tooltip={paused ? "继续游戏" : "暂停游戏"}
            disabled={game.status !== "playing"}
            onClick={togglePause}
          >
            {paused
              ? <Play aria-hidden="true" size={18} strokeWidth={2} />
              : <Pause aria-hidden="true" size={18} strokeWidth={2} />}
          </button>
          <button
            class="stack-game-icon-button"
            type="button"
            aria-label="重新开始"
            data-tooltip="重新开始"
            onClick={restart}
          >
            <RotateCcw aria-hidden="true" size={18} strokeWidth={2} />
          </button>
        </div>
      </nav>

      <div class="stack-game-scoreboard" aria-label="本局分数">
        <strong class="stack-game-score">{game.score}</strong>
        <span class="stack-game-sr-only">层</span>
        <span class="stack-game-combo" data-visible={game.combo > 1 ? "true" : "false"}>
          {game.combo > 1 ? `连击 ×${game.combo}` : ""}
        </span>
      </div>

      {feedback !== null && (
        <p
          class="stack-game-feedback"
          data-visible="true"
          key={feedback.id}
          aria-hidden="true"
        >
          {feedback.text}
        </p>
      )}

      {stateLayer !== null && (
        <section
          class="stack-game-state-layer"
          data-state={renderError ? "error" : contextLost ? "lost" : paused ? "paused" : game.status}
          aria-live="polite"
        >
          {stateLayer}
        </section>
      )}
      <p class="stack-game-sr-only" aria-live="polite">
        {paused
          ? "游戏已暂停"
          : game.status === "over"
          ? `游戏结束，本局 ${game.score} 层`
          : game.lastPlacement === "perfect"
          ? `完美落下，当前 ${game.score} 层，连续完美 ${game.combo} 次`
          : `当前 ${game.score} 层`}
      </p>
    </main>
  );
}
