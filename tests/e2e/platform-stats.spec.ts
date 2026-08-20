import { expect, test } from "@playwright/test";

test("shows the current online Guest and active Room counts on the home page", async ({
  page,
}) => {
  await page.route("**/api/stats", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ onlineGuests: 7, activeRooms: 3 }),
    });
  });

  await page.goto("/");

  const stats = page.getByLabel("平台实时状态");
  await expect(stats).toContainText("在线 7 人");
  await expect(stats).toContainText("房间 3 个");
});

test("refreshes the platform stats with one stable page Presence", async ({
  page,
}) => {
  const presenceIds: string[] = [];
  const clientSeqs: number[] = [];
  await page.clock.install();
  await page.route("**/api/stats", async (route) => {
    const body = route.request().postDataJSON() as {
      presenceId: string;
      clientSeq: number;
    };
    presenceIds.push(body.presenceId);
    clientSeqs.push(body.clientSeq);
    const latest = presenceIds.length === 1
      ? { onlineGuests: 1, activeRooms: 0 }
      : { onlineGuests: 2, activeRooms: 1 };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(latest),
    });
  });
  await page.goto("/");
  const stats = page.getByLabel("平台实时状态");
  await expect(stats).toContainText("在线 1 人");

  await page.clock.fastForward(10_000);

  await expect(stats).toContainText("在线 2 人");
  await expect(stats).toContainText("房间 1 个");
  expect(presenceIds).toHaveLength(2);
  expect(presenceIds[0]).toMatch(/^[0-9a-f-]{36}$/u);
  expect(presenceIds[1]).toBe(presenceIds[0]);
  expect(clientSeqs).toEqual([1, 2]);
});

test("keeps visitors online outside the home page", async ({ page }) => {
  let heartbeatCount = 0;
  await page.route("**/api/stats", async (route) => {
    heartbeatCount += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ onlineGuests: 1, activeRooms: 0 }),
    });
  });

  await page.goto("/minesweeper");

  await expect.poll(() => heartbeatCount).toBe(1);
  await expect(page.getByRole("heading", { name: "扫雷" })).toBeVisible();
});

test("leaves the same page Presence when the document is hidden", async ({
  page,
}) => {
  let heartbeatPresenceId: string | undefined;
  let heartbeatClientSeq: number | undefined;
  let leavingPresenceId: string | undefined;
  let leavingClientSeq: number | undefined;
  await page.route("**/api/stats", async (route) => {
    const body = route.request().postDataJSON() as {
      presenceId: string;
      clientSeq: number;
    };
    heartbeatPresenceId = body.presenceId;
    heartbeatClientSeq = body.clientSeq;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ onlineGuests: 1, activeRooms: 0 }),
    });
  });
  await page.route("**/api/presence/leave", async (route) => {
    const body = route.request().postDataJSON() as {
      presenceId: string;
      clientSeq: number;
    };
    leavingPresenceId = body.presenceId;
    leavingClientSeq = body.clientSeq;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ onlineGuests: 0, activeRooms: 0 }),
    });
  });
  await page.goto("/");
  await expect.poll(() => heartbeatPresenceId).toBeTruthy();

  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pagehide"));
  });

  await expect.poll(() => leavingPresenceId).toBe(heartbeatPresenceId);
  expect(leavingClientSeq).toBeGreaterThan(heartbeatClientSeq!);
});

test("renews Presence immediately when a cached page is shown again", async ({
  page,
}) => {
  let heartbeatCount = 0;
  await page.route("**/api/stats", async (route) => {
    heartbeatCount += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ onlineGuests: heartbeatCount, activeRooms: 0 }),
    });
  });
  await page.route("**/api/presence/leave", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ onlineGuests: 0, activeRooms: 0 }),
    });
  });
  await page.goto("/");
  await expect.poll(() => heartbeatCount).toBe(1);

  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pagehide", {
      persisted: true,
    }));
    window.dispatchEvent(new PageTransitionEvent("pageshow", {
      persisted: true,
    }));
  });

  await expect.poll(() => heartbeatCount).toBe(2);
});

test("serializes the first Guest session across new browser tabs", async ({
  context,
  page,
}) => {
  let sessionRequestsInFlight = 0;
  let maximumSessionConcurrency = 0;
  const sessionCookies: string[] = [];
  const bootstrapIds: Array<string | undefined> = [];
  await context.route("**/api/session", async (route) => {
    sessionRequestsInFlight += 1;
    maximumSessionConcurrency = Math.max(
      maximumSessionConcurrency,
      sessionRequestsInFlight,
    );
    sessionCookies.push(route.request().headers().cookie ?? "");
    bootstrapIds.push(
      (route.request().postDataJSON() as { bootstrapId?: string }).bootstrapId,
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const response = await route.fetch();
      await route.fulfill({ response });
    } finally {
      sessionRequestsInFlight -= 1;
    }
  });
  await context.route("**/api/stats", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ onlineGuests: 1, activeRooms: 0 }),
    });
  });
  const secondPage = await context.newPage();

  await Promise.all([page.goto("/"), secondPage.goto("/")]);
  await expect(page.getByLabel("平台实时状态")).toContainText("在线 1 人");
  await expect(secondPage.getByLabel("平台实时状态")).toContainText(
    "在线 1 人",
  );

  expect(maximumSessionConcurrency).toBe(1);
  expect(sessionCookies).toHaveLength(2);
  expect(sessionCookies[0]).toBe("");
  expect(sessionCookies[1]).toContain("ym_session=");
  expect(bootstrapIds[0]).toMatch(/^[0-9a-f-]{36}$/u);
  expect(bootstrapIds[1]).toBe(bootstrapIds[0]);
  await secondPage.close();
});

test("deduplicates first sessions when Web Locks are unavailable", async ({
  context,
  page,
}) => {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: undefined,
    });
  });
  let sessionRequestsInFlight = 0;
  let maximumSessionConcurrency = 0;
  const bootstrapIds: string[] = [];
  const issuedCookies: string[] = [];
  await context.route("**/api/session", async (route) => {
    sessionRequestsInFlight += 1;
    maximumSessionConcurrency = Math.max(
      maximumSessionConcurrency,
      sessionRequestsInFlight,
    );
    bootstrapIds.push(
      (route.request().postDataJSON() as { bootstrapId: string }).bootstrapId,
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const response = await route.fetch();
      issuedCookies.push(response.headers()["set-cookie"] ?? "");
      await route.fulfill({ response });
    } finally {
      sessionRequestsInFlight -= 1;
    }
  });
  await context.route("**/api/stats", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ onlineGuests: 1, activeRooms: 0 }),
    });
  });
  const secondPage = await context.newPage();

  await Promise.all([page.goto("/"), secondPage.goto("/")]);
  await expect(page.getByLabel("平台实时状态")).toContainText("在线 1 人");
  await expect(secondPage.getByLabel("平台实时状态")).toContainText(
    "在线 1 人",
  );

  expect(maximumSessionConcurrency).toBe(2);
  expect(bootstrapIds).toHaveLength(2);
  expect(bootstrapIds[1]).toBe(bootstrapIds[0]);
  expect(issuedCookies).toHaveLength(2);
  expect(issuedCookies[1]).toBe(issuedCookies[0]);
  await secondPage.close();
});

test("rotates the browser bootstrap after its short deduplication window", async ({
  context,
  page,
}) => {
  await page.clock.install({ time: new Date("2026-08-20T12:00:00Z") });
  const bootstrapIds: string[] = [];
  await page.route("**/api/session", async (route) => {
    bootstrapIds.push(
      (route.request().postDataJSON() as { bootstrapId: string }).bootstrapId,
    );
    const response = await route.fetch();
    await route.fulfill({ response });
  });
  await page.route("**/api/stats", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ onlineGuests: 1, activeRooms: 0 }),
    });
  });

  await page.goto("/");
  await expect.poll(() => bootstrapIds.length).toBe(1);
  await context.clearCookies();
  await page.clock.fastForward(2 * 60_000);
  await page.reload();
  await expect.poll(() => bootstrapIds.length).toBe(2);
  await expect(page.getByLabel("平台实时状态")).toContainText("在线 1 人");

  expect(bootstrapIds[0]).toMatch(/^[0-9a-f-]{36}$/u);
  expect(bootstrapIds[1]).toMatch(/^[0-9a-f-]{36}$/u);
  expect(bootstrapIds[1]).not.toBe(bootstrapIds[0]);
});
