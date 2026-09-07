import {
  ArrowLeft,
  Pause,
  Play,
  RotateCcw,
  Trophy,
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
import { STACK_GAME_MAX_SCORE } from "../../../shared/game-stack-leaderboard";
import { ProfileMenu } from "../../ProfileMenu";
import {
  loadGameStackLeaderboard,
  recordGameStackScore,
  type StackGameLeaderboardSnapshot,
} from "./leaderboard-client";
import {
  StackScene,
  type StackBlockVisual,
  type StackFragmentVisual,
} from "./StackScene";
import { StackSound } from "./sound";
import "./game.css";

const BEST_SCORE_KEY = "stack-game-best-v1";
const SOUND_ENABLED_KEY = "stack-game-sound-enabled-v1";
const SCORE_SUBMISSION_TIMEOUT_MS = 10_000;
const BLOCK_VISUAL_CACHE = new WeakMap<
  readonly StackGameBlock[],
  readonly StackBlockVisual[]
>();

interface ActiveStackGame {
  readonly id: string;
  readonly state: StackGameState;
}

interface FailedStackGameSubmission {
  readonly id: string;
  readonly score: number;
}

interface StackGameSubmissionRequest {
  readonly controller: AbortController;
  readonly timeoutId: number;
}

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

function withStackPersonalBest(
  snapshot: StackGameLeaderboardSnapshot,
  personalBestScore: number | null,
): StackGameLeaderboardSnapshot {
  return snapshot.personalBestScore === personalBestScore
    ? snapshot
    : { ...snapshot, personalBestScore };
}

export function formatGameStackScore(score: number): string {
  return new Intl.NumberFormat("zh-CN").format(Math.max(0, score));
}

export function higherGameStackPersonalBest(
  current: number | null,
  incoming: number | null,
): number | null {
  if (current === null) return incoming;
  if (incoming === null) return current;
  return Math.max(current, incoming);
}

export function preferHigherGameStackSnapshot(
  current: StackGameLeaderboardSnapshot | null,
  incoming: StackGameLeaderboardSnapshot,
): StackGameLeaderboardSnapshot {
  if (current !== null && current.ruleVersion !== incoming.ruleVersion) {
    return incoming;
  }
  const incomingBest = incoming.personalBestScore;
  if (
    current !== null &&
    current.personalBestScore !== null &&
    (incomingBest === null || incomingBest < current.personalBestScore)
  ) {
    return current;
  }
  return incoming;
}

/**
 * A record response confirms this Guest's best score, but its Top 10 can have
 * been projected before another in-flight write. Preserve the visible list
 * until the follow-up read supplies an authoritative projection.
 */
export function applyGameStackRecordSnapshot(
  current: StackGameLeaderboardSnapshot | null,
  incoming: StackGameLeaderboardSnapshot,
): StackGameLeaderboardSnapshot {
  if (current === null || current.ruleVersion !== incoming.ruleVersion) {
    return incoming;
  }
  return withStackPersonalBest(
    current,
    higherGameStackPersonalBest(
      current.personalBestScore,
      incoming.personalBestScore,
    ),
  );
}

export function isNewGameStackPersonalBest(
  previousBestScore: number | null,
  completedScore: number,
  confirmedBestScore: number | null,
  previousBestKnown: boolean,
): boolean {
  return previousBestKnown &&
    confirmedBestScore === completedScore &&
    (previousBestScore === null || completedScore > previousBestScore);
}

function newActiveStackGame(): ActiveStackGame {
  return {
    id: crypto.randomUUID(),
    state: createStackGame(),
  };
}

function initialLeaderboardOpen(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.matchMedia("(min-width: 641px)").matches;
  } catch {
    return false;
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

export function SoloPage({
  displayName,
  initiallyOpenProfile = false,
  onDisplayNameChange,
}: {
  displayName: string;
  initiallyOpenProfile?: boolean;
  onDisplayNameChange(displayName: string): void;
}) {
  const [activeGame, setActiveGame] = useState<ActiveStackGame>(newActiveStackGame);
  const game = activeGame.state;
  const [bestScore, setBestScore] = useState(readStoredBest);
  const [soundEnabled, setSoundEnabled] = useState(readStoredSoundPreference);
  const [paused, setPaused] = useState(false);
  const [feedback, setFeedback] = useState<{ readonly id: number; readonly text: string } | null>(null);
  const [leaderboard, setLeaderboard] = useState<StackGameLeaderboardSnapshot | null>(null);
  const [leaderboardStatus, setLeaderboardStatus] =
    useState<"loading" | "ready" | "offline">("loading");
  const [leaderboardOpen, setLeaderboardOpen] = useState(initialLeaderboardOpen);
  const [recordNotice, setRecordNotice] = useState<string | null>(null);
  const [failedSubmission, setFailedSubmission] =
    useState<FailedStackGameSubmission | null>(null);
  const [renderReady, setRenderReady] = useState(false);
  const [renderError, setRenderError] = useState(false);
  const [contextLost, setContextLost] = useState(false);
  const gameIdRef = useRef(activeGame.id);
  const gameRef = useRef(game);
  const pausedRef = useRef(paused);
  const currentDisplayName = useRef(displayName);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLButtonElement>(null);
  const sceneRef = useRef<StackScene | null>(null);
  const soundRef = useRef<StackSound | null>(null);
  const feedbackTimerRef = useRef<number | null>(null);
  const leaderboardRequest = useRef(0);
  const submissionAttempt = useRef(0);
  const visibleSubmissionAttempt = useRef<number | null>(null);
  const confirmedBestScore = useRef<number | null>(null);
  const confirmedBestKnown = useRef(false);
  const submittedGames = useRef(new Set<string>());
  const submittingGames = useRef(new Set<string>());
  const submissionRequests = useRef(
    new Map<string, StackGameSubmissionRequest>(),
  );
  const mounted = useRef(true);
  currentDisplayName.current = displayName;

  if (soundRef.current === null) soundRef.current = new StackSound(soundEnabled);

  const commitGame = useCallback((nextGame: StackGameState) => {
    const nextActiveGame: ActiveStackGame = {
      id: gameIdRef.current,
      state: nextGame,
    };
    gameRef.current = nextGame;
    setActiveGame(nextActiveGame);
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

  const acceptLeaderboardSnapshot = useCallback((
    snapshot: StackGameLeaderboardSnapshot,
  ) => {
    const effectiveBest = higherGameStackPersonalBest(
      confirmedBestScore.current,
      snapshot.personalBestScore,
    );
    confirmedBestScore.current = effectiveBest;
    confirmedBestKnown.current = true;
    const effectiveSnapshot = withStackPersonalBest(snapshot, effectiveBest);
    setLeaderboard((current) =>
      preferHigherGameStackSnapshot(current, effectiveSnapshot)
    );
    setLeaderboardStatus("ready");
  }, []);

  const refreshLeaderboardAfterRecord = useCallback(() => {
    const requestId = ++leaderboardRequest.current;
    void loadGameStackLeaderboard(currentDisplayName.current).then(
      (snapshot) => {
        if (!mounted.current || leaderboardRequest.current !== requestId) return;
        acceptLeaderboardSnapshot(snapshot);
      },
      () => {
        // The write response already confirms the personal best. Keep it
        // visible and let the next page load or score write refresh Top 10.
      },
    );
  }, [acceptLeaderboardSnapshot]);

  const submitScore = useCallback((gameId: string, score: number) => {
    if (
      !Number.isSafeInteger(score) ||
      score < 1 ||
      score > STACK_GAME_MAX_SCORE ||
      submittedGames.current.has(gameId) ||
      submittingGames.current.has(gameId)
    ) {
      return;
    }
    submittedGames.current.add(gameId);
    submittingGames.current.add(gameId);
    const attemptId = ++submissionAttempt.current;
    visibleSubmissionAttempt.current = attemptId;
    const previousBest = confirmedBestScore.current;
    const previousBestKnown = confirmedBestKnown.current;
    const controller = new AbortController();
    const timeoutId = window.setTimeout(
      () => controller.abort(),
      SCORE_SUBMISSION_TIMEOUT_MS,
    );
    submissionRequests.current.set(gameId, { controller, timeoutId });
    const finishRequest = () => {
      const request = submissionRequests.current.get(gameId);
      if (request?.controller !== controller) return;
      window.clearTimeout(request.timeoutId);
      submissionRequests.current.delete(gameId);
    };
    setFailedSubmission((current) => current?.id === gameId ? null : current);
    setRecordNotice("正在保存分数…");
    void recordGameStackScore(
      currentDisplayName.current,
      score,
      controller.signal,
    ).then(
      (snapshot) => {
        finishRequest();
        submittingGames.current.delete(gameId);
        if (!mounted.current) return;
        const effectiveBest = higherGameStackPersonalBest(
          confirmedBestScore.current,
          snapshot.personalBestScore,
        );
        confirmedBestScore.current = effectiveBest;
        confirmedBestKnown.current = true;
        setFailedSubmission((current) =>
          current !== null && current.score <= (effectiveBest ?? 0)
            ? null
            : current
        );
        const effectiveSnapshot = withStackPersonalBest(snapshot, effectiveBest);
        setLeaderboard((current) =>
          applyGameStackRecordSnapshot(current, effectiveSnapshot)
        );
        setLeaderboardStatus("ready");
        refreshLeaderboardAfterRecord();
        if (visibleSubmissionAttempt.current === attemptId) {
          setRecordNotice(
            isNewGameStackPersonalBest(
              previousBest,
              score,
              effectiveBest,
              previousBestKnown,
            )
              ? "新的个人最高！"
              : "分数已记录",
          );
        }
      },
      () => {
        finishRequest();
        submittingGames.current.delete(gameId);
        submittedGames.current.delete(gameId);
        if (!mounted.current) return;
        if (
          confirmedBestScore.current === null ||
          confirmedBestScore.current < score
        ) {
          setFailedSubmission((current) =>
            current === null || score > current.score
              ? { id: gameId, score }
              : current
          );
        }
        if (visibleSubmissionAttempt.current === attemptId) {
          setRecordNotice("分数暂未同步，可重试");
        }
      },
    );
  }, [refreshLeaderboardAfterRecord]);

  const startOrPlace = useCallback(() => {
    if (pausedRef.current || renderError || contextLost) return;
    const current = gameRef.current;
    if (current.status === "ready") {
      const started = startStackGame(current);
      visibleSubmissionAttempt.current = null;
      setRecordNotice(null);
      commitGame(started);
      soundRef.current?.play("start");
      stageRef.current?.focus({ preventScroll: true });
      return;
    }
    if (current.status !== "playing") return;

    const placement = placeStackGame(current);
    commitGame(placement.state);
    if (placement.result === "miss") {
      rememberBest(current.score);
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
    const restarted = newActiveStackGame();
    gameIdRef.current = restarted.id;
    gameRef.current = restarted.state;
    setActiveGame(restarted);
    pausedRef.current = false;
    setPaused(false);
    setFeedback(null);
    visibleSubmissionAttempt.current = null;
    setRecordNotice(null);
    syncScene(sceneRef.current, restarted.state);
    stageRef.current?.focus({ preventScroll: true });
  }, []);

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
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const request of submissionRequests.current.values()) {
        window.clearTimeout(request.timeoutId);
        request.controller.abort();
      }
      submissionRequests.current.clear();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const requestId = ++leaderboardRequest.current;
    let animationFrame = 0;
    let idleRequest = 0;
    let fallbackTimer = 0;
    setLeaderboard(null);
    setLeaderboardStatus("loading");
    const loadLeaderboard = () => {
      if (controller.signal.aborted) return;
      void loadGameStackLeaderboard(displayName, controller.signal).then(
        (snapshot) => {
          if (
            !mounted.current ||
            controller.signal.aborted ||
            leaderboardRequest.current !== requestId
          ) return;
          acceptLeaderboardSnapshot(snapshot);
        },
        () => {
          if (
            controller.signal.aborted ||
            leaderboardRequest.current !== requestId
          ) return;
          setLeaderboardStatus("offline");
        },
      );
    };
    // Let Three.js construct and paint the scene before session/bootstrap and
    // leaderboard work begins. The timeout keeps the ranking responsive on a
    // browser that reports no idle time while the RAF loop is active.
    animationFrame = window.requestAnimationFrame(() => {
      if (controller.signal.aborted) return;
      if (typeof window.requestIdleCallback === "function") {
        idleRequest = window.requestIdleCallback(loadLeaderboard, {
          timeout: 1_000,
        });
      } else {
        fallbackTimer = window.setTimeout(loadLeaderboard, 0);
      }
    });
    return () => {
      controller.abort();
      window.cancelAnimationFrame(animationFrame);
      if (idleRequest !== 0) window.cancelIdleCallback(idleRequest);
      if (fallbackTimer !== 0) window.clearTimeout(fallbackTimer);
    };
  }, [acceptLeaderboardSnapshot, displayName]);

  // React observes the completed state after the input task has finished, so
  // session/bootstrap and score requests never start inside the placement
  // handler or the animation loop.
  useEffect(() => {
    if (game.status === "over" && game.score > 0) {
      submitScore(activeGame.id, game.score);
    }
  }, [activeGame.id, game.score, game.status, submitScore]);

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
  const personalBestScore = leaderboard?.personalBestScore ?? null;

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
        <p>{game.score} 层 · 本机最佳 {bestScore} 层</p>
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
        <p>{game.score >= bestScore && game.score > 0 ? "本局最佳" : `本机最佳 ${bestScore} 层`}</p>
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
            <span>本机最佳 {bestScore} 层</span>
          </div>
        </div>
        <div class="stack-game-controls">
          <ProfileMenu
            displayName={displayName}
            initiallyOpen={initiallyOpenProfile}
            onSave={onDisplayNameChange}
          />
          <button
            class="stack-game-icon-button"
            type="button"
            aria-label={leaderboardOpen ? "关闭排行榜" : "打开排行榜"}
            aria-expanded={leaderboardOpen}
            aria-controls="stack-game-leaderboard"
            data-tooltip={leaderboardOpen ? "关闭排行榜" : "打开排行榜"}
            onClick={() => setLeaderboardOpen((open) => !open)}
          >
            <Trophy aria-hidden="true" size={18} strokeWidth={2} />
          </button>
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

      <section
        id="stack-game-leaderboard"
        class="stack-game-leaderboard"
        data-open={leaderboardOpen ? "true" : "false"}
        aria-label="叠叠高排行榜"
      >
        <header>
          <div>
            <p class="stack-game-leaderboard-eyebrow">全球榜 · 叠叠高</p>
            <h2>最高层数 · 前 10</h2>
          </div>
          <span>
            {leaderboardStatus === "loading"
              ? "正在加载…"
              : leaderboardStatus === "offline"
                ? "暂时无法连接排行榜"
              : "按层数从高到低"}
          </span>
        </header>
        <p class="stack-game-personal-best">
          <span>个人最高</span>
          <strong>
            {personalBestScore === null
              ? "—"
              : formatGameStackScore(personalBestScore)}
          </strong>
          {personalBestScore !== null && <small>层</small>}
        </p>
        {leaderboard !== null && leaderboard.top.length > 0 ? (
          <ol>
            {leaderboard.top.map((entry) => (
              <li key={`${entry.rank}-${entry.displayName}-${entry.score}`}>
                <span class="stack-game-leaderboard-rank">{entry.rank}</span>
                <strong>{entry.displayName}</strong>
                <data value={entry.score}>{formatGameStackScore(entry.score)}</data>
              </li>
            ))}
          </ol>
        ) : (
          <p class="stack-game-leaderboard-empty">
            {leaderboardStatus === "ready" ? "还没有完成纪录" : "—"}
          </p>
        )}
        <p class="stack-game-leaderboard-note">
          本局结束时自动记录最高层数；排行榜只保留每位玩家的个人最高纪录。
        </p>
        {recordNotice !== null && (
          <p class="stack-game-record-notice" aria-live="polite">
            {recordNotice}
          </p>
        )}
        {failedSubmission !== null && (
          <button
            class="stack-game-record-retry"
            type="button"
            onClick={() => {
              if (submittingGames.current.has(failedSubmission.id)) return;
              submittedGames.current.delete(failedSubmission.id);
              submitScore(failedSubmission.id, failedSubmission.score);
            }}
          >
            重试保存 {formatGameStackScore(failedSubmission.score)} 层
          </button>
        )}
      </section>

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
