import { expect, test, type Page } from "@playwright/test";

async function setDisplayName(page: Page, displayName: string): Promise<void> {
  await page.getByLabel("你的昵称").fill(displayName);
  await page.getByRole("button", { name: "保存昵称" }).click();
  await expect(page.getByText("昵称已保存", { exact: true })).toBeVisible();
}

function cell(page: Page, key: string) {
  return page.locator(`[data-cell="${key}"]`);
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

async function explicitExit(page: Page): Promise<void> {
  if (page.isClosed() || !/\/r\//u.test(page.url())) return;
  const exit = page.getByRole("button", { name: "退出房间" });
  if (
    (await exit.count()) === 0 ||
    !(await exit.isVisible({ timeout: 2_000 }).catch(() => false))
  ) {
    return;
  }

  const dialogPromise = page.waitForEvent("dialog", { timeout: 2_000 });
  const clickPromise = exit.click({ timeout: 2_000 });
  const dialog = await dialogPromise;
  expect(dialog.type()).toBe("confirm");
  await dialog.accept();
  await clickPromise;
  await expect(page).toHaveURL("/", { timeout: 5_000 });
}

test("two players start privately, sweep concurrently, and rematch", async ({
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

  // Briefly hold snapshots from the server so two clicks can be observed as
  // independently pending. Page-to-server messages keep flowing normally.
  let holdCreatorSnapshots = false;
  let deliverCreatorSnapshot: ((message: string) => void) | null = null;
  const heldCreatorSnapshots: string[] = [];
  await creator.routeWebSocket(/\/websocket$/u, (socket) => {
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
    await creator.getByRole("button", { name: "双人扫雷 · 中型" }).click();
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
      creator.getByText("已准备，等待对手准备", { exact: true }),
    ).toBeVisible();
    await invitee.getByRole("button", { name: "准备", exact: true }).click();
    await expect(
      creator.getByText(/\d 秒后选择一个起始格/u),
    ).toBeVisible();
    await expect(
      invitee.getByText(/\d 秒后选择一个起始格/u),
    ).toBeVisible();

    await expect(
      creator.getByText("请选择你的秘密起始格", { exact: true }),
    ).toBeVisible({ timeout: 5_000 });
    await expect(
      invitee.getByText("请选择你的秘密起始格", { exact: true }),
    ).toBeVisible({ timeout: 5_000 });

    const creatorStart = "1,1";
    const inviteeStart = "14,14";
    await cell(creator, creatorStart).click();
    await expect(
      creator.getByText("起始格已提交，等待对手", { exact: true }),
    ).toBeVisible();
    await expect(
      invitee.getByText("请选择你的秘密起始格", { exact: true }),
    ).toBeVisible();
    await expect(cell(invitee, creatorStart)).toHaveAttribute(
      "data-state",
      "hidden",
    );
    await expect(
      invitee.locator('.minesweeper-cell[data-state="hidden"]'),
    ).toHaveCount(256);

    await cell(invitee, inviteeStart).click();
    await expect(creator.getByRole("heading", { level: 1 })).toHaveText(
      "双方同时排雷",
    );
    await expect(invitee.getByRole("heading", { level: 1 })).toHaveText(
      "双方同时排雷",
    );
    await expect(cell(creator, creatorStart)).toHaveAttribute(
      "data-state",
      "revealed",
    );
    await expect(cell(creator, inviteeStart)).toHaveAttribute(
      "data-state",
      "revealed",
    );
    await expect(cell(invitee, creatorStart)).toHaveAttribute(
      "data-state",
      "revealed",
    );
    await expect(cell(invitee, inviteeStart)).toHaveAttribute(
      "data-state",
      "revealed",
    );

    const flagTarget = creator
      .locator(
        '.minesweeper-cell[data-state="hidden"][data-flagged="false"]',
      )
      .first();
    const flagKey = await flagTarget.getAttribute("data-cell");
    if (flagKey === null) throw new Error("No hidden cell available to flag");
    await flagTarget.click({ button: "right" });
    await expect(cell(creator, flagKey)).toHaveAttribute(
      "data-flagged",
      "true",
    );
    await expect(cell(invitee, flagKey)).toHaveAttribute(
      "data-flagged",
      "false",
    );
    await expect(invitee.locator(".minesweeper-cell.is-flagged")).toHaveCount(0);
    await cell(creator, flagKey).click({ button: "right" });
    await expect(cell(creator, flagKey)).toHaveAttribute(
      "data-flagged",
      "false",
    );

    const simultaneousKeys = await creator
      .locator(
        '.minesweeper-cell[data-state="hidden"][data-flagged="false"]',
      )
      .evaluateAll((elements) => {
        const candidates = elements.map((element) =>
          element.getAttribute("data-cell"),
        ).filter((key): key is string => key !== null);
        return candidates.length < 2
          ? candidates
          : [candidates[0]!, candidates[candidates.length - 1]!];
      });
    expect(simultaneousKeys).toHaveLength(2);

    holdCreatorSnapshots = true;
    await creator.evaluate((keys) => {
      for (const key of keys) {
        const target = document.querySelector<HTMLButtonElement>(
          `[data-cell="${key}"]`,
        );
        if (target === null) throw new Error(`Missing cell ${key}`);
        target.click();
      }
    }, simultaneousKeys);
    await expect(
      creator.locator('.minesweeper-cell[data-pending="true"]'),
    ).toHaveCount(2);
    for (const key of simultaneousKeys) {
      await expect(cell(creator, key)).toHaveAttribute("data-pending", "true");
    }

    releaseCreatorSnapshots();
    await expect(
      creator.locator('.minesweeper-cell[data-pending="true"]'),
    ).toHaveCount(0);

    let creatorStatus = await creator
      .getByRole("heading", { level: 1 })
      .innerText();
    let hitMine = creatorStatus === "对手获胜";
    for (let attempt = 0; attempt < 256 && !hitMine; attempt += 1) {
      if (creatorStatus !== "双方同时排雷") break;
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
      hitMine = creatorStatus === "对手获胜";
    }

    expect(hitMine, "the reveal loop should eventually click a mine").toBe(true);
    await expect(creator.getByRole("heading", { level: 1 })).toHaveText(
      "对手获胜",
    );
    await expect(invitee.getByRole("heading", { level: 1 })).toHaveText(
      "你赢了",
    );
    await expect(creator.locator('.minesweeper-cell[data-state="mine"]'))
      .toHaveCount(40);
    await expect(invitee.locator('.minesweeper-cell[data-state="mine"]'))
      .toHaveCount(40);

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
      creator.getByText("双方准备后开始倒计时", { exact: true }),
    ).toBeVisible();
    await expect(creator.getByText(/第 2 局/u)).toBeVisible();
    await expect(
      creator.locator('.minesweeper-cell[data-state="hidden"]'),
    ).toHaveCount(256);

    await explicitExit(creator);
    await explicitExit(invitee);
  } finally {
    if (deliverCreatorSnapshot !== null) releaseCreatorSnapshots();
    else holdCreatorSnapshots = false;
    await explicitExit(creator).catch(() => undefined);
    await explicitExit(invitee).catch(() => undefined);
    await inviteeContext.close();
    await creatorContext.close();
  }
});
