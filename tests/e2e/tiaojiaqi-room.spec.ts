import { expect, test, type Page } from "@playwright/test";
import { leaveRoomIfPresent } from "./room-cleanup";

async function setDisplayName(page: Page, displayName: string): Promise<void> {
  const input = page.getByLabel("你的昵称");
  if (!(await input.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: /^编辑昵称/u }).click();
  }
  await input.fill(displayName);
  await page.getByRole("button", { name: "保存昵称" }).click();
  await expect(page.getByText("昵称已保存", { exact: true })).toBeVisible();
}

function node(page: Page, id: string) {
  return page.locator(`[data-node="${id}"]`);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
    ),
  ).toBe(false);
}

test("two players open a five-piece Tiaojiaqi room while a spectator follows", async ({
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
    await setDisplayName(creator, "挑夹甲");
    await creator.getByRole("button", { name: "创建挑夹棋房" }).click();
    await expect(creator).toHaveURL(/\/r\/[A-Za-z0-9_-]{16}$/u);
    const inviteUrl = creator.url();

    await invitee.goto(inviteUrl);
    await setDisplayName(invitee, "挑夹乙");
    await expect(creator.locator("[data-node]")).toHaveCount(0);
    await creator.locator('[data-role-id="black"]').click();
    await invitee.locator('[data-role-id="white"]').click();

    await expect(creator.locator(".tiaojiaqi-board")).toBeVisible();
    await expect(creator.locator("[data-node]")).toHaveCount(29);
    await expect(creator.locator('[data-stone="1"]')).toHaveCount(5);
    await expect(creator.locator('[data-stone="2"]')).toHaveCount(5);
    await expect(node(creator, "0,4")).toBeEnabled();
    await expect(node(invitee, "0,0")).toBeDisabled();

    await node(creator, "0,4").click();
    await expect(node(creator, "0,1")).toBeEnabled();
    await expect(node(creator, "0,1")).toHaveClass(/is-legal/u);
    await node(creator, "0,1").click();
    await expect(node(invitee, "0,1")).toHaveAttribute("data-stone", "1");
    await expect(node(invitee, "0,4")).toHaveAttribute("data-stone", "0");

    await spectator.goto(inviteUrl);
    await setDisplayName(spectator, "挑夹观众");
    await expect(spectator.locator("[data-node]")).toHaveCount(29);
    await expect(node(spectator, "0,1")).toHaveAttribute("data-stone", "1");
    for (const spectatorNode of await spectator.locator("[data-node]").all()) {
      await expect(spectatorNode).toBeDisabled();
    }
    await Promise.all([
      expectNoHorizontalOverflow(creator),
      expectNoHorizontalOverflow(invitee),
      expectNoHorizontalOverflow(spectator),
    ]);
  } finally {
    await leaveRoomIfPresent(spectator);
    await leaveRoomIfPresent(invitee);
    await leaveRoomIfPresent(creator);
    await spectatorContext.close();
    await inviteeContext.close();
    await creatorContext.close();
  }
});
