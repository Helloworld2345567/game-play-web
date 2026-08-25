import { expect, test, type Page } from "@playwright/test";

const SNAKE_RULE_VERSION = "snake.solo.20x20.v1";

function board(page: Page) {
  return page.getByRole("grid", {
    name: "贪吃蛇棋盘，20 行 20 列",
  });
}

async function stubLeaderboard(page: Page): Promise<void> {
  await page.route("**/api/snake/leaderboard**", async (route) => {
    const body = route.request().postDataJSON() as {
      ruleVersion?: string;
      score?: number;
    };
    expect(body.ruleVersion).toBe(SNAKE_RULE_VERSION);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ruleVersion: body.ruleVersion,
        personalBestScore: 12,
        top: Array.from({ length: 10 }, (_, index) => ({
          rank: index + 1,
          displayName: `棋友${String(index + 1).padStart(4, "0")}`,
          score: 12 - Math.min(index, 11),
        })),
      }),
    });
  });
}

test("opens Snake from the homepage with a fixed accessible board and restart", async ({
  page,
}) => {
  await stubLeaderboard(page);
  await page.goto("/");
  await page.getByRole("button", { name: "贪吃蛇，开始本机游戏" }).click();
  await expect(page).toHaveURL(/\/snake\/?$/u);
  await expect(page.getByRole("heading", { level: 1, name: "贪吃蛇" }))
    .toBeVisible();

  const gameBoard = board(page);
  await expect(gameBoard).toHaveAttribute("aria-rowcount", "20");
  await expect(gameBoard).toHaveAttribute("aria-colcount", "20");
  await expect(gameBoard.getByRole("row")).toHaveCount(20);
  await expect(gameBoard.getByRole("gridcell")).toHaveCount(400);
  await expect(page.getByText("按方向键、WASD 或滑动开始", { exact: true }))
    .toBeVisible();

  await page.getByRole("button", { name: "向左移动" }).click();
  await expect(page.getByText("按方向键、WASD 或滑动开始", { exact: true }))
    .toBeVisible();
  await expect(gameBoard).toHaveAttribute("data-direction", "right");

  await page.getByRole("button", { name: "开始", exact: true }).click();
  await expect(page.getByText("吃到食物会得分并逐渐加速", { exact: true }))
    .toBeVisible();
  await expect.poll(() => gameBoard.evaluate((element) => document.activeElement === element))
    .toBe(true);
  await page.keyboard.press("ArrowUp");
  await expect(gameBoard).toHaveAttribute("data-direction", "up");
  await page.getByRole("button", { name: "暂停" }).click();
  await expect(page.getByText("已暂停，按空格或继续按钮恢复", { exact: true }))
    .toBeVisible();

  await page.getByRole("button", { name: "重新开始" }).click();
  await expect(page.getByText("按方向键、WASD 或滑动开始", { exact: true }))
    .toBeVisible();
});

test("requests and renders the Snake top-10 leaderboard", async ({ page }) => {
  const requestBodies: unknown[] = [];
  await page.route("**/api/snake/leaderboard", async (route) => {
    const body = route.request().postDataJSON() as { ruleVersion?: string };
    requestBodies.push(body);
    expect(body.ruleVersion).toBe(SNAKE_RULE_VERSION);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ruleVersion: SNAKE_RULE_VERSION,
        personalBestScore: 12,
        top: Array.from({ length: 10 }, (_, index) => ({
          rank: index + 1,
          displayName: `棋友${String(index + 1).padStart(4, "0")}`,
          score: 12 - Math.min(index, 11),
        })),
      }),
    });
  });
  await page.goto("/snake");

  const leaderboard = page.getByRole("region", { name: "贪吃蛇排行榜" });
  await expect(leaderboard).toContainText("最高分 · 前 10");
  await expect(leaderboard.locator("li")).toHaveCount(10);
  await expect(leaderboard).toContainText("棋友0001");
  await expect(leaderboard.locator('data[value="12"]')).toHaveText("12");
  await expect(page.locator('[aria-label="本局统计"] strong').nth(2)).toHaveText(
    "12",
  );
  await expect.poll(() => requestBodies.length).toBe(1);
  expect(requestBodies[0]).toEqual({ ruleVersion: SNAKE_RULE_VERSION });
});

test("keeps the mobile board and leaderboard within the viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await stubLeaderboard(page);
  await page.goto("/snake");
  await expect(board(page)).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
});
