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
  await page.clock.install();
  await page.route("**/api/stats", async (route) => {
    const body = route.request().postDataJSON() as { presenceId: string };
    presenceIds.push(body.presenceId);
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
  let leavingPresenceId: string | undefined;
  await page.route("**/api/stats", async (route) => {
    heartbeatPresenceId = (
      route.request().postDataJSON() as { presenceId: string }
    ).presenceId;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ onlineGuests: 1, activeRooms: 0 }),
    });
  });
  await page.route("**/api/presence/leave", async (route) => {
    leavingPresenceId = (
      route.request().postDataJSON() as { presenceId: string }
    ).presenceId;
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
