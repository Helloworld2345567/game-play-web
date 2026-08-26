import { expect, test, type Locator, type Page } from "@playwright/test";
import { leaveRoomIfPresent } from "./room-cleanup";

async function setDisplayName(page: Page, displayName: string): Promise<void> {
  const input = page.getByLabel("你的昵称");
  if (!(await input.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: /^编辑昵称/u }).click();
  }
  await input.fill(displayName);
  await page.getByRole("button", { name: "保存昵称" }).click();
  await expect(page.getByRole("button", {
    name: `编辑昵称，当前为${displayName}`,
  })).toBeVisible();
}

async function answerConfirmation(
  page: Page,
  trigger: Locator,
  answer: "accept" | "dismiss",
  withKeyboard = false,
): Promise<void> {
  const dialogPromise = page.waitForEvent("dialog");
  const triggerPromise = withKeyboard
    ? trigger.press("Enter")
    : trigger.click();
  const dialog = await dialogPromise;

  expect(dialog.type()).toBe("confirm");
  if (answer === "accept") await dialog.accept();
  else await dialog.dismiss();
  await triggerPromise;
}

test("canceling Exit keeps the room, while both explicit exits retire it", async ({
  browser,
}) => {
  const creatorContext = await browser.newContext({
    viewport: { width: 360, height: 800 },
  });
  const inviteeContext = await browser.newContext({
    viewport: { width: 360, height: 800 },
  });
  const verifierContext = await browser.newContext();
  const creator = await creatorContext.newPage();
  const invitee = await inviteeContext.newPage();
  const verifier = await verifierContext.newPage();

  try {
    await creator.goto("/");
    await setDisplayName(creator, "退出甲");
    await creator.getByRole("button", { name: "创建五子棋房" }).click();
    await expect(creator).toHaveURL(/\/r\/[A-Za-z0-9_-]{16}$/u);
    const inviteUrl = creator.url();

    await invitee.goto(inviteUrl);
    await setDisplayName(invitee, "退出乙");
    await creator.locator('[data-role-id="black"]').click();
    await expect(invitee.locator('[data-role-id="black"]')).toBeDisabled();
    await invitee.locator('[data-role-id="white"]').click();
    await expect(creator.getByRole("heading", { level: 1 })).toHaveText("轮到你");
    await expect(invitee.getByRole("heading", { level: 1 })).toHaveText(
      "等待对手落子",
    );

    const creatorExit = creator.getByRole("button", { name: "退出房间" });
    await creatorExit.focus();
    await answerConfirmation(creator, creatorExit, "dismiss", true);

    await expect(creator).toHaveURL(inviteUrl);
    await expect(creatorExit).toBeFocused();
    await expect(creator.locator(".connection-pill")).toContainText("连接正常");
    await expect(creator.getByRole("heading", { level: 1 })).toHaveText("轮到你");

    await answerConfirmation(creator, creatorExit, "accept", true);
    await expect(creator).toHaveURL("/");
    await expect(creator.getByRole("heading", { level: 1 })).toContainText(
      "想下哪一局？",
    );
    await expect(
      invitee.locator(".seat-card").filter({ hasText: "暂时离线" }),
    ).toBeVisible();

    const inviteeExit = invitee.getByRole("button", { name: "退出房间" });
    await answerConfirmation(invitee, inviteeExit, "accept");
    await expect(invitee).toHaveURL("/");
    await expect(invitee.getByRole("heading", { level: 1 })).toContainText(
      "想下哪一局？",
    );

    await verifier.goto(inviteUrl);
    await expect(verifier.getByRole("heading", { level: 1 })).toHaveText(
      "没能进入这个房间",
    );
    await expect(verifier.getByText("房间不存在或已经过期。", { exact: true }))
      .toBeVisible();
  } finally {
    await leaveRoomIfPresent(verifier);
    await leaveRoomIfPresent(invitee);
    await leaveRoomIfPresent(creator);
    await verifierContext.close();
    await inviteeContext.close();
    await creatorContext.close();
  }
});

test("Exit returns home locally even while the browser is offline", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 360, height: 800 },
  });
  const page = await context.newPage();

  try {
    await page.goto("/");
    await setDisplayName(page, "离线退出者");
    await page.getByRole("button", { name: "创建五子棋房" }).click();
    await expect(page).toHaveURL(/\/r\/[A-Za-z0-9_-]{16}$/u);
    const exit = page.getByRole("button", { name: "退出房间" });
    await expect(exit).toBeVisible();

    await context.setOffline(true);
    await expect(page.locator(".connection-pill")).toContainText("设备已离线");
    await answerConfirmation(page, exit, "accept");

    await expect(page).toHaveURL("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      "想下哪一局？",
    );
  } finally {
    await context.setOffline(false);
    await leaveRoomIfPresent(page);
    await context.close();
  }
});
