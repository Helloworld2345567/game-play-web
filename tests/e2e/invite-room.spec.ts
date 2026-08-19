import { expect, test } from "@playwright/test";

test("two Guests finish the invitation flow and a third Guest is rejected", async ({
  browser,
}) => {
  const creatorContext = await browser.newContext({
    viewport: { width: 360, height: 800 },
  });
  const inviteeContext = await browser.newContext({
    viewport: { width: 360, height: 800 },
  });
  const creator = await creatorContext.newPage();
  const invitee = await inviteeContext.newPage();

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

  const board = creator.locator("canvas");
  await expect(board).toBeVisible();
  const box = await board.boundingBox();
  expect(box).not.toBeNull();
  await board.click({
    position: { x: box!.width / 2, y: box!.height / 2 },
  });

  await expect(invitee.getByRole("heading", { level: 1 })).toHaveText("轮到你");
  await expect(creator.getByRole("heading", { level: 1 })).toHaveText(
    "等待对手落子",
  );

  await creator.reload();
  await expect(creator.getByRole("heading", { level: 1 })).toHaveText(
    "等待对手落子",
  );

  const thirdContext = await browser.newContext();
  const third = await thirdContext.newPage();
  await third.goto(inviteUrl);
  await expect(third.getByRole("heading", { level: 1 })).toContainText(
    "已经坐满",
  );

  const horizontalOverflow = await creator.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(horizontalOverflow).toBe(false);

  await thirdContext.close();
  await inviteeContext.close();
  await creatorContext.close();
});

