import { expect, test, type Browser, type Page } from "@playwright/test";
import { leaveRoom, leaveRoomIfPresent } from "./room-cleanup";

async function blockWebSockets(page: Page): Promise<() => number> {
  let attempts = 0;
  await page.routeWebSocket(
    /\/api\/rooms\/[^/]+\/websocket(?:\?.*)?$/u,
    (socket) => {
      attempts += 1;
      socket.close({ code: 1001, reason: "blocked by test network" });
    },
  );
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

test("falls back to HTTP when the network blocks WebSocket upgrades", async ({
  browser,
}) => {
  const creatorContext = await browser.newContext({
    extraHTTPHeaders: { "CF-Connecting-IP": "198.51.100.101" },
  });
  const inviteeContext = await browser.newContext({
    extraHTTPHeaders: { "CF-Connecting-IP": "198.51.100.101" },
  });
  const spectatorContext = await browser.newContext({
    extraHTTPHeaders: { "CF-Connecting-IP": "198.51.100.101" },
  });
  const creator = await creatorContext.newPage();
  const invitee = await inviteeContext.newPage();
  const spectator = await spectatorContext.newPage();
  const [
    creatorWebSocketAttempts,
    inviteeWebSocketAttempts,
    spectatorWebSocketAttempts,
  ] = await Promise.all([
    blockWebSockets(creator),
    blockWebSockets(invitee),
    blockWebSockets(spectator),
  ]);

  try {
    await creator.goto("/");
    await creator.getByRole("button", { name: "创建五子棋房" }).click();
    await expect(creator).toHaveURL(/\/r\/[A-Za-z0-9_-]{16}$/u);
    const inviteUrl = creator.url();

    await creator.locator('[data-role-id="black"]').click();
    await expect(creator.locator(".opening-role-status")).toHaveText(
      "已选择黑方，等待对手",
    );
    await invitee.goto(inviteUrl);
    await spectator.goto(inviteUrl);

    await expect(invitee.locator('[data-role-id="black"]')).toBeDisabled();
    await invitee.locator('[data-role-id="white"]').click();
    await expect(creator.getByRole("heading", { level: 1 })).toHaveText(
      "轮到你",
    );
    await expect(invitee.getByRole("heading", { level: 1 })).toHaveText(
      "等待对手落子",
    );
    await expect(creator.locator(".connection-pill")).toContainText(
      "兼容连接",
    );
    await expect(spectator.locator(".connection-pill")).toContainText(
      "兼容连接",
    );
    await expect(spectator.getByRole("heading", { level: 1 })).toHaveText(
      "正在观战",
    );
    await expect(spectator.getByRole("button", { name: "认输" })).toHaveCount(0);

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
    await expect(spectator.locator(".board-last-move")).toContainText(
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
    // Recovery probes are bounded; a blocked network must remain playable.
    for (const attempts of [creatorWebSocketAttempts, inviteeWebSocketAttempts, spectatorWebSocketAttempts]) {
      expect(attempts()).toBeGreaterThanOrEqual(1);
      expect(attempts()).toBeLessThanOrEqual(3);
    }
  } finally {
    await leaveRoomIfPresent(spectator);
    await leaveRoomIfPresent(invitee);
    await leaveRoomIfPresent(creator);
    await spectatorContext.close();
    await inviteeContext.close();
    await creatorContext.close();
  }
});

async function strictFallbackRoom(
  browser: Browser,
  configureCreator: (page: Page) => Promise<void> = async (page) => { await blockWebSockets(page); },
) {
  const creatorContext = await browser.newContext();
  const inviteeContext = await browser.newContext();
  const creator = await creatorContext.newPage();
  const invitee = await inviteeContext.newPage();
  await configureCreator(creator);
  await creator.goto("/");
  await creator.getByRole("button", { name: "创建五子棋房" }).click();
  await expect(creator).toHaveURL(/\/r\/[A-Za-z0-9_-]{16}$/u);
  await creator.locator('[data-role-id="black"]').click();
  await expect(creator.locator(".opening-role-status")).toContainText("已选择黑方");
  await invitee.goto(creator.url());
  await invitee.locator('[data-role-id="white"]').click();
  await expect(creator.getByRole("heading", { level: 1 })).toHaveText("轮到你");
  return { creator, invitee, async close() {
    await leaveRoomIfPresent(invitee);
    await leaveRoomIfPresent(creator);
    await inviteeContext.close();
    await creatorContext.close();
  } };
}

test("unlocks a strict action that never committed even when ordinary sync is unchanged", async ({ browser }) => {
  const room = await strictFallbackRoom(browser);
  try {
    let failed = false;
    let reconciliationRequests = 0;
    room.creator.on("request", (request) => {
      if (failed && /\/sync$/u.test(request.url()) &&
        request.postDataJSON().sinceSnapshotRevision === undefined) reconciliationRequests += 1;
    });
    await room.creator.route(/\/command$/u, async (route) => {
      if (!failed) {
        failed = true;
        await route.abort("failed");
      } else await route.continue();
    });
    await placeStone(room.creator, 7, 7);
    await expect(room.creator.getByText("连接已恢复，但刚才的操作未被确认，请重试。", { exact: true })).toBeVisible();
    await expect(room.creator.getByText("正在等待房间确认…", { exact: true })).toHaveCount(0);
    expect(reconciliationRequests).toBeGreaterThanOrEqual(1);
    await placeStone(room.creator, 7, 7);
    await expect(room.invitee.locator(".board-last-move")).toContainText("黑方落在第 8 列、第 8 行");
  } finally { await room.close(); }
});

test("reconciles a committed strict action whose HTTP response was lost without replaying it", async ({ browser }) => {
  const room = await strictFallbackRoom(browser);
  try {
    let commands = 0;
    await room.creator.route(/\/command$/u, async (route) => {
      commands += 1;
      await route.fetch();
      await route.abort("failed");
    });
    await placeStone(room.creator, 7, 7);
    await expect(room.creator.getByRole("heading", { level: 1 })).toHaveText("等待对手落子");
    await expect(room.creator.getByText("正在等待房间确认…", { exact: true })).toHaveCount(0);
    await expect(room.invitee.locator(".board-last-move")).toContainText("黑方落在第 8 列、第 8 行");
    expect(commands).toBe(1);
  } finally { await room.close(); }
});

test("bounds strict WebSocket confirmation and reconciles an application-level lost command", async ({ browser }) => {
  let dropped = false;
  const room = await strictFallbackRoom(browser, async (page) => {
    await page.routeWebSocket(/\/websocket(?:\?.*)?$/u, (socket) => {
      const server = socket.connectToServer();
      socket.onMessage((message) => {
        const text = typeof message === "string" ? message : message.toString();
        if (text !== "ping" && JSON.parse(text).type === "game_action") {
          dropped = true;
          return;
        }
        server.send(message);
      });
    });
  });
  try {
    await placeStone(room.creator, 7, 7);
    await expect.poll(() => dropped).toBe(true);
    await expect(room.creator.getByText("连接已恢复，但刚才的操作未被确认，请重试。", { exact: true }))
      .toBeVisible({ timeout: 12_000 });
    await expect(room.creator.locator(".connection-pill")).toHaveText("兼容连接");
    await placeStone(room.creator, 7, 7);
    await expect(room.invitee.locator(".board-last-move")).toContainText("黑方落在第 8 列、第 8 行");
  } finally { await room.close(); }
});

test("retires a fallback Room after both HTTP clients explicitly leave", async ({
  browser,
}) => {
  const creatorContext = await browser.newContext({
    extraHTTPHeaders: { "CF-Connecting-IP": "198.51.100.102" },
  });
  const inviteeContext = await browser.newContext({
    extraHTTPHeaders: { "CF-Connecting-IP": "198.51.100.102" },
  });
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

    await leaveRoom(creator);
    await leaveRoom(invitee);

    await creator.goto(inviteUrl);
    await expect(creator.getByRole("heading", { level: 1 })).toHaveText(
      "没能进入这个房间",
    );
    await expect(
      creator.getByText("房间不存在或已经过期。", { exact: true }),
    ).toBeVisible();
  } finally {
    await leaveRoomIfPresent(invitee);
    await leaveRoomIfPresent(creator);
    await inviteeContext.close();
    await creatorContext.close();
  }
});

test("reuses one HTTP presence across reload before an explicit leave", async ({
  browser,
}) => {
  const context = await browser.newContext({
    extraHTTPHeaders: { "CF-Connecting-IP": "198.51.100.103" },
  });
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
    await leaveRoom(page);

    await page.goto(inviteUrl);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "没能进入这个房间",
    );
  } finally {
    await leaveRoomIfPresent(page);
    await context.close();
  }
});

test("retries when an HTTPS compatibility request is accepted but stalls", async ({
  browser,
}) => {
  const context = await browser.newContext({
    extraHTTPHeaders: { "CF-Connecting-IP": "198.51.100.104" },
  });
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
    await leaveRoomIfPresent(page);
    await context.close();
  }
});

test("automatically restores WebSocket and can immediately retire the last player's upgraded room", async ({ browser }) => {
  test.setTimeout(40_000);
  const context = await browser.newContext();
  const page = await context.newPage();
  let blocked = true;
  let attempts = 0;
  await page.addInitScript(() => {
    const metrics: unknown[] = [];
    (window as unknown as { roomMetrics: unknown[] }).roomMetrics = metrics;
    window.addEventListener("room-session-metric", (event) => {
      metrics.push((event as CustomEvent).detail);
    });
  });
  await page.routeWebSocket(/\/websocket(?:\?.*)?$/u, (socket) => {
    attempts += 1;
    if (blocked) socket.close({ code: 1001, reason: "temporary network failure" });
    else socket.connectToServer();
  });
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "创建五子棋房" }).click();
    await expect(page.locator(".connection-pill")).toHaveText("兼容连接");
    const roomUrl = page.url();
    blocked = false;
    // No reload, manual reconnect or synthetic online event: the timer must
    // detect that WebSocket is usable again while HTTP keeps the room alive.
    await expect(page.locator(".connection-pill")).toHaveText("连接正常", { timeout: 20_000 });
    expect(attempts).toBe(2);
    const metrics = await page.evaluate(() =>
      (window as unknown as { roomMetrics: { name: string; durationMs: number }[] }).roomMetrics);
    expect(metrics.some((metric) => metric.name === "websocket_recovery" && metric.durationMs > 0)).toBe(true);
    await leaveRoom(page);
    await page.goto(roomUrl);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("没能进入这个房间");
  } finally {
    await leaveRoomIfPresent(page);
    await context.close();
  }
});

test("an open recovery socket without a snapshot never interrupts the HTTP game", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  let attempts = 0;
  await page.routeWebSocket(/\/websocket(?:\?.*)?$/u, (socket) => {
    attempts += 1;
    if (attempts === 1) socket.close({ code: 1001, reason: "temporary failure" });
    // Subsequent sockets open but deliberately never provide any Room state.
  });
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "创建五子棋房" }).click();
    await expect(page.locator(".connection-pill")).toHaveText("兼容连接");
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(() => attempts).toBe(2);
    await page.locator('[data-role-id="black"]').click();
    await expect(page.locator(".opening-role-status")).toContainText("已选择黑方");
    await expect(page.locator(".connection-pill")).toHaveText("兼容连接");
    // After the eight-second snapshot deadline the same HTTP session works.
    await page.waitForTimeout(8_200);
    await expect(page.locator(".connection-pill")).toHaveText("兼容连接");
    expect(attempts).toBe(2);
  } finally {
    await leaveRoomIfPresent(page);
    await context.close();
  }
});

test("drains queued concurrent HTTP actions before promoting a recovery socket", async ({ browser }) => {
  test.setTimeout(45_000);
  const creatorContext = await browser.newContext();
  const inviteeContext = await browser.newContext();
  const creator = await creatorContext.newPage();
  const invitee = await inviteeContext.newPage();
  let allowWebSocket = false;
  let probeOpened = false;
  const wsSequences: number[] = [];
  const httpSequences: number[] = [];
  let releaseCommand!: () => void;
  const heldCommand = new Promise<void>((resolve) => { releaseCommand = resolve; });
  await creator.routeWebSocket(/\/websocket(?:\?.*)?$/u, (socket) => {
    if (!allowWebSocket) { socket.close({ code: 1001 }); return; }
    const server = socket.connectToServer();
    server.onMessage((message) => { probeOpened = true; socket.send(message); });
    socket.onMessage((message) => {
      const text = typeof message === "string" ? message : message.toString();
      if (text !== "ping") {
        const command = JSON.parse(text);
        if (command.type === "game_action") wsSequences.push(command.clientSeq);
      }
      server.send(message);
    });
  });
  try {
    await creator.goto("/");
    await creator.getByRole("button", { name: "扫雷，选择玩法和难度" }).click();
    const picker = creator.getByRole("dialog", { name: "扫雷" });
    await picker.getByRole("radio", { name: /双人竞速/u }).check();
    await picker.getByRole("radio", { name: "小型", exact: true }).check();
    await picker.getByRole("button", { name: "创建竞速房间" }).click();
    await expect(creator.locator(".connection-pill")).toHaveText("兼容连接");
    await invitee.goto(creator.url());
    await creator.getByRole("button", { name: "准备", exact: true }).click();
    await expect(creator.getByText("已准备，等待对手", { exact: true })).toBeVisible();
    await invitee.getByRole("button", { name: "准备", exact: true }).click();
    await expect(creator.getByText("尽快排完你的棋盘", { exact: true })).toBeVisible();
    const keys = await creator.locator('.minesweeper-cell[data-state="hidden"]').evaluateAll((cells) =>
      cells.slice(0, 3).map((cell) => cell.getAttribute("data-cell")!));
    expect(keys).toHaveLength(3);
    await creator.route(/\/command$/u, async (route) => {
      const command = route.request().postDataJSON().command;
      if (command.type === "game_action") {
        httpSequences.push(command.clientSeq);
        if (httpSequences.length === 1) await heldCommand;
      }
      await route.continue().catch(() => undefined);
    });
    await creator.locator(`[data-cell="${keys[0]}"]`).click({ button: "right" });
    await expect.poll(() => httpSequences.length).toBe(1);
    allowWebSocket = true;
    await creator.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(() => probeOpened).toBe(true);
    await creator.locator(`[data-cell="${keys[1]}"]`).click({ button: "right" });
    await expect(creator.locator(".connection-pill")).toHaveText("兼容连接");
    expect(wsSequences).toEqual([]);
    expect(httpSequences).toHaveLength(1);
    releaseCommand();
    await expect(creator.locator(".connection-pill")).toHaveText("连接正常");
    expect(httpSequences).toHaveLength(2);
    expect(httpSequences[1]).toBeGreaterThan(httpSequences[0]!);
    for (const key of keys.slice(0, 2)) {
      await expect(creator.locator(`[data-cell="${key}"]`)).toHaveAttribute("data-flagged", "true");
    }
    await creator.locator(`[data-cell="${keys[2]}"]`).click({ button: "right" });
    await expect.poll(() => wsSequences.length).toBe(1);
    expect(wsSequences[0]).toBeGreaterThan(httpSequences[1]!);
    await expect(creator.locator(`[data-cell="${keys[2]}"]`)).toHaveAttribute("data-flagged", "true");
  } finally {
    releaseCommand();
    await leaveRoomIfPresent(invitee);
    await leaveRoomIfPresent(creator);
    await inviteeContext.close();
    await creatorContext.close();
  }
});
