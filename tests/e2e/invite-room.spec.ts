import { expect, test, type Page } from "@playwright/test";
import { leaveRoomIfPresent } from "./room-cleanup";

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
    await setDisplayName(creator, "甲方");
    await expect(creator.getByRole("heading", { level: 1 })).toContainText(
      "想下哪一局？",
    );
    await creator.getByRole("button", { name: "创建五子棋房" }).click();
    await expect(creator).toHaveURL(/\/r\/[A-Za-z0-9_-]{16}$/u);
    const inviteUrl = creator.url();

    await invitee.goto(inviteUrl);
    await setDisplayName(invitee, "乙方");
    await expect(creator.getByRole("heading", { level: 1 })).toHaveText(
      "请选择你的角色",
    );
    await expect(invitee.getByRole("heading", { level: 1 })).toHaveText(
      "请选择你的角色",
    );
    await expect(creator.locator("canvas")).toHaveCount(0);
    await creator.locator('[data-role-id="black"]').click();
    await expect(creator.locator(".opening-role-status")).toHaveText(
      "已选择黑方，等待对手",
    );
    await invitee.locator('[data-role-id="white"]').click();
    await expect(creator.getByRole("heading", { level: 1 })).toHaveText("轮到你");
    await expect(invitee.getByRole("heading", { level: 1 })).toHaveText(
      "等待对手落子",
    );
    await Promise.all([
      expectNoHorizontalOverflow(creator),
      expectNoHorizontalOverflow(invitee),
    ]);

    await third.goto(inviteUrl);
    await expect(third.getByRole("heading", { level: 1 })).toHaveText(
      "正在观战",
    );
    await setDisplayName(third, "观众丙");
    await expect(creator.getByText("观众丙", { exact: true })).toBeVisible();
    await expect(third.getByRole("button", { name: "认输" })).toHaveCount(0);
    await expectNoHorizontalOverflow(third);

    await placeStone(creator, 3, 7);
    await expect(invitee.getByRole("heading", { level: 1 })).toHaveText("轮到你");
    await expect(third.locator(".board-last-move")).toContainText(
      "黑方落在第 4 列、第 8 行",
    );

    await creatorContext.setOffline(true);
    await expect(creator.locator(".connection-pill")).toContainText("设备已离线");
    await placeStone(invitee, 0, 0);
    await expect(invitee.getByRole("heading", { level: 1 })).toHaveText(
      "等待对手落子",
    );

    await creatorContext.setOffline(false);
    await expect(creator.getByRole("heading", { level: 1 })).toHaveText("轮到你");
    await expect(creator.locator(".connection-pill")).toContainText("连接正常");
    await creator.reload();
    await expect(creator.getByRole("heading", { level: 1 })).toHaveText("轮到你");
    await expect(creator.locator(".board-last-move")).toContainText(
      "白方落在第 1 列、第 1 行",
    );

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
    await expect(third.getByRole("heading", { level: 1 })).toHaveText(
      "甲方获胜",
    );
    await expect(third.getByRole("button", { name: "再来一局" })).toHaveCount(0);
    await Promise.all([
      expectNoHorizontalOverflow(creator),
      expectNoHorizontalOverflow(invitee),
    ]);

    await creator.getByRole("button", { name: "再来一局" }).click();
    await expect(
      invitee.locator(".seat-card").filter({ hasText: "甲方" }),
    ).toContainText("已准备");
    await invitee.getByRole("button", { name: "再来一局" }).click();

    await expect(invitee.getByRole("heading", { level: 1 })).toHaveText("轮到你");
    await expect(creator.getByRole("heading", { level: 1 })).toHaveText(
      "等待对手落子",
    );
    await expect(invitee.getByText(/第 2 局/u)).toBeVisible();
    await expect(third.getByText(/第 2 局/u)).toBeVisible();
    await expect(third.getByRole("heading", { level: 1 })).toHaveText(
      "正在观战",
    );
  } finally {
    await leaveRoomIfPresent(third);
    await leaveRoomIfPresent(invitee);
    await leaveRoomIfPresent(creator);
    if (thirdContext.pages().length > 0) await thirdContext.close();
    await inviteeContext.close();
    await creatorContext.close();
  }
});
