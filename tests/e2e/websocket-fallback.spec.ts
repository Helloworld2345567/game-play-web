import { expect, test, type Page } from "@playwright/test";

async function blockWebSockets(page: Page): Promise<() => number> {
  let attempts = 0;
  await page.routeWebSocket(/\/api\/rooms\/[^/]+\/websocket$/u, (socket) => {
    attempts += 1;
    socket.close({ code: 1001, reason: "blocked by test network" });
  });
  return () => attempts;
}

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

async function exitRoom(page: Page): Promise<void> {
  const dialogPromise = page.waitForEvent("dialog");
  const clickPromise = page.getByRole("button", { name: "退出房间" }).click();
  const dialog = await dialogPromise;
  await dialog.accept();
  await clickPromise;
  await expect(page).toHaveURL("/");
}

test("falls back to HTTP when the network blocks WebSocket upgrades", async ({
  browser,
}) => {
  const creatorContext = await browser.newContext();
  const inviteeContext = await browser.newContext();
  const creator = await creatorContext.newPage();
  const invitee = await inviteeContext.newPage();
  const [creatorWebSocketAttempts, inviteeWebSocketAttempts] =
    await Promise.all([blockWebSockets(creator), blockWebSockets(invitee)]);

  try {
    await creator.goto("/");
    await creator.getByRole("button", { name: "创建五子棋房" }).click();
    await expect(creator).toHaveURL(/\/r\/[A-Za-z0-9_-]{16}$/u);
    const inviteUrl = creator.url();

    await invitee.goto(inviteUrl);

    await expect(creator.getByRole("heading", { level: 1 })).toHaveText(
      "轮到你",
    );
    await expect(invitee.getByRole("heading", { level: 1 })).toHaveText(
      "等待对手落子",
    );
    await expect(creator.locator(".connection-pill")).toContainText(
      "兼容连接",
    );

    await placeStone(creator, 7, 7);
    await expect(creator.getByRole("heading", { level: 1 })).toHaveText(
      "等待对手落子",
    );
    await expect(invitee.getByRole("heading", { level: 1 })).toHaveText(
      "轮到你",
    );
    await expect(invitee.locator(".board-last-move")).toContainText(
      "黑方落在第 8 列、第 8 行",
    );

    await creatorContext.setOffline(true);
    await expect(creator.locator(".connection-pill")).toContainText(
      "设备已离线",
    );
    await placeStone(invitee, 0, 0);
    await creatorContext.setOffline(false);
    await expect(creator.locator(".connection-pill")).toContainText(
      "兼容连接",
    );
    await expect(creator.locator(".board-last-move")).toContainText(
      "白方落在第 1 列、第 1 行",
    );

    await creator.waitForTimeout(3_000);
    expect(creatorWebSocketAttempts()).toBe(1);
    expect(inviteeWebSocketAttempts()).toBe(1);
  } finally {
    await inviteeContext.close();
    await creatorContext.close();
  }
});

test("retires a fallback Room after both HTTP clients explicitly leave", async ({
  browser,
}) => {
  const creatorContext = await browser.newContext();
  const inviteeContext = await browser.newContext();
  const creator = await creatorContext.newPage();
  const invitee = await inviteeContext.newPage();
  await Promise.all([blockWebSockets(creator), blockWebSockets(invitee)]);

  try {
    await creator.goto("/");
    await creator.getByRole("button", { name: "创建五子棋房" }).click();
    await expect(creator).toHaveURL(/\/r\/[A-Za-z0-9_-]{16}$/u);
    const inviteUrl = creator.url();

    await invitee.goto(inviteUrl);
    await expect(creator.locator(".connection-pill")).toContainText(
      "兼容连接",
    );
    await expect(invitee.locator(".connection-pill")).toContainText(
      "兼容连接",
    );

    await exitRoom(creator);
    await exitRoom(invitee);

    await creator.goto(inviteUrl);
    await expect(creator.getByRole("heading", { level: 1 })).toHaveText(
      "没能进入这个房间",
    );
    await expect(
      creator.getByText("房间不存在或已经过期。", { exact: true }),
    ).toBeVisible();
  } finally {
    await inviteeContext.close();
    await creatorContext.close();
  }
});

test("reuses one HTTP presence across reload before an explicit leave", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await blockWebSockets(page);

  try {
    await page.goto("/");
    await page.getByRole("button", { name: "创建五子棋房" }).click();
    await expect(page).toHaveURL(/\/r\/[A-Za-z0-9_-]{16}$/u);
    const inviteUrl = page.url();
    await expect(page.locator(".connection-pill")).toContainText(
      "兼容连接",
    );

    await page.reload();
    await expect(page.locator(".connection-pill")).toContainText(
      "兼容连接",
    );
    await exitRoom(page);

    await page.goto(inviteUrl);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "没能进入这个房间",
    );
  } finally {
    await context.close();
  }
});

test("retries when an HTTPS compatibility request is accepted but stalls", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  let syncAttempts = 0;
  await page.route(/\/api\/rooms\/[^/]+\/sync$/u, async (route) => {
    syncAttempts += 1;
    if (syncAttempts === 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 9_000));
    }
    await route.continue().catch(() => undefined);
  });
  await blockWebSockets(page);

  try {
    await page.goto("/");
    await page.getByRole("button", { name: "创建五子棋房" }).click();
    await expect(page).toHaveURL(/\/r\/[A-Za-z0-9_-]{16}$/u);
    await expect(page.locator(".connection-pill")).toHaveText("兼容连接", {
      timeout: 15_000,
    });
    expect(syncAttempts).toBeGreaterThanOrEqual(2);
  } finally {
    await context.close();
  }
});
