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
  await expect(page.getByRole("button", {
    name: `编辑昵称，当前为${displayName}`,
  })).toBeVisible();
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    ),
  ).toBe(false);
}

function node(page: Page, id: string) {
  return page.locator(`[data-node="${id}"]`);
}

test("two players capture, switch chase difficulty, then swap roles in a rematch", async ({
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

  try {
    await creator.goto("/");
    await setDisplayName(creator, "追逃甲");
    await creator.getByRole("button", {
      name: "警察抓小偷，选择地图难度",
    }).click();

    const picker = creator.getByRole("dialog", { name: "警察抓小偷" });
    await expect(picker).toBeVisible();
    await expect(picker).not.toContainText("最优");
    await expect(picker).toContainText("双方每次沿线走一步");
    await picker.getByRole("radio", { name: /^简单/u }).check();
    await picker.getByRole("button", { name: "创建追逃房间" }).click();
    await expect(creator).toHaveURL(/\/r\/[A-Za-z0-9_-]{16}$/u);
    const inviteUrl = creator.url();

    await invitee.goto(inviteUrl);
    await setDisplayName(invitee, "追逃乙");
    await expect(creator.getByRole("heading", { level: 1 })).toHaveText(
      "请选择你的角色",
    );
    await expect(invitee.getByRole("heading", { level: 1 })).toHaveText(
      "请选择你的角色",
    );
    await expect(creator.locator("[data-node]")).toHaveCount(0);
    await creator.locator('[data-role-id="thief"]').click();
    await expect(creator.locator(".opening-role-status")).toHaveText(
      "已选择小偷，等待对手",
    );
    await invitee.locator('[data-role-id="police"]').click();
    await expect(creator.getByRole("heading", { level: 1 })).toContainText(
      "轮到你",
    );
    await expect(invitee.getByRole("heading", { level: 1 })).toContainText(
      "等待小偷走子",
    );

    await expect(
      creator.locator(".seat-card").filter({ hasText: "追逃甲" }),
    ).toContainText("小偷");
    await expect(
      creator.locator(".seat-card").filter({ hasText: "追逃乙" }),
    ).toContainText("警察");
    await expect(
      invitee.locator(".seat-card").filter({ hasText: "追逃甲" }),
    ).toContainText("小偷");
    await expect(
      invitee.locator(".seat-card").filter({ hasText: "追逃乙" }),
    ).toContainText("警察");

    await expect(creator.locator("[data-node]")).toHaveCount(6);
    await expect(invitee.locator("[data-node]")).toHaveCount(6);
    await expect(creator.locator(".chase-board-info")).not.toContainText("最优");
    await expect(creator.locator(".chase-board-info")).toContainText(
      "上限 15 回合",
    );
    await Promise.all([
      expectNoHorizontalOverflow(creator),
      expectNoHorizontalOverflow(invitee),
    ]);

    await creator.reload();
    await expect(creator.locator("[data-node]")).toHaveCount(6);
    await expect(creator.getByRole("heading", { level: 1 })).toContainText(
      "轮到你",
    );

    await node(creator, "C").click();
    await expect(creator.getByRole("heading", { level: 1 })).toContainText(
      "等待警察走子",
    );
    await expect(invitee.getByRole("heading", { level: 1 })).toContainText(
      "轮到你",
    );
    await expect(node(invitee, "C")).toHaveAttribute(
      "data-occupant",
      "thief",
    );

    await creatorContext.setOffline(true);
    await expect(creator.locator(".connection-pill")).toContainText("设备已离线");
    await node(invitee, "C").click();
    await expect(invitee.getByRole("heading", { level: 1 })).toHaveText(
      "警察抓获小偷 · 你赢了",
    );

    await creatorContext.setOffline(false);
    await expect(creator.getByRole("heading", { level: 1 })).toHaveText(
      "警察抓获小偷 · 对手获胜",
    );
    await creator.reload();
    await expect(creator.getByRole("heading", { level: 1 })).toHaveText(
      "警察抓获小偷 · 对手获胜",
    );
    await expect(node(creator, "C")).toHaveAttribute(
      "data-occupant",
      "police",
    );

    const creatorModePanel = creator.getByRole("region", {
      name: "下一局模式",
    });
    const inviteeModePanel = invitee.getByRole("region", {
      name: "下一局模式",
    });
    await expect(creatorModePanel.getByRole("radio", { name: "简单" }))
      .toHaveAttribute("aria-checked", "true");
    await expect(inviteeModePanel.getByRole("radio", { name: "简单" }))
      .toHaveAttribute("aria-checked", "true");

    await creator.getByRole("button", { name: "再来一局" }).click();
    await expect(
      invitee.locator(".seat-card").filter({ hasText: "追逃甲" }),
    ).toContainText("已准备");
    await inviteeModePanel.getByRole("radio", { name: "中等" }).click();
    await expect(creatorModePanel.getByRole("radio", { name: "中等" }))
      .toHaveAttribute("aria-checked", "true");
    await expect(
      invitee.locator(".seat-card").filter({ hasText: "追逃甲" }),
    ).not.toContainText("已准备");

    await creator.getByRole("button", { name: "再来一局" }).click();
    await invitee.getByRole("button", { name: "再来一局" }).click();

    await expect(invitee.getByRole("heading", { level: 1 })).toContainText(
      "轮到你",
    );
    await expect(creator.getByRole("heading", { level: 1 })).toContainText(
      "等待小偷走子",
    );
    await expect(
      creator.locator(".seat-card").filter({ hasText: "追逃甲" }),
    ).toContainText("警察");
    await expect(
      creator.locator(".seat-card").filter({ hasText: "追逃乙" }),
    ).toContainText("小偷");
    await expect(
      invitee.locator(".seat-card").filter({ hasText: "追逃甲" }),
    ).toContainText("警察");
    await expect(
      invitee.locator(".seat-card").filter({ hasText: "追逃乙" }),
    ).toContainText("小偷");
    await expect(creator.locator("[data-node]")).toHaveCount(8);
    await expect(invitee.locator("[data-node]")).toHaveCount(8);
    await expect(creator.getByText("第 2 局 · 警察抓小偷 · 中等"))
      .toBeVisible();
    await expect(node(invitee, "V1")).toBeEnabled();
    await expect(node(creator, "V1")).toBeDisabled();
  } finally {
    await leaveRoomIfPresent(invitee);
    await leaveRoomIfPresent(creator);
    await inviteeContext.close();
    await creatorContext.close();
  }
});
