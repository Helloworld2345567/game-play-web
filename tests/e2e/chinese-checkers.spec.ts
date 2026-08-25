import { expect, test, type Locator, type Page } from "@playwright/test";

function board(page: Page) {
  return page.getByRole("grid", { name: "跳棋棋盘，121 个棋位" });
}

function hole(page: Page, coordinates: string) {
  return board(page).getByRole("gridcell", {
    name: new RegExp(`坐标 ${coordinates}`),
  });
}

async function locatorCenter(locator: Locator) {
  const bounds = await locator.boundingBox();
  if (bounds === null) throw new Error("Chinese Checkers hole is not visible");
  return {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
}

function distance(
  left: { readonly x: number; readonly y: number },
  right: { readonly x: number; readonly y: number },
): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

test("opens Chinese Checkers and plays a local two-player turn", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", {
    name: "跳棋，选择本机或联机玩法与人数",
  }).click();
  const picker = page.getByRole("dialog", { name: "跳棋" });
  await picker.getByRole("button", { name: "开始 2 人本机游戏" }).click();

  await expect(page).toHaveURL(/\/chinese-checkers\?players=2$/u);
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

test("projects the 121 holes as a regular six-point star", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.goto("/chinese-checkers");

  const boardBounds = await board(page).boundingBox();
  if (boardBounds === null) throw new Error("Chinese Checkers board is hidden");
  expect(boardBounds.width / boardBounds.height).toBeCloseTo(
    Math.sqrt(3) / 2,
    2,
  );

  const starClipPath = await page.locator(".checkers-board-star").evaluate(
    (element) => getComputedStyle(element).clipPath,
  );
  expect(starClipPath).toMatch(/^polygon\(/u);
  expect(starClipPath.slice(8, -1).split(",")).toHaveLength(12);
  await expect(page.locator(".checkers-board-edges line")).toHaveCount(312);

  const center = await locatorCenter(hole(page, "0，0"));
  const tips = await Promise.all(
    ["0，-8", "12，-4", "12，4", "0，8", "-12，4", "-12，-4"].map(
      (coordinates) => locatorCenter(hole(page, coordinates)),
    ),
  );
  const radii = tips.map((tip) => distance(center, tip));
  expect(Math.max(...radii) - Math.min(...radii)).toBeLessThan(1);

  const horizontalNeighbor = await locatorCenter(hole(page, "2，0"));
  const diagonalNeighbor = await locatorCenter(hole(page, "1，1"));
  expect(
    Math.abs(
      distance(center, horizontalNeighbor) -
        distance(center, diagonalNeighbor),
    ),
  ).toBeLessThan(1);
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
