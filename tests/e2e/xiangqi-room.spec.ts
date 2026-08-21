import { expect, test, type Page } from "@playwright/test";

type Point = { x: number; y: number };

async function boardPixel(page: Page, point: Point): Promise<Point> {
  const board = page.locator("canvas.xiangqi-board");
  await expect(board).toBeVisible();
  const box = await board.boundingBox();
  expect(box).not.toBeNull();
  const padding = Math.max(14, Math.min(box!.width, box!.height) * 0.055);
  const stepX = (box!.width - padding * 2) / 8;
  const stepY = (box!.height - padding * 2) / 9;
  return {
    x: box!.x + padding + point.x * stepX,
    y: box!.y + padding + point.y * stepY,
  };
}

async function dragPiece(page: Page, from: Point, to: Point): Promise<void> {
  const source = await boardPixel(page, from);
  const target = await boardPixel(page, to);
  await page.mouse.move(source.x, source.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 4 });
  await page.mouse.up();
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflows).toBe(false);
}

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

test("two Guests recover, finish, and rematch a Chinese chess room", async ({ browser }) => {
  const creatorContext = await browser.newContext({
    viewport: { width: 360, height: 800 },
  });
  const inviteeContext = await browser.newContext({
    viewport: { width: 360, height: 800 },
  });
  const thirdContext = await browser.newContext();
  const creator = await creatorContext.newPage();
  const invitee = await inviteeContext.newPage();
  const third = await thirdContext.newPage();

  try {
    await creator.goto("/");
    await setDisplayName(creator, "红方玩家");
    await creator.getByRole("button", { name: "创建中国象棋房" }).click();
    await expect(creator).toHaveURL(/\/r\/[A-Za-z0-9_-]{16}$/u);
    const inviteUrl = creator.url();

    await invitee.goto(inviteUrl);
    await setDisplayName(invitee, "黑方玩家");
    await expect(creator.getByRole("heading", { level: 1 })).toHaveText(
      "请选择你的角色",
    );
    await expect(invitee.getByRole("heading", { level: 1 })).toHaveText(
      "请选择你的角色",
    );
    await expect(creator.locator(".xiangqi-board")).toHaveCount(0);
    await creator.locator('[data-role-id="red"]').click();
    await expect(creator.locator(".opening-role-status")).toHaveText(
      "已选择红方，等待对手",
    );
    await invitee.locator('[data-role-id="black"]').click();
    await expect(creator.getByRole("heading", { level: 1 })).toHaveText("轮到你");
    await expect(invitee.getByRole("heading", { level: 1 })).toHaveText(
      "等待对手落子",
    );
    await expect(creator.locator(".xiangqi-board")).toBeVisible();
    await expect(invitee.locator(".xiangqi-board")).toBeVisible();
    await Promise.all([
      expectNoHorizontalOverflow(creator),
      expectNoHorizontalOverflow(invitee),
    ]);

    const creatorBoard = creator.locator("canvas.xiangqi-board");
    await creatorBoard.focus();
    await creatorBoard.press("ArrowDown");
    await creatorBoard.press("Enter");
    await creatorBoard.press("ArrowUp");
    await creatorBoard.press("Enter");
    await expect(invitee.getByRole("heading", { level: 1 })).toHaveText("轮到你");

    await creatorContext.setOffline(true);
    await expect(creator.locator(".connection-pill")).toContainText("设备已离线");
    await dragPiece(invitee, { x: 4, y: 3 }, { x: 4, y: 4 });
    await expect(invitee.getByRole("heading", { level: 1 })).toHaveText(
      "等待对手落子",
    );

    await creatorContext.setOffline(false);
    await expect(creator.getByRole("heading", { level: 1 })).toHaveText("轮到你");
    await expect(creator.locator(".connection-pill")).toContainText("连接正常");

    await creator.reload();
    await expect(creator.getByRole("heading", { level: 1 })).toHaveText("轮到你");
    await expect(creator.locator(".board-last-move")).toContainText(
      "第 5 列第 4 行走到第 5 列第 5 行",
    );

    await third.goto(inviteUrl);
    await expect(third.getByRole("heading", { level: 1 })).toHaveText(
      "正在观战",
    );
    await setDisplayName(third, "象棋观众");
    await expect(third.locator(".xiangqi-board")).toBeVisible();
    await expect(third.getByRole("button", { name: "认输" })).toHaveCount(0);
    await expectNoHorizontalOverflow(third);

    creator.once("dialog", (dialog) => dialog.accept());
    await creator.getByRole("button", { name: "认输" }).click();
    await expect(creator.getByRole("heading", { level: 1 })).toHaveText(
      "对手获胜",
    );
    await expect(invitee.getByRole("heading", { level: 1 })).toHaveText("你赢了");
    await expect(third.getByRole("heading", { level: 1 })).toHaveText(
      "黑方玩家获胜",
    );
    await expect(third.getByRole("button", { name: "再来一局" })).toHaveCount(0);

    await creator.getByRole("button", { name: "再来一局" }).click();
    await expect(
      invitee.locator(".seat-card").filter({ hasText: "红方玩家" }),
    ).toContainText("已准备");
    await invitee.getByRole("button", { name: "再来一局" }).click();
    await expect(invitee.getByRole("heading", { level: 1 })).toHaveText("轮到你");
    await expect(creator.getByRole("heading", { level: 1 })).toHaveText(
      "等待对手落子",
    );
    await expect(
      invitee.locator(".seat-card").filter({ hasText: "黑方玩家" }),
    ).toContainText("红方");
    await expect(invitee.getByText(/第 2 局/u)).toBeVisible();
    await expect(third.getByText(/第 2 局/u)).toBeVisible();
  } finally {
    await thirdContext.close();
    await inviteeContext.close();
    await creatorContext.close();
  }
});
