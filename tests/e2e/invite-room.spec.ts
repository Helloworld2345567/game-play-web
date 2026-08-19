import { expect, test, type Page } from "@playwright/test";

async function placeStone(page: Page, x: number, y: number): Promise<void> {
  const board = page.locator("canvas");
  await expect(board).toBeVisible();
  const box = await board.boundingBox();
  expect(box).not.toBeNull();
  const padding = Math.max(14, box!.width * 0.045);
  const step = (box!.width - padding * 2) / 14;
  await board.click({
    position: {
      x: padding + x * step,
      y: padding + y * step,
    },
  });
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflows).toBe(false);
}

test("two Guests recover, finish a Game, and swap first move in a rematch", async ({ browser }) => {
  const creatorContext = await browser.newContext({
    viewport: { width: 360, height: 800 },
  });
  const inviteeContext = await browser.newContext({
    viewport: { width: 360, height: 800 },
  });
  const creator = await creatorContext.newPage();
  const invitee = await inviteeContext.newPage();
  const thirdContext = await browser.newContext();
  const third = await thirdContext.newPage();

  try {
    await creator.goto("/");
    await expect(creator.getByRole("heading", { level: 1 })).toContainText(
      "一条链接",
    );
    await creator.getByRole("button", { name: "创建五子棋房" }).click();
    await expect(creator).toHaveURL(/\/r\/[A-Za-z0-9_-]{16}$/u);
    const inviteUrl = creator.url();

    await invitee.goto(inviteUrl);
    await expect(creator.getByRole("heading", { level: 1 })).toHaveText("轮到你");
    await expect(invitee.getByRole("heading", { level: 1 })).toHaveText(
      "等待对手落子",
    );
    await Promise.all([
      expectNoHorizontalOverflow(creator),
      expectNoHorizontalOverflow(invitee),
    ]);

    await third.goto(inviteUrl);
    await expect(third.getByRole("heading", { level: 1 })).toContainText(
      "已经坐满",
    );
    await thirdContext.close();

    await placeStone(creator, 3, 7);
    await expect(invitee.getByRole("heading", { level: 1 })).toHaveText("轮到你");

    await creatorContext.setOffline(true);
    await expect(creator.locator(".connection-pill")).toContainText("设备已离线");
    await placeStone(invitee, 0, 0);
    await expect(invitee.getByRole("heading", { level: 1 })).toHaveText(
      "等待对手落子",
    );

    await creatorContext.setOffline(false);
    await expect(creator.getByRole("heading", { level: 1 })).toHaveText("轮到你");
    await expect(creator.locator(".connection-pill")).toContainText("连接正常");

    for (const [blackX, whiteX] of [
      [4, 2],
      [5, 4],
      [6, 6],
    ] as const) {
      await placeStone(creator, blackX, 7);
      await expect(invitee.getByRole("heading", { level: 1 })).toHaveText("轮到你");
      await placeStone(invitee, whiteX, 0);
      await expect(creator.getByRole("heading", { level: 1 })).toHaveText("轮到你");
    }
    await placeStone(creator, 7, 7);

    await expect(creator.getByRole("heading", { level: 1 })).toHaveText("你赢了");
    await expect(invitee.getByRole("heading", { level: 1 })).toHaveText(
      "对手获胜",
    );
    await Promise.all([
      expectNoHorizontalOverflow(creator),
      expectNoHorizontalOverflow(invitee),
    ]);

    await creator.getByRole("button", { name: "再来一局" }).click();
    await expect(invitee.getByText("在线 · 已准备", { exact: true })).toBeVisible();
    await invitee.getByRole("button", { name: "再来一局" }).click();

    await expect(invitee.getByRole("heading", { level: 1 })).toHaveText("轮到你");
    await expect(creator.getByRole("heading", { level: 1 })).toHaveText(
      "等待对手落子",
    );
    await expect(invitee.getByText(/第 2 局/u)).toBeVisible();
  } finally {
    if (thirdContext.pages().length > 0) await thirdContext.close();
    await inviteeContext.close();
    await creatorContext.close();
  }
});
