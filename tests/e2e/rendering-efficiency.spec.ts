import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { leaveRoomIfPresent } from "./room-cleanup";

interface RenderingStats {
  readonly webglDrawCalls: number;
  readonly detachedCanvasDrawCalls: number;
  readonly visibleCanvasDrawCalls: number;
  readonly visibleCanvasComposites: number;
}

type RenderStatsWindow = Window & {
  __renderEfficiencyStats?: RenderingStats;
};

async function installRenderingCounters(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("ym0v0.display-name", "绘制测试棋友");
    localStorage.setItem("ym0v0.display-name-confirmed", "1");
    type MutableRenderingStats = {
      webglDrawCalls: number;
      detachedCanvasDrawCalls: number;
      visibleCanvasDrawCalls: number;
      visibleCanvasComposites: number;
    };

    const state = window as RenderStatsWindow & {
      __renderEfficiencyPatched?: boolean;
    };
    if (state.__renderEfficiencyPatched) return;

    const stats: MutableRenderingStats = {
      webglDrawCalls: 0,
      detachedCanvasDrawCalls: 0,
      visibleCanvasDrawCalls: 0,
      visibleCanvasComposites: 0,
    };
    state.__renderEfficiencyPatched = true;
    state.__renderEfficiencyStats = stats;

    const wrapPrototypeMethod = (
      prototype: object | undefined,
      methodName: string,
      onCall: (receiver: unknown) => void,
    ): void => {
      if (prototype === undefined) return;
      if (!Object.prototype.hasOwnProperty.call(prototype, methodName)) return;
      const original = (prototype as Record<string, unknown>)[methodName];
      if (typeof original !== "function") return;
      Object.defineProperty(prototype, methodName, {
        configurable: true,
        writable: true,
        value: function (this: unknown, ...args: unknown[]) {
          onCall(this);
          return (original as (...values: unknown[]) => unknown).apply(this, args);
        },
      });
    };

    const canvasPrototype =
      typeof CanvasRenderingContext2D === "undefined"
        ? undefined
        : CanvasRenderingContext2D.prototype;
    for (const methodName of [
      "clearRect",
      "fillRect",
      "stroke",
      "fill",
      "fillText",
      "drawImage",
    ]) {
      wrapPrototypeMethod(canvasPrototype, methodName, (receiver) => {
        const canvas = (receiver as CanvasRenderingContext2D).canvas;
        if (canvas.isConnected) {
          stats.visibleCanvasDrawCalls += 1;
        } else {
          stats.detachedCanvasDrawCalls += 1;
        }
        if (methodName === "drawImage" && canvas.isConnected) {
          stats.visibleCanvasComposites += 1;
        }
      });
    }

    const webglPrototypes = [
      typeof WebGLRenderingContext === "undefined"
        ? undefined
        : WebGLRenderingContext.prototype,
      typeof WebGL2RenderingContext === "undefined"
        ? undefined
        : WebGL2RenderingContext.prototype,
    ];
    for (const prototype of webglPrototypes) {
      for (const methodName of ["drawArrays", "drawElements"]) {
        wrapPrototypeMethod(prototype, methodName, () => {
          stats.webglDrawCalls += 1;
        });
      }
    }
  });
}

async function readRenderingStats(page: Page): Promise<RenderingStats> {
  return page.evaluate(() => {
    const stats = (window as RenderStatsWindow).__renderEfficiencyStats;
    return {
      webglDrawCalls: stats?.webglDrawCalls ?? 0,
      detachedCanvasDrawCalls: stats?.detachedCanvasDrawCalls ?? 0,
      visibleCanvasDrawCalls: stats?.visibleCanvasDrawCalls ?? 0,
      visibleCanvasComposites: stats?.visibleCanvasComposites ?? 0,
    };
  });
}

async function disableStackGameAudio(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("stack-game-sound-enabled-v1", "0");
  });
}

async function boardPoint(
  board: Locator,
  x: number,
  y: number,
  xIntervals: number,
  yIntervals: number,
): Promise<{ x: number; y: number }> {
  const box = await board.boundingBox();
  expect(box).not.toBeNull();
  const padding = Math.max(14, Math.min(box!.width, box!.height) * 0.055);
  const stepX = (box!.width - padding * 2) / xIntervals;
  const stepY = (box!.height - padding * 2) / yIntervals;
  return {
    x: box!.x + padding + x * stepX,
    y: box!.y + padding + y * stepY,
  };
}

async function waitForBoardBitmap(board: Locator): Promise<void> {
  // Visibility precedes ResizeObserver/Preact effects. Begin measuring only
  // after the backing bitmap has caught up with its displayed dimensions.
  await expect.poll(() => board.evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    return Math.abs(canvas.width / dpr - canvas.getBoundingClientRect().width);
  })).toBeLessThanOrEqual(2);
  await board.screenshot();
}

interface RoomFixture {
  readonly creator: Page;
  readonly invitee: Page;
  close(): Promise<void>;
}

async function createTwoPlayerRoom(
  browser: Browser,
  game: "gomoku" | "xiangqi",
): Promise<RoomFixture> {
  const creatorContext = await browser.newContext({
    viewport: { width: 360, height: 800 },
  });
  const inviteeContext = await browser.newContext({
    viewport: { width: 360, height: 800 },
  });
  const creator = await creatorContext.newPage();
  const invitee = await inviteeContext.newPage();
  await Promise.all([
    installRenderingCounters(creator),
    installRenderingCounters(invitee),
  ]);

  const createButton = game === "gomoku" ? "创建五子棋房" : "创建中国象棋房";
  const firstRole = game === "gomoku" ? "black" : "red";
  const secondRole = game === "gomoku" ? "white" : "black";
  const boardSelector = game === "gomoku"
    ? "canvas.gomoku-board"
    : "canvas.xiangqi-board";

  try {
    await creator.goto("/");
    await creator.getByRole("button", { name: createButton }).click();
    await expect(creator).toHaveURL(/\/r\/[A-Za-z0-9_-]{16}$/u);
    const inviteUrl = creator.url();
    await creator.locator(`[data-role-id="${firstRole}"]`).click();
    await invitee.goto(inviteUrl);
    await invitee.locator(`[data-role-id="${secondRole}"]`).click();
    await expect(creator.locator(boardSelector)).toBeVisible();
    await expect(invitee.locator(boardSelector)).toBeVisible();
  } catch (error) {
    await leaveRoomIfPresent(invitee);
    await leaveRoomIfPresent(creator);
    await creatorContext.close().catch(() => undefined);
    await inviteeContext.close().catch(() => undefined);
    throw error;
  }

  return {
    creator,
    invitee,
    async close() {
      await leaveRoomIfPresent(invitee);
      await leaveRoomIfPresent(creator);
      await inviteeContext.close();
      await creatorContext.close();
    },
  };
}

test("pausing the stack game stops WebGL draws and resuming restarts them", async ({
  page,
}) => {
  await installRenderingCounters(page);
  await disableStackGameAudio(page);
  await page.goto("/stack-game");

  const stage = page.locator(".stack-game-stage");
  await expect(stage).toHaveAttribute("data-render-ready", "true");
  await page.getByRole("button", { name: "开始堆叠" }).click();
  await expect(stage).toHaveAttribute("data-game-status", "playing");
  await expect.poll(async () => (await readRenderingStats(page)).webglDrawCalls)
    .toBeGreaterThan(0);

  const runningBeforePause = await readRenderingStats(page);
  await page.waitForTimeout(180);
  const runningAfterPause = await readRenderingStats(page);
  expect(runningAfterPause.webglDrawCalls).toBeGreaterThan(
    runningBeforePause.webglDrawCalls,
  );

  await page.getByRole("button", { name: "暂停游戏" }).click();
  await expect(stage).toHaveAttribute("data-paused", "true");
  await page.waitForTimeout(180);
  const pausedFirst = await readRenderingStats(page);
  await page.waitForTimeout(240);
  const pausedSecond = await readRenderingStats(page);
  expect(pausedSecond.webglDrawCalls).toBe(pausedFirst.webglDrawCalls);

  await page.getByRole("button", { name: "继续", exact: true }).click();
  await expect(stage).toHaveAttribute("data-paused", "false");
  await expect.poll(async () => (await readRenderingStats(page)).webglDrawCalls)
    .toBeGreaterThan(pausedSecond.webglDrawCalls);
});

test("gomoku preview reuses its detached stable bitmap and still places after release", async ({
  browser,
}) => {
  const fixture = await createTwoPlayerRoom(browser, "gomoku");
  try {
    const board = fixture.creator.locator("canvas.gomoku-board");
    await waitForBoardBitmap(board);
    await expect.poll(async () => (await readRenderingStats(fixture.creator)).detachedCanvasDrawCalls)
      .toBeGreaterThan(0);
    const beforeDrag = await readRenderingStats(fixture.creator);
    const source = await boardPoint(board, 7, 7, 14, 14);
    const target = await boardPoint(board, 8, 7, 14, 14);
    await fixture.creator.mouse.move(source.x, source.y);
    await fixture.creator.mouse.down();
    await fixture.creator.mouse.move(target.x, target.y, { steps: 6 });
    await fixture.creator.waitForTimeout(120);
    const duringDrag = await readRenderingStats(fixture.creator);
    expect(duringDrag.detachedCanvasDrawCalls).toBe(
      beforeDrag.detachedCanvasDrawCalls,
    );
    expect(duringDrag.visibleCanvasComposites).toBeGreaterThan(
      beforeDrag.visibleCanvasComposites,
    );
    await fixture.creator.mouse.up();
    await expect(fixture.creator.locator(".board-last-move")).toContainText(
      "第 9 列、第 8 行",
    );
    await expect.poll(async () => (await readRenderingStats(fixture.creator)).detachedCanvasDrawCalls).toBeGreaterThan(
      duringDrag.detachedCanvasDrawCalls,
    );
  } finally {
    await fixture.close();
  }
});

test("xiangqi preview reuses its detached stable bitmap and still moves after release", async ({
  browser,
}) => {
  const fixture = await createTwoPlayerRoom(browser, "xiangqi");
  try {
    const board = fixture.creator.locator("canvas.xiangqi-board");
    await waitForBoardBitmap(board);
    await expect.poll(async () => (await readRenderingStats(fixture.creator)).detachedCanvasDrawCalls)
      .toBeGreaterThan(0);
    const beforeDrag = await readRenderingStats(fixture.creator);
    const source = await boardPoint(board, 0, 6, 8, 9);
    const target = await boardPoint(board, 0, 5, 8, 9);
    await fixture.creator.mouse.move(source.x, source.y);
    await fixture.creator.mouse.down();
    await fixture.creator.mouse.move(target.x, target.y, { steps: 5 });
    await fixture.creator.waitForTimeout(120);
    const duringDrag = await readRenderingStats(fixture.creator);
    expect(duringDrag.detachedCanvasDrawCalls).toBe(
      beforeDrag.detachedCanvasDrawCalls,
    );
    expect(duringDrag.visibleCanvasComposites).toBeGreaterThan(
      beforeDrag.visibleCanvasComposites,
    );
    await fixture.creator.mouse.up();
    await expect(fixture.creator.locator(".board-last-move")).toContainText(
      "第 1 列第 7 行走到第 1 列第 6 行",
    );
    await expect.poll(async () => (await readRenderingStats(fixture.creator)).detachedCanvasDrawCalls).toBeGreaterThan(
      duringDrag.detachedCanvasDrawCalls,
    );
  } finally {
    await fixture.close();
  }
});
