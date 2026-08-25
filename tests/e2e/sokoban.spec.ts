import { expect, test, type Locator, type Page } from "@playwright/test";

function board(page: Page, level: number): Locator {
  return page.getByRole("grid", {
    name: new RegExp(`推箱子棋盘，第 ${level} 关`, "u"),
  });
}

function moveCount(page: Page): Locator {
  return page.getByText("本关步数", { exact: true }).locator("..").locator("strong");
}

test("opens Sokoban, switches levels, undoes a move, and stays within mobile width", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "推箱子，开始本机游戏" }).click();

  await expect(page).toHaveURL(/\/sokoban\/?$/u);
  await expect(page.getByRole("heading", { level: 1, name: "推箱子" })).toBeVisible();

  const levelButtons = page.getByRole("button", { name: /^第 \d+ 关$/u });
  await expect(levelButtons).toHaveCount(10);

  const firstBoard = board(page, 1);
  await expect(firstBoard).toHaveAttribute("aria-rowcount", "7");
  await expect(firstBoard).toHaveAttribute("aria-colcount", "6");
  await expect(firstBoard.getByRole("row")).toHaveCount(7);
  await expect(firstBoard.getByRole("gridcell")).toHaveCount(42);

  await firstBoard.focus();
  await page.keyboard.press("ArrowRight");
  await expect(moveCount(page)).toHaveText("1");

  await page.getByRole("button", { name: "撤销一步", exact: true }).click();
  await expect(moveCount(page)).toHaveText("0");

  await page.getByRole("button", { name: "第 2 关", exact: true }).click();
  await expect(page).toHaveURL(/\/sokoban\?level=2$/u);
  const secondBoard = board(page, 2);
  await expect(secondBoard).toHaveAttribute("aria-rowcount", "7");
  await expect(secondBoard).toHaveAttribute("aria-colcount", "6");
  await page.getByRole("button", { name: /^重新开始/u }).click();

  await page.setViewportSize({ width: 360, height: 800 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
});
