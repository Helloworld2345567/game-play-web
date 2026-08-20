import { expect, test, type Page } from "@playwright/test";

async function setDisplayName(page: Page, displayName: string): Promise<void> {
  const input = page.getByLabel("你的昵称");
  if (!(await input.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: /^编辑昵称/u }).click();
  }
  await input.fill(displayName);
  await page.getByRole("button", { name: "保存昵称" }).click();
  await expect(page.getByText("昵称已保存", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", {
    name: `编辑昵称，当前为${displayName}`,
  })).toBeVisible();
}

function cell(page: Page, x: number, y: number) {
  return page.locator(`[data-cell="${x},${y}"]`);
}

async function place(
  page: Page,
  x: number,
  y: number,
  state: "x" | "o",
): Promise<void> {
  await cell(page, x, y).click();
  await expect(cell(page, x, y)).toHaveAttribute("data-state", state);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    ),
  ).toBe(false);
}

test("two Guests play tic-tac-toe while a spectator watches, then swap X", async ({
  browser,
}) => {
  const creatorContext = await browser.newContext({
    viewport: { width: 360, height: 800 },
  });
  const inviteeContext = await browser.newContext({
    viewport: { width: 360, height: 800 },
  });
  const spectatorContext = await browser.newContext({
    viewport: { width: 360, height: 800 },
  });
  const creator = await creatorContext.newPage();
  const invitee = await inviteeContext.newPage();
  const spectator = await spectatorContext.newPage();

  try {
    await creator.goto("/");
    await setDisplayName(creator, "井字甲");
    await creator.getByRole("button", { name: "创建井字棋房" }).click();
    await expect(creator).toHaveURL(/\/r\/[A-Za-z0-9_-]{16}$/u);
    const inviteUrl = creator.url();

    await invitee.goto(inviteUrl);
    await setDisplayName(invitee, "井字乙");
    await expect(creator.getByRole("heading", { level: 1 })).toHaveText("轮到你");
    await expect(invitee.getByRole("heading", { level: 1 })).toHaveText(
      "等待对手落子",
    );

    await spectator.goto(inviteUrl);
    await setDisplayName(spectator, "井字观众");
    await expect(spectator.getByRole("heading", { level: 1 })).toHaveText(
      "正在观战",
    );
    await expect(spectator.locator(".tictactoe-cell")).toHaveCount(9);
    for (const spectatorCell of await spectator.locator(".tictactoe-cell").all()) {
      await expect(spectatorCell).toBeDisabled();
    }
    await Promise.all([
      expectNoHorizontalOverflow(creator),
      expectNoHorizontalOverflow(invitee),
      expectNoHorizontalOverflow(spectator),
    ]);

    await place(creator, 0, 0, "x");
    await expect(invitee.getByRole("heading", { level: 1 })).toHaveText("轮到你");
    await place(invitee, 0, 1, "o");
    await expect(creator.getByRole("heading", { level: 1 })).toHaveText("轮到你");
    await place(creator, 1, 0, "x");
    await place(invitee, 1, 1, "o");
    await place(creator, 2, 0, "x");

    await expect(creator.getByRole("heading", { level: 1 })).toHaveText("你赢了");
    await expect(invitee.getByRole("heading", { level: 1 })).toHaveText(
      "对手获胜",
    );
    await expect(spectator.getByRole("heading", { level: 1 })).toHaveText(
      "井字甲获胜",
    );
    await expect(cell(spectator, 2, 0)).toHaveAttribute("data-state", "x");
    await expect(spectator.locator(".tictactoe-cell.is-winning")).toHaveCount(3);
    await expect(spectator.getByRole("button", { name: "再来一局" })).toHaveCount(0);

    await creator.getByRole("button", { name: "再来一局" }).click();
    await expect(
      invitee.locator(".seat-card").filter({ hasText: "井字甲" }),
    ).toContainText("已准备");
    await invitee.getByRole("button", { name: "再来一局" }).click();

    await expect(invitee.getByRole("heading", { level: 1 })).toHaveText("轮到你");
    await expect(
      invitee.locator(".seat-card").filter({ hasText: "井字乙" }),
    ).toContainText("X 方");
    await expect(cell(invitee, 0, 0)).toHaveAttribute("data-state", "empty");
    await place(invitee, 0, 0, "x");
    await expect(cell(creator, 0, 0)).toHaveAttribute("data-state", "x");
    await expect(spectator.getByText(/第 2 局/u)).toBeVisible();
  } finally {
    await spectatorContext.close();
    await inviteeContext.close();
    await creatorContext.close();
  }
});
