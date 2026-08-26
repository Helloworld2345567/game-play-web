import { expect, test, type Locator, type Page } from "@playwright/test";
import { leaveRoom, leaveRoomIfPresent } from "./room-cleanup";

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

function cell(page: Page, key: string): Locator {
  return page.locator(`[data-cell="${key}"]`);
}

async function revealedSignature(page: Page): Promise<string[]> {
  return page
    .locator('.minesweeper-cell[data-state="revealed"]')
    .evaluateAll((elements) => elements.map((element) =>
      `${element.getAttribute("data-cell")}:${element.getAttribute("aria-label")}`
    ));
}

async function progressValue(page: Page, name: string): Promise<number> {
  const value = await page.getByRole("progressbar", { name }).getAttribute("value");
  if (value === null) throw new Error(`Missing progress value for ${name}`);
  return Number(value);
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

test("two players race on identical independent minefields, then rematch", async ({
  browser,
}) => {
  test.setTimeout(120_000);

  const creatorContext = await browser.newContext({
    viewport: { width: 360, height: 800 },
  });
  const inviteeContext = await browser.newContext({
    viewport: { width: 360, height: 800 },
  });
  const creator = await creatorContext.newPage();
  const invitee = await inviteeContext.newPage();

  // Hold only server-to-page snapshots. This makes two independent cell
  // commands visibly pending at once without delaying either command.
  let holdCreatorSnapshots = false;
  let deliverCreatorSnapshot: ((message: string) => void) | null = null;
  const heldCreatorSnapshots: string[] = [];
  await creator.routeWebSocket(/\/websocket(?:\?.*)?$/u, (socket) => {
    const server = socket.connectToServer();
    deliverCreatorSnapshot = (message) => socket.send(message);
    server.onMessage((message) => {
      const serialized =
        typeof message === "string" ? message : message.toString();
      if (holdCreatorSnapshots) heldCreatorSnapshots.push(serialized);
      else socket.send(serialized);
    });
  });

  const releaseCreatorSnapshots = (): void => {
    holdCreatorSnapshots = false;
    if (deliverCreatorSnapshot === null) {
      throw new Error("Creator WebSocket was not connected");
    }
    for (const message of heldCreatorSnapshots.splice(0)) {
      deliverCreatorSnapshot(message);
    }
  };

  try {
    await creator.goto("/");
    await setDisplayName(creator, "扫雷甲");
    await expect(creator.getByText("服务端裁决", { exact: true })).toHaveCount(0);
    await expect(creator.getByText("断线恢复", { exact: true })).toHaveCount(0);
    await expect(creator.getByText("手机优先", { exact: true })).toHaveCount(0);

    await creator.getByRole("button", {
      name: "扫雷，选择玩法和难度",
    }).click();
    const picker = creator.getByRole("dialog", { name: "扫雷" });
    await expect(picker).toBeVisible();
    await picker.getByRole("radio", { name: /双人竞速/u }).check();
    await picker.getByRole("radio", { name: "中型", exact: true }).check();
    await picker.getByRole("button", { name: "创建竞速房间" }).click();
    await expect(creator).toHaveURL(/\/r\/[A-Za-z0-9_-]{16}$/u);
    const inviteUrl = creator.url();

    await invitee.goto(inviteUrl);
    await setDisplayName(invitee, "扫雷乙");
    await expect(creator.getByRole("heading", { level: 1 })).toHaveText(
      "等待双方准备",
    );
    await expect(invitee.getByRole("heading", { level: 1 })).toHaveText(
      "等待双方准备",
    );
    await expect(creator.locator(".minesweeper-cell")).toHaveCount(256);
    await expect(invitee.locator(".minesweeper-cell")).toHaveCount(256);
    await Promise.all([
      expectNoHorizontalOverflow(creator),
      expectNoHorizontalOverflow(invitee),
    ]);
    expect(
      await creator.locator(".minesweeper-board-viewport").evaluate(
        (element) => element.scrollWidth > element.clientWidth,
      ),
    ).toBe(true);

    await creator.getByRole("button", { name: "准备", exact: true }).click();
    await expect(
      creator.getByText("已准备，等待对手", { exact: true }),
    ).toBeVisible();
    await invitee.getByRole("button", { name: "准备", exact: true }).click();

    await expect(creator.getByRole("heading", { level: 1 })).toHaveText(
      "竞速即将开始",
    );
    await expect(invitee.getByRole("heading", { level: 1 })).toHaveText(
      "竞速即将开始",
    );
    await expect(creator.getByText(/\d 秒后开始/u)).toBeVisible();
    await expect(invitee.getByText(/\d 秒后开始/u)).toBeVisible();

    const creatorInitial = await revealedSignature(creator);
    const inviteeInitial = await revealedSignature(invitee);
    expect(creatorInitial.length).toBeGreaterThan(0);
    expect(inviteeInitial).toEqual(creatorInitial);
    const initialProgress = await progressValue(creator, "你完成进度");
    expect(initialProgress).toBe(creatorInitial.length);
    expect(await progressValue(creator, "玩家 B完成进度")).toBe(
      initialProgress,
    );

    await expect(
      creator.getByText("尽快排完你的棋盘", { exact: true }),
    ).toBeVisible({ timeout: 5_000 });
    await expect(
      invitee.getByText("尽快排完你的棋盘", { exact: true }),
    ).toBeVisible({ timeout: 5_000 });

    const pendingKeys = await creator
      .locator('.minesweeper-cell[data-state="hidden"][data-flagged="false"]')
      .evaluateAll((elements) =>
        elements.slice(0, 2).map((element) => element.getAttribute("data-cell"))
          .filter((key): key is string => key !== null)
      );
    expect(pendingKeys).toHaveLength(2);

    holdCreatorSnapshots = true;
    await creator.evaluate((keys) => {
      for (const key of keys) {
        const target = document.querySelector<HTMLButtonElement>(
          `[data-cell="${key}"]`,
        );
        if (target === null) throw new Error(`Missing cell ${key}`);
        target.dispatchEvent(new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          button: 2,
        }));
      }
    }, pendingKeys);
    await expect(
      creator.locator('.minesweeper-cell[data-pending="true"]'),
    ).toHaveCount(2);
    for (const key of pendingKeys) {
      await expect(cell(creator, key)).toHaveAttribute("data-pending", "true");
    }

    releaseCreatorSnapshots();
    await expect(
      creator.locator('.minesweeper-cell[data-pending="true"]'),
    ).toHaveCount(0);
    await expect(creator.getByRole("heading", { level: 1 })).toHaveText(
      "扫雷竞速进行中",
    );
    for (const key of pendingKeys) {
      await expect(cell(creator, key)).toHaveAttribute("data-flagged", "true");
      await expect(cell(invitee, key)).toHaveAttribute("data-flagged", "false");
      await cell(creator, key).click({ button: "right" });
      await expect(cell(creator, key)).toHaveAttribute("data-flagged", "false");
    }

    // A flag belongs only to its owner. The opponent can reveal the same
    // coordinate; if that coordinate is a mine, this also ends the race.
    const sharedTarget = pendingKeys[0]!;
    await cell(creator, sharedTarget).click({ button: "right" });
    await expect(cell(creator, sharedTarget)).toHaveAttribute(
      "data-flagged",
      "true",
    );
    await expect(cell(invitee, sharedTarget)).toHaveAttribute(
      "data-flagged",
      "false",
    );
    await cell(invitee, sharedTarget).click();
    await expect(cell(invitee, sharedTarget)).not.toHaveAttribute(
      "data-state",
      "hidden",
    );

    let loser: Page;
    let winner: Page;
    if (
      (await invitee.getByRole("heading", { level: 1 }).innerText()) ===
        "你踩到雷，对手获胜"
    ) {
      loser = invitee;
      winner = creator;
    } else {
      await expect(cell(creator, sharedTarget)).toHaveAttribute(
        "data-flagged",
        "true",
      );
      expect(await progressValue(invitee, "你完成进度")).toBeGreaterThan(
        initialProgress,
      );
      expect(await progressValue(creator, "你完成进度")).toBe(
        initialProgress,
      );
      await cell(creator, sharedTarget).click({ button: "right" });

      let creatorStatus = await creator
        .getByRole("heading", { level: 1 })
        .innerText();
      for (let attempt = 0; attempt < 256; attempt += 1) {
        if (creatorStatus !== "扫雷竞速进行中") break;
        const target = creator
          .locator(
            '.minesweeper-cell[data-state="hidden"][data-flagged="false"]',
          )
          .first();
        if ((await target.count()) === 0) break;
        const targetKey = await target.getAttribute("data-cell");
        if (targetKey === null) throw new Error("Hidden cell has no coordinate");
        const stableTarget = cell(creator, targetKey);
        await stableTarget.click();
        await expect(stableTarget).not.toHaveAttribute("data-state", "hidden");
        creatorStatus = await creator
          .getByRole("heading", { level: 1 })
          .innerText();
      }
      expect(creatorStatus).toBe("你踩到雷，对手获胜");
      loser = creator;
      winner = invitee;
    }

    await expect(loser.getByRole("heading", { level: 1 })).toHaveText(
      "你踩到雷，对手获胜",
    );
    await expect(winner.getByRole("heading", { level: 1 })).toHaveText(
      "对手踩雷，你赢了",
    );
    await expect(creator.locator('.minesweeper-cell[data-state="mine"]'))
      .toHaveCount(40);
    await expect(invitee.locator('.minesweeper-cell[data-state="mine"]'))
      .toHaveCount(40);

    const creatorModePanel = creator.getByRole("region", {
      name: "下一局模式",
    });
    const inviteeModePanel = invitee.getByRole("region", {
      name: "下一局模式",
    });
    await expect(creatorModePanel.getByRole("radio", { name: "中型" }))
      .toHaveAttribute("aria-checked", "true");
    await creatorModePanel.getByRole("radio", { name: "小型" }).click();
    await expect(inviteeModePanel.getByRole("radio", { name: "小型" }))
      .toHaveAttribute("aria-checked", "true");

    await creator.getByRole("button", { name: "再来一局" }).click();
    await expect(
      invitee.locator(".seat-card").filter({ hasText: "扫雷甲" }),
    ).toContainText("已准备");
    await invitee.getByRole("button", { name: "再来一局" }).click();
    await expect(creator.getByRole("heading", { level: 1 })).toHaveText(
      "等待双方准备",
    );
    await expect(invitee.getByRole("heading", { level: 1 })).toHaveText(
      "等待双方准备",
    );
    await expect(
      creator.getByText("双方准备后同时开始", { exact: true }),
    ).toBeVisible();
    await expect(creator.getByText(/第 2 局/u)).toBeVisible();
    await expect(
      creator.getByText("第 2 局 · 双人扫雷竞速 · 小型", { exact: true }),
    ).toBeVisible();
    await expect(
      creator.locator('.minesweeper-cell[data-state="hidden"]'),
    ).toHaveCount(81);
    await expect(
      invitee.locator('.minesweeper-cell[data-state="hidden"]'),
    ).toHaveCount(81);

    await leaveRoom(creator);
    await leaveRoom(invitee);
  } finally {
    if (deliverCreatorSnapshot !== null) releaseCreatorSnapshots();
    else holdCreatorSnapshots = false;
    await leaveRoomIfPresent(creator);
    await leaveRoomIfPresent(invitee);
    await inviteeContext.close();
    await creatorContext.close();
  }
});
