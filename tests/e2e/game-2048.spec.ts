import { expect, test, type Locator, type Page } from "@playwright/test";

const GAME_2048_RULE_VERSION_BY_SIZE = {
  4: "2048.solo.4x4.v1",
  5: "2048.solo.5x5.v1",
  6: "2048.solo.6x6.v1",
} as const;

function gameBoard(page: Page, boardSize = 4): Locator {
  return page.getByRole("grid", {
    name: `2048 棋盘，${boardSize} 行 ${boardSize} 列`,
  });
}

async function boardValues(board: Locator): Promise<string[]> {
  return board.getByRole("gridcell").evaluateAll((cells) =>
    cells.map((cell) => cell.getAttribute("data-value") ?? ""),
  );
}

async function occupiedTileCount(board: Locator): Promise<number> {
  return board.getByRole("gridcell").evaluateAll(
    (cells) =>
      cells.filter((cell) => cell.getAttribute("data-value") !== "empty")
        .length,
  );
}

async function gameState(page: Page, board: Locator) {
  return {
    values: await boardValues(board),
    score: await page.locator('[aria-label="本局统计"] strong').first().innerText(),
  };
}

function stateChanged(
  before: Awaited<ReturnType<typeof gameState>>,
  after: Awaited<ReturnType<typeof gameState>>,
): boolean {
  return before.score !== after.score || before.values.some(
    (value, index) => value !== after.values[index],
  );
}

async function stubLeaderboard(
  page: Page,
  onRequest: (body: unknown) => void = () => undefined,
): Promise<void> {
  await page.route("**/api/2048/leaderboard", async (route) => {
    const body = route.request().postDataJSON() as { ruleVersion?: string };
    onRequest(body);
    const ruleVersion = body.ruleVersion ?? GAME_2048_RULE_VERSION_BY_SIZE[4];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ruleVersion,
        personalBestScore: 4_096,
        top: Array.from({ length: 10 }, (_, index) => ({
          rank: index + 1,
          displayName: `棋友${String(index + 1).padStart(4, "0")}`,
          score: 4_096 - index * 256,
        })),
      }),
    });
  });
}

test("opens 2048 from the homepage with a fixed accessible board and restart", async ({
  page,
}) => {
  await stubLeaderboard(page);
  await page.goto("/");
  await page.getByRole("button", { name: "2048，开始本机游戏" }).click();
  await expect(page).toHaveURL(/\/2048\/?$/u);
  await expect(page.getByRole("heading", { level: 1, name: "2048" })).toBeVisible();

  const board = gameBoard(page);
  await expect(board).toHaveAttribute("aria-rowcount", "4");
  await expect(board).toHaveAttribute("aria-colcount", "4");
  await expect(board.getByRole("row")).toHaveCount(4);
  await expect(board.getByRole("gridcell")).toHaveCount(16);
  await expect.poll(() => occupiedTileCount(board)).toBe(2);

  await board.focus();
  const initialState = await gameState(page, board);
  let moved = false;
  for (const key of ["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"]) {
    await page.keyboard.press(key);
    // Let Preact commit the state update before reading the rendered cells.
    await page.waitForTimeout(0);
    if (stateChanged(initialState, await gameState(page, board))) {
      moved = true;
      break;
    }
  }
  expect(moved).toBe(true);

  await page.getByRole("button", { name: "重新开始" }).click();
  await expect(page.locator('[aria-label="本局统计"] strong').first()).toHaveText("0");
  await expect.poll(() => occupiedTileCount(board)).toBe(2);
});

test("requests and renders the 2048 top-10 leaderboard", async ({ page }) => {
  const requestBodies: unknown[] = [];
  await stubLeaderboard(page, (body) => requestBodies.push(body));
  await page.goto("/2048");

  const leaderboard = page.getByRole("region", { name: "2048 排行榜" });
  await expect(leaderboard).toContainText("最高分 · 前 10");
  await expect(leaderboard.locator("li")).toHaveCount(10);
  await expect(leaderboard).toContainText("棋友0001");
  await expect(leaderboard.locator('data[value="4096"]')).toHaveText("4,096");
  await expect(page.locator('[aria-label="本局统计"] strong').nth(2)).toHaveText("4,096");
  await expect.poll(() => requestBodies.length).toBe(1);
  expect(requestBodies[0]).toEqual({
    ruleVersion: GAME_2048_RULE_VERSION_BY_SIZE[4],
  });
});

test("supports refresh-safe 5×5 and 6×6 maps with separate leaderboard versions", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const requestBodies: unknown[] = [];
  await stubLeaderboard(page, (body) => requestBodies.push(body));
  await page.goto("/2048?size=5");

  const board5 = gameBoard(page, 5);
  await expect(board5).toHaveAttribute("aria-rowcount", "5");
  await expect(board5).toHaveAttribute("aria-colcount", "5");
  await expect(board5.getByRole("row")).toHaveCount(5);
  await expect(board5.getByRole("gridcell")).toHaveCount(25);
  await expect(page.getByLabel("5×5")).toBeChecked();
  await expect.poll(() => requestBodies.length).toBe(1);
  expect(requestBodies[0]).toEqual({
    ruleVersion: GAME_2048_RULE_VERSION_BY_SIZE[5],
  });

  await page.getByLabel("6×6").check();
  await expect(page).toHaveURL(/\/2048\?size=6$/u);
  const board6 = gameBoard(page, 6);
  await expect(board6.getByRole("row")).toHaveCount(6);
  await expect(board6.getByRole("gridcell")).toHaveCount(36);
  expect(
    await page.evaluate(() =>
      document.documentElement.scrollWidth <=
      document.documentElement.clientWidth
    ),
  ).toBe(true);
  await expect.poll(() => requestBodies.length).toBe(2);
  expect(requestBodies[1]).toEqual({
    ruleVersion: GAME_2048_RULE_VERSION_BY_SIZE[6],
  });
});
