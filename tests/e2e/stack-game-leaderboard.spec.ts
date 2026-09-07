import { expect, test, type Page } from "@playwright/test";

const STACK_GAME_RULE_VERSION = "stack-game.solo.v1";

function snapshot(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ruleVersion: STACK_GAME_RULE_VERSION,
    personalBestScore: 24,
    top: Array.from({ length: 10 }, (_, index) => ({
      rank: index + 1,
      displayName: `棋友${String(index + 1).padStart(4, "0")}`,
      score: 24 - index,
    })),
    ...overrides,
  };
}

async function preparePage(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("ym0v0.display-name", "测试玩家");
    localStorage.setItem("ym0v0.display-name-confirmed", "1");
    localStorage.setItem("stack-game-sound-enabled-v1", "0");
  });
}

test("requests and renders the Stack Game top-10 leaderboard", async ({
  page,
}) => {
  const requestBodies: unknown[] = [];
  await page.route("**/api/stack-game/leaderboard**", async (route) => {
    const body = route.request().postDataJSON() as {
      ruleVersion?: string;
      score?: number;
    };
    requestBodies.push(body);
    expect(body.ruleVersion).toBe(STACK_GAME_RULE_VERSION);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(snapshot()),
    });
  });
  await preparePage(page);
  await page.addInitScript(() => {
    localStorage.setItem("stack-game-best-v1", "99");
  });
  await page.goto("/stack-game");

  const leaderboard = page.getByRole("region", { name: "叠叠高排行榜" });
  await expect(leaderboard).toContainText("最高层数 · 前 10");
  const personalBest = leaderboard.locator(".stack-game-personal-best");
  await expect(personalBest).toContainText("个人最高");
  await expect(personalBest.locator("strong")).toHaveText("24");
  await expect(personalBest.locator("small")).toHaveText("层");
  await expect(page.locator(".stack-game-brand-copy")).toContainText(
    "本机最佳 99 层",
  );
  await expect(leaderboard.locator("li")).toHaveCount(10);
  await expect(leaderboard).toContainText("棋友0001");
  await expect(leaderboard.locator('data[value="24"]')).toHaveText("24");
  await expect.poll(() => requestBodies.length).toBe(1);
  expect(requestBodies[0]).toEqual({
    ruleVersion: STACK_GAME_RULE_VERSION,
  });
});

test("submits one completed score asynchronously and refreshes the ranking", async ({
  page,
}) => {
  const queryBodies: unknown[] = [];
  const recordBodies: unknown[] = [];
  await page.route("**/api/stack-game/leaderboard**", async (route) => {
    const body = route.request().postDataJSON() as {
      ruleVersion?: string;
      score?: number;
    };
    expect(body.ruleVersion).toBe(STACK_GAME_RULE_VERSION);
    if (route.request().url().endsWith("/record")) {
      recordBodies.push(body);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(snapshot({ personalBestScore: body.score })),
      });
      return;
    }
    queryBodies.push(body);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(snapshot()),
    });
  });
  await preparePage(page);
  await page.goto("/stack-game");

  const stage = page.locator(".stack-game-stage");
  await expect(stage).toHaveAttribute("data-render-ready", "true");
  await page.getByRole("button", { name: "开始堆叠" }).click();

  // The first block reaches a valid overlap after roughly two seconds. The
  // next block starts outside the tower, so placing it immediately ends the
  // game with exactly one completed layer.
  await page.waitForTimeout(1_500);
  await stage.click({ position: { x: 16, y: 320 } });
  await expect(stage).toHaveAttribute("data-score", "1");
  await page.waitForTimeout(240);
  await stage.click({ position: { x: 16, y: 320 } });
  await expect(stage).toHaveAttribute("data-game-status", "over");

  await expect.poll(() => recordBodies.length).toBe(1);
  expect(recordBodies[0]).toEqual({
    ruleVersion: STACK_GAME_RULE_VERSION,
    score: 1,
  });
  // The initial read plus one post-write refresh are the only query calls;
  // animation frames must not trigger leaderboard traffic.
  await expect.poll(() => queryBodies.length).toBe(2);
  await expect(page.getByText("分数已记录", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "再来一局" }).click();
  await expect(stage).toHaveAttribute("data-game-status", "ready");
  await page.waitForTimeout(350);
  expect(recordBodies).toHaveLength(1);
});

test("keeps leaderboard text inert and the full-screen scene within a phone viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/stack-game/leaderboard**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(snapshot({
        top: [{
          rank: 1,
          displayName: "棋友 <b>测试</b>",
          score: 24,
        }],
      })),
    });
  });
  await preparePage(page);
  await page.goto("/stack-game");

  await page.getByRole("button", { name: "打开排行榜" }).click();
  const leaderboard = page.getByRole("region", { name: "叠叠高排行榜" });
  await expect(leaderboard).toBeVisible();
  await expect(leaderboard).toContainText("棋友 <b>测试</b>");
  await expect(leaderboard.locator("b")).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      document.documentElement.scrollWidth <= document.documentElement.clientWidth &&
      document.documentElement.scrollHeight <= document.documentElement.clientHeight
    ),
  ).toBe(true);
  await expect(page.locator("canvas.stack-game-canvas")).toHaveCSS(
    "width",
    "390px",
  );
});
