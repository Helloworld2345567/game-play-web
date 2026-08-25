import { expect, test, type Page } from "@playwright/test";

function board(page: Page) {
  return page.getByRole("grid", { name: "跳棋棋盘，121 个棋位" });
}

function hole(page: Page, coordinates: string) {
  return board(page).getByRole("gridcell", {
    name: new RegExp(`坐标 ${coordinates}`),
  });
}

test("opens Chinese Checkers and plays a local two-player turn", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "跳棋，开始本机游戏" }).click();

  await expect(page).toHaveURL(/\/chinese-checkers\/?$/u);
  await expect(page.getByRole("heading", { level: 1, name: "跳棋" }))
    .toBeVisible();
  await expect(board(page).getByRole("gridcell")).toHaveCount(121);
  await expect(page.locator(".checkers-player-card")).toHaveCount(2);
  await expect(page.locator(".checkers-piece")).toHaveCount(20);

  await hole(page, "-3，-5").click();
  await expect(hole(page, "-4，-4")).toContainText("·");
  await hole(page, "-4，-4").click();

  await expect(page.locator(".checkers-turn-panel h2")).toHaveText(
    "轮到玩家 2 · 靛蓝",
  );
  await expect(page.locator(".checkers-recent-move")).toContainText(
    "坐标 -3，-5 → 坐标 -4，-4",
  );
});

test("switches between 2, 3, and 4-player openings without overflowing mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/chinese-checkers");

  await page.getByRole("button", { name: "开始 4 人跳棋新局" }).click();
  await expect(page.locator(".checkers-player-card")).toHaveCount(4);
  await expect(page.locator(".checkers-piece")).toHaveCount(40);
  await expect(page.locator(".checkers-turn-panel h2")).toHaveText(
    "轮到玩家 1 · 绯红",
  );

  await page.getByRole("button", { name: "开始 3 人跳棋新局" }).click();
  await expect(page.locator(".checkers-player-card")).toHaveCount(3);
  await expect(page.locator(".checkers-piece")).toHaveCount(30);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
});
