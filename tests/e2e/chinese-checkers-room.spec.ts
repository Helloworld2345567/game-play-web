import {
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
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

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
    ),
  ).toBe(false);
}

async function locatorCenter(locator: Locator) {
  const bounds = await locator.boundingBox();
  if (bounds === null) throw new Error("Chinese Checkers hole is not visible");
  return {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
}

function distance(
  left: { readonly x: number; readonly y: number },
  right: { readonly x: number; readonly y: number },
): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

async function expectRegularStarBoard(page: Page): Promise<void> {
  const board = page.getByRole("grid", { name: "跳棋棋盘，121 个棋位" });
  const boardBounds = await board.boundingBox();
  if (boardBounds === null) throw new Error("Chinese Checkers board is hidden");
  expect(boardBounds.width / boardBounds.height).toBeCloseTo(
    Math.sqrt(3) / 2,
    2,
  );

  const starClipPath = await page.locator(".checkers-board-star").evaluate(
    (element) => getComputedStyle(element).clipPath,
  );
  expect(starClipPath).toMatch(/^polygon\(/u);
  expect(starClipPath.slice(8, -1).split(",")).toHaveLength(12);
  await expect(page.locator(".checkers-board-edges line")).toHaveCount(312);

  const hole = (coordinates: string) =>
    page.locator(`[data-hole="${coordinates}"]`);
  const center = await locatorCenter(hole("0,0"));
  const tips = await Promise.all(
    ["0,-8", "12,-4", "12,4", "0,8", "-12,4", "-12,-4"].map(
      (coordinates) => locatorCenter(hole(coordinates)),
    ),
  );
  const radii = tips.map((tip) => distance(center, tip));
  expect(Math.max(...radii) - Math.min(...radii)).toBeLessThan(1);

  const horizontalNeighbor = await locatorCenter(hole("2,0"));
  const diagonalNeighbor = await locatorCenter(hole("1,1"));
  expect(
    Math.abs(
      distance(center, horizontalNeighbor) -
        distance(center, diagonalNeighbor),
    ),
  ).toBeLessThan(1);
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
          name: "跳棋，选择联机人数",
        }).click();
        const picker = creator.getByRole("dialog", { name: "跳棋" });
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
          // Do not admit the next Guest until this page has received the
          // authoritative snapshot for its ordered seat. Merely saving the
          // nickname can finish before the room transport's first sync; on a
          // slow runner that lets later Guests race ahead and swaps pages[1]
          // away from seat-b.
          const expectedSeat = `seat-${String.fromCharCode(96 + index + 1)}`;
          await expect(
            pages[index]!.locator(
              `[data-seat="${expectedSeat}"].is-self`,
            ),
          ).toHaveCount(1);
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
        if (playerCount === 2) await expectRegularStarBoard(creator);
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
        for (const page of [...pages].reverse()) {
          await leaveRoomIfPresent(page);
        }
        await Promise.all(contexts.reverse().map((context) => context.close()));
      }
    });
  }
});
