import { expect, test, type Locator, type Page } from "@playwright/test";

function gameStage(page: Page): Locator {
  return page.locator(".stack-game-stage");
}

async function disableGameAudio(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("stack-game-sound-enabled-v1", "0");
  });
}

async function canvasPixelStats(canvas: Locator): Promise<{
  readonly brightnessRange: number;
  readonly variedSamples: number;
}> {
  return canvas.evaluate((element) => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const canvasElement = element as HTMLCanvasElement;
      const context = canvasElement.getContext("webgl2") ??
        canvasElement.getContext("webgl");
      if (context === null) {
        resolve({ brightnessRange: 0, variedSamples: 0 });
        return;
      }
      const pixels = new Uint8Array(
        context.drawingBufferWidth * context.drawingBufferHeight * 4,
      );
      context.readPixels(
        0,
        0,
        context.drawingBufferWidth,
        context.drawingBufferHeight,
        context.RGBA,
        context.UNSIGNED_BYTE,
        pixels,
      );
      const baseline = pixels[0] ?? 0;
      let minimum = 255;
      let maximum = 0;
      let variedSamples = 0;
      for (let index = 0; index < pixels.length; index += 64) {
        const red = pixels[index] ?? 0;
        const green = pixels[index + 1] ?? 0;
        const blue = pixels[index + 2] ?? 0;
        const brightness = Math.round((red + green + blue) / 3);
        minimum = Math.min(minimum, brightness);
        maximum = Math.max(maximum, brightness);
        if (Math.abs(red - baseline) > 8 || Math.abs(green - baseline) > 8 ||
          Math.abs(blue - baseline) > 8) variedSamples += 1;
      }
      resolve({ brightnessRange: maximum - minimum, variedSamples });
    }));
  }));
}

async function loseCanvasContext(canvas: Locator): Promise<boolean> {
  return canvas.evaluate((element) => {
    const canvasElement = element as HTMLCanvasElement;
    const context = canvasElement.getContext("webgl2") ??
      canvasElement.getContext("webgl");
    const extension = context?.getExtension("WEBGL_lose_context");
    if (extension === null || extension === undefined) return false;
    const state = window as Window & {
      __stackGameContextLoss?: WEBGL_lose_context;
    };
    state.__stackGameContextLoss = extension;
    extension.loseContext();
    return true;
  });
}

async function restoreCanvasContext(canvas: Locator): Promise<boolean> {
  return canvas.evaluate(() => {
    const state = window as Window & {
      __stackGameContextLoss?: WEBGL_lose_context;
    };
    const extension = state.__stackGameContextLoss;
    if (extension === undefined) return false;
    extension.restoreContext();
    delete state.__stackGameContextLoss;
    return true;
  });
}

test("opens the 3D stack game, places a block, pauses, and restarts", async ({
  page,
}) => {
  await disableGameAudio(page);
  await page.goto("/");
  await page.getByRole("button", { name: "叠叠高，开始本机游戏" }).click();
  await expect(page).toHaveURL(/\/stack-game\/?$/u);
  await expect(page.getByRole("heading", { level: 1, name: "叠叠高" })).toBeVisible();

  const stage = gameStage(page);
  await expect(stage).toHaveRole("button");
  await expect(stage).toHaveAttribute("data-game-status", "ready");
  await expect(stage).toHaveAttribute("data-render-ready", "true");
  await expect(page.locator(".stack-game-score")).toHaveText("0");

  const canvas = page.locator("canvas.stack-game-canvas");
  const pixels = await canvasPixelStats(canvas);
  expect(pixels.brightnessRange).toBeGreaterThan(20);
  expect(pixels.variedSamples).toBeGreaterThan(100);

  expect(await loseCanvasContext(canvas)).toBe(true);
  await expect(stage).toHaveAttribute("data-render-state", "lost");
  expect(await restoreCanvasContext(canvas)).toBe(true);
  await expect(stage).toHaveAttribute("data-render-state", "ready");
  const restoredPixels = await canvasPixelStats(canvas);
  expect(restoredPixels.brightnessRange).toBeGreaterThan(20);

  await page.getByRole("button", { name: "开始堆叠" }).click();
  await expect(stage).toHaveAttribute("data-game-status", "playing");
  await page.waitForTimeout(1_500);
  await stage.click({ position: { x: 20, y: 300 } });
  await expect(stage).toHaveAttribute("data-score", "1");

  await page.getByRole("button", { name: "暂停游戏" }).click();
  await expect(stage).toHaveAttribute("data-paused", "true");
  await page.getByRole("button", { name: "继续", exact: true }).click();
  await expect(stage).toHaveAttribute("data-paused", "false");

  await page.getByRole("button", { name: "重新开始" }).click();
  await expect(stage).toHaveAttribute("data-game-status", "ready");
  await expect(stage).toHaveAttribute("data-score", "0");
});

test("fills a narrow phone viewport without overflow or blank canvas", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await disableGameAudio(page);
  await page.goto("/stack-game");

  const stage = gameStage(page);
  await expect(stage).toHaveAttribute("data-render-ready", "true");
  expect(await page.evaluate(() => ({
    height: document.documentElement.scrollHeight,
    viewportHeight: document.documentElement.clientHeight,
    width: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
  }))).toEqual({
    height: 844,
    viewportHeight: 844,
    width: 390,
    viewportWidth: 390,
  });

  const canvasBox = await page.locator("canvas.stack-game-canvas").boundingBox();
  expect(canvasBox).toMatchObject({ x: 0, y: 0, width: 390, height: 844 });
  const pixels = await canvasPixelStats(page.locator("canvas.stack-game-canvas"));
  expect(pixels.brightnessRange).toBeGreaterThan(20);
  expect(pixels.variedSamples).toBeGreaterThan(60);

  const controlsBox = await page.locator(".stack-game-controls").boundingBox();
  expect(controlsBox).not.toBeNull();
  expect((controlsBox?.x ?? 390) + (controlsBox?.width ?? 1)).toBeLessThanOrEqual(390);

  await page.setViewportSize({ width: 844, height: 390 });
  await expect.poll(async () => page.locator("canvas.stack-game-canvas").boundingBox())
    .toMatchObject({ x: 0, y: 0, width: 844, height: 390 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(844);
  const landscapePixels = await canvasPixelStats(page.locator("canvas.stack-game-canvas"));
  expect(landscapePixels.brightnessRange).toBeGreaterThan(20);
});
