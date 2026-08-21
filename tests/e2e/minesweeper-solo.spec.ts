import { expect, test, type Page } from "@playwright/test";
import { generateMinefield } from "../../src/games/minesweeper/engine";
import { MINEFIELD_PRESETS } from "../../src/games/minesweeper/presets";

const PRESETS = [
  { value: "small", columns: "9", rows: "9", cells: 81 },
  { value: "medium", columns: "16", rows: "16", cells: 256 },
  { value: "large", columns: "30", rows: "16", cells: 480 },
] as const;

function board(page: Page) {
  return page.getByRole("grid", { name: "扫雷棋盘" });
}

function cell(page: Page, x: number, y: number) {
  return page.locator(`[data-cell="${x},${y}"]`);
}

test("single-player minesweeper supports every preset, flags, pause, and restart", async ({
  page,
}) => {
  await page.goto("/minesweeper");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("扫雷");

  for (const preset of PRESETS) {
    await page.getByLabel("难度").selectOption(preset.value);
    await expect(board(page)).toHaveAttribute("aria-colcount", preset.columns);
    await expect(board(page)).toHaveAttribute("aria-rowcount", preset.rows);
    await expect(page.locator(".minesweeper-cell")).toHaveCount(preset.cells);
    await expect(page.getByText("点击任意格开始", { exact: true })).toBeVisible();
  }

  await cell(page, 0, 0).click({ button: "right" });
  await expect(cell(page, 0, 0)).toHaveAttribute("data-flagged", "true");
  await cell(page, 0, 0).click({ button: "right" });
  await expect(cell(page, 0, 0)).toHaveAttribute("data-flagged", "false");

  await cell(page, 1, 1).click();
  await expect(page.getByText("扫雷中", { exact: true })).toBeVisible();
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "暂停" }).click();
  await expect(page.getByText("已暂停", { exact: true })).toBeVisible();
  await page.waitForTimeout(300);
  const pausedTime = await page.getByLabel("用时").locator("strong").innerText();
  await page.waitForTimeout(700);
  await expect(page.getByLabel("用时").locator("strong")).toHaveText(pausedTime);
  await page.getByRole("button", { name: "继续" }).click();
  await expect(page.getByText("扫雷中", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "重新开始" }).click();
  await expect(page.getByText("点击任意格开始", { exact: true })).toBeVisible();
  await expect(page.locator('.minesweeper-cell[data-state="hidden"]')).toHaveCount(
    480,
  );
});

test("mobile long press flags and the large board stays inside its viewport", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 360, height: 800 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  try {
    await page.goto("/minesweeper");
    await page.getByLabel("难度").selectOption("large");
    await expect(page.locator(".minesweeper-cell")).toHaveCount(480);
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
      ),
    ).toBe(false);
    expect(
      await page.locator(".minesweeper-board-viewport").evaluate(
        (element) => element.scrollWidth > element.clientWidth,
      ),
    ).toBe(true);

    const target = cell(page, 0, 0);
    const box = await target.boundingBox();
    if (box === null) throw new Error("Missing first minefield cell");
    const point = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
    await target.dispatchEvent("pointerdown", {
      ...point,
      pointerId: 9,
      pointerType: "touch",
      isPrimary: true,
    });
    await page.waitForTimeout(500);
    await target.dispatchEvent("pointerup", {
      ...point,
      pointerId: 9,
      pointerType: "touch",
      isPrimary: true,
    });
    await expect(target).toHaveAttribute("data-flagged", "true");

    const mobileLayout = await page.evaluate(() => {
      const board = document.querySelector<HTMLElement>(
        ".minesweeper-board-viewport",
      );
      const leaderboard = document.querySelector<HTMLElement>(
        ".minesweeper-leaderboard",
      );
      if (board === null || leaderboard === null) {
        throw new Error("Missing mobile minesweeper layout element");
      }
      return {
        boardBottom: board.getBoundingClientRect().bottom,
        leaderboardTop: leaderboard.getBoundingClientRect().top,
      };
    });
    expect(mobileLayout.leaderboardTop).toBeGreaterThanOrEqual(
      mobileLayout.boardBottom,
    );
  } finally {
    await context.close();
  }
});

test("desktop large board fits without dragging and keeps the leaderboard to the right", async ({
  page,
}) => {
  for (const width of [1024, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/minesweeper?preset=large");
    await expect(board(page)).toHaveAttribute("aria-colcount", "30");
    await expect(page.locator(".minesweeper-cell")).toHaveCount(480);

    const metrics = await page.evaluate(() => {
      const viewport = document.querySelector<HTMLElement>(
        ".minesweeper-board-viewport",
      );
      const grid = document.querySelector<HTMLElement>(
        ".minesweeper-board[aria-colcount='30']",
      );
      const leaderboard = document.querySelector<HTMLElement>(
        ".minesweeper-leaderboard",
      );
      const lastCell = document.querySelector<HTMLElement>(
        '[data-cell="29,15"]',
      );
      if (
        viewport === null ||
        grid === null ||
        leaderboard === null ||
        lastCell === null
      ) {
        throw new Error("Missing desktop minesweeper layout element");
      }
      const viewportBox = viewport.getBoundingClientRect();
      const gridBox = grid.getBoundingClientRect();
      const leaderboardBox = leaderboard.getBoundingClientRect();
      const lastCellBox = lastCell.getBoundingClientRect();
      return {
        documentOverflow: document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
        viewportOverflow: viewport.scrollWidth > viewport.clientWidth + 1,
        lastCellInside: lastCellBox.right <= viewportBox.right + 1 &&
          lastCellBox.bottom <= viewportBox.bottom + 1,
        leaderboardLeft: leaderboardBox.left,
        gridRight: gridBox.right,
      };
    });

    expect(metrics.documentOverflow).toBe(false);
    expect(metrics.viewportOverflow).toBe(false);
    expect(metrics.lastCellInside).toBe(true);
    expect(metrics.leaderboardLeft).toBeGreaterThan(metrics.gridRight);
  }
});

test("switches between night and day mode from the upper-right control", async ({
  page,
}) => {
  await page.goto("/minesweeper");
  const themeToggle = page.getByRole("button", { name: "切换到白天模式" });
  await expect(themeToggle).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const darkBackground = await page.locator("body").evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );

  await themeToggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  const lightBackground = await page.locator("body").evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  expect(lightBackground).not.toBe(darkBackground);
  await expect(
    page.getByRole("button", { name: "切换到黑夜模式" }),
  ).toBeVisible();

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "切换到黑夜模式" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("opens a selected difficulty and shows personal and top-10 records", async ({
  page,
}) => {
  const requestedPresets: string[] = [];
  await page.route("**/api/minesweeper/leaderboard", async (route) => {
    const body = route.request().postDataJSON() as {
      ruleVersion: string;
      presetId: string;
    };
    expect(body.ruleVersion).toBe("minesweeper.solo.v1");
    requestedPresets.push(body.presetId);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ruleVersion: body.ruleVersion,
        presetId: body.presetId,
        personalBestMs: 42_340,
        top: [
          { rank: 1, displayName: "扫雷高手", elapsedMs: 31_250 },
          { rank: 2, displayName: "棋友0001", elapsedMs: 42_340 },
        ],
      }),
    });
  });

  await page.goto("/minesweeper?preset=medium");

  await expect(page.getByLabel("难度")).toHaveValue("medium");
  await expect(board(page)).toHaveAttribute("aria-colcount", "16");
  await expect(page.getByLabel("个人最佳纪录").locator("strong")).toHaveText(
    "00:42.34",
  );
  const leaderboard = page.getByRole("region", { name: "扫雷排行榜" });
  await expect(leaderboard).toContainText("中型 · 16×16 · 40 雷 · 前 10");
  await expect(leaderboard).toContainText("扫雷高手");
  await expect(leaderboard).toContainText("00:31.25");
  expect(requestedPresets).toEqual(["medium"]);
});

test("submits one leaderboard result after a completed solo game", async ({
  context,
  page,
}) => {
  const fixedSeed = "00000000-0000-4000-8000-000000000001";
  await context.addInitScript((seed) => {
    Object.defineProperty(crypto, "randomUUID", {
      configurable: true,
      value: () => seed,
    });
  }, fixedSeed);
  const recorded: Array<{ presetId: string; elapsedMs: number }> = [];
  await page.route("**/api/minesweeper/leaderboard**", async (route) => {
    const body = route.request().postDataJSON() as {
      ruleVersion: string;
      presetId: string;
      elapsedMs?: number;
    };
    expect(body.ruleVersion).toBe("minesweeper.solo.v1");
    if (new URL(route.request().url()).pathname.endsWith("/record")) {
      recorded.push({ presetId: body.presetId, elapsedMs: body.elapsedMs! });
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ruleVersion: body.ruleVersion,
        presetId: body.presetId,
        personalBestMs: body.elapsedMs ?? null,
        top: body.elapsedMs === undefined
          ? []
          : [{
              rank: 1,
              displayName: "棋友0001",
              elapsedMs: body.elapsedMs,
            }],
      }),
    });
  });

  await page.goto("/minesweeper?preset=small");
  const start = { x: 4, y: 4 };
  const field = generateMinefield(MINEFIELD_PRESETS.small, fixedSeed, [start]);
  await cell(page, start.x, start.y).click();
  for (const [index, minefieldCell] of field.cells.entries()) {
    if (minefieldCell.mine) continue;
    const target = cell(
      page,
      index % field.width,
      Math.floor(index / field.width),
    );
    if (await target.getAttribute("data-state") === "hidden") {
      await target.click();
    }
  }

  await expect(page.getByText("全部安全格已揭开，你赢了", { exact: true }))
    .toBeVisible();
  await expect.poll(() => recorded.length).toBe(1);
  expect(recorded[0]?.presetId).toBe("small");
  expect(recorded[0]?.elapsedMs).toBeGreaterThan(0);
  await page.waitForTimeout(300);
  expect(recorded).toHaveLength(1);
});

test("keeps the top navigation icon without rendering the brand wordmark", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".brand")).toBeVisible();
  await expect(page.getByText("ym0v0 棋局", { exact: true })).toHaveCount(0);
});
