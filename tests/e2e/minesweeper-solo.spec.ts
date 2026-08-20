import { expect, test, type Page } from "@playwright/test";

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
  } finally {
    await context.close();
  }
});
