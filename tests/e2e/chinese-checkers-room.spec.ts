import {
  expect,
  test,
  type BrowserContext,
  type Page,
} from "@playwright/test";

async function setDisplayName(page: Page, displayName: string): Promise<void> {
  const input = page.getByLabel("你的昵称");
  if (!(await input.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: /^编辑昵称/u }).click();
  }
  await input.fill(displayName);
  await page.getByRole("button", { name: "保存昵称" }).click();
  await expect(page.getByText("昵称已保存", { exact: true })).toBeVisible();
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

test.describe("Chinese Checkers multiplayer rooms", () => {
  test.describe.configure({ mode: "serial" });

  for (const playerCount of [2, 3, 4] as const) {
    test(`${playerCount} players fill ordered seats before a spectator follows`, async ({
      browser,
    }) => {
      const contexts: BrowserContext[] = [];
      const pages: Page[] = [];

      try {
        for (let index = 0; index < playerCount + 1; index += 1) {
          const context = await browser.newContext({
            viewport: { width: 390, height: 844 },
          });
          contexts.push(context);
          pages.push(await context.newPage());
        }
        const creator = pages[0]!;
        await creator.goto("/");
        await setDisplayName(creator, `跳棋${playerCount}甲`);
        await creator.getByRole("button", {
          name: "跳棋，选择本机或联机玩法与人数",
        }).click();
        const picker = creator.getByRole("dialog", { name: "跳棋" });
        await picker.getByText("邀请联机", { exact: true }).click();
        await picker.getByText(`${playerCount} 人`, { exact: true }).click();
        await picker.getByRole("button", {
          name: `创建 ${playerCount} 人联机房间`,
        }).click();
        await expect(creator).toHaveURL(/\/r\/[A-Za-z0-9_-]{16}$/u);
        const inviteUrl = creator.url();

        for (let index = 1; index < playerCount; index += 1) {
          await pages[index]!.goto(inviteUrl);
          await setDisplayName(
            pages[index]!,
            `跳棋${playerCount}${String.fromCharCode(0x7532 + index)}`,
          );
          if (index + 1 < playerCount) {
            await expect(creator.locator("[data-hole]")).toHaveCount(0);
            await expect(creator.getByRole("heading", { level: 1 })).toHaveText(
              "等待其他玩家加入",
            );
          }
        }

        await expect(creator.locator("[data-seat]")).toHaveCount(playerCount);
        await expect(creator.locator("[data-hole]")).toHaveCount(121);
        await expect(creator.locator("[data-owner]")).toHaveCount(
          playerCount * 10,
        );
        await expect(creator.getByRole("heading", { level: 1 })).toHaveText(
          "轮到你 · 第 1 回合",
        );
        for (let index = 1; index < playerCount; index += 1) {
          await expect(pages[index]!.locator("[data-hole]")).toHaveCount(121);
          await expect(pages[index]!.getByRole("heading", { level: 1 })).toHaveText(
            "等待玩家 1 走棋 · 第 1 回合",
          );
        }

        const [from, to] = playerCount === 4
          ? ["-6,-4", "-5,-3"]
          : ["-3,-5", "-4,-4"];
        await creator.locator(`[data-hole="${from}"]`).click();
        await expect(creator.locator(`[data-hole="${to}"]`)).toHaveAttribute(
          "data-legal-step",
          "true",
        );
        await creator.locator(`[data-hole="${to}"]`).click();
        await expect(pages[1]!.locator(`[data-hole="${to}"]`)).toHaveAttribute(
          "data-owner",
          "seat-a",
        );
        await expect(pages[1]!.locator(`[data-hole="${from}"]`)).not.toHaveAttribute(
          "data-owner",
          "seat-a",
        );
        await expect(pages[1]!.getByRole("heading", { level: 1 })).toHaveText(
          "轮到你 · 第 2 回合",
        );

        const spectator = pages[playerCount]!;
        await spectator.goto(inviteUrl);
        await setDisplayName(spectator, `跳棋${playerCount}观众`);
        await expect(spectator.locator("[data-hole]")).toHaveCount(121);
        await expect(spectator.locator("[data-hole]:not(:disabled)")).toHaveCount(0);
        await expect(spectator.getByRole("button", { name: "认输" })).toHaveCount(0);
        await expect(spectator.getByRole("heading", { level: 1 })).toHaveText(
          "正在观战",
        );

        await Promise.all(pages.map(expectNoHorizontalOverflow));
      } finally {
        await Promise.all(contexts.reverse().map((context) => context.close()));
      }
    });
  }
});
