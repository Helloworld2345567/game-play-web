import { expect, test, type Locator, type Page } from "@playwright/test";

function board(page: Page, level: number): Locator {
  return page.getByRole("grid", {
    name: new RegExp(`推箱子棋盘，第 ${level} 关`, "u"),
  });
}

function moveCount(page: Page): Locator {
  return page.getByText("本关步数", { exact: true }).locator("..").locator("strong");
}

const LEVEL_ONE_SOLUTION = "DLURRRDLULLDDRULURUULDRDDRRULDLUU";

async function solveLevelOne(page: Page): Promise<void> {
  const keyForMove = {
    D: "ArrowDown",
    L: "ArrowLeft",
    R: "ArrowRight",
    U: "ArrowUp",
  } as const;
  await expect(board(page, 1)).toHaveAttribute("data-progress-ready", "true");
  await board(page, 1).focus();
  for (const move of LEVEL_ONE_SOLUTION.slice(0, -1)) {
    await page.keyboard.press(keyForMove[move as keyof typeof keyForMove]);
  }
  await page.keyboard.press("ArrowUp");
}

test("opens Sokoban, switches levels, undoes a move, and stays within mobile width", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "推箱子，开始本机游戏" }).click();

  await expect(page).toHaveURL(/\/sokoban\/?$/u);
  await expect(page.getByRole("heading", { level: 1, name: "推箱子" })).toBeVisible();

  const levelButtons = page.getByRole("button", { name: /^第 \d+ 关$/u });
  await expect(levelButtons).toHaveCount(20);

  const firstBoard = board(page, 1);
  await expect(firstBoard).toHaveAttribute("aria-rowcount", "7");
  await expect(firstBoard).toHaveAttribute("aria-colcount", "6");
  await expect(firstBoard.getByRole("row")).toHaveCount(7);
  await expect(firstBoard.getByRole("gridcell")).toHaveCount(42);
  await expect(firstBoard).toHaveAttribute("data-progress-ready", "true");

  await firstBoard.focus();
  await page.keyboard.press("ArrowRight");
  await expect(moveCount(page)).toHaveText("1");

  await page.getByRole("button", { name: "撤销一步", exact: true }).click();
  await expect(moveCount(page)).toHaveText("0");

  await page.getByRole("button", { name: "第 2 关", exact: true }).click();
  await expect(page).toHaveURL(/\/sokoban\?level=2$/u);
  const secondBoard = board(page, 2);
  await expect(secondBoard).toHaveAttribute("aria-rowcount", "7");
  await expect(secondBoard).toHaveAttribute("aria-colcount", "6");
  await page.getByRole("button", { name: /^重新开始/u }).click();

  await page.setViewportSize({ width: 360, height: 800 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
});

test("waits for a bound Guest identity before accepting moves", async ({
  page,
}) => {
  let releaseProgress: (() => void) | undefined;
  const progressGate = new Promise<void>((resolve) => {
    releaseProgress = resolve;
  });
  await page.route("**/api/sokoban/progress", async (route) => {
    await progressGate;
    await route.continue();
  });

  try {
    await page.goto("/sokoban");
    const firstBoard = board(page, 1);
    await expect(firstBoard).toHaveAttribute("data-progress-ready", "false");
    await expect(
      page.getByRole("button", { name: "向右移动" }),
    ).toBeDisabled();

    await firstBoard.focus();
    await page.keyboard.press("ArrowRight");
    await expect(moveCount(page)).toHaveText("0");

    releaseProgress?.();
    await expect(firstBoard).toHaveAttribute("data-progress-ready", "true");
    await page.keyboard.press("ArrowRight");
    await expect(moveCount(page)).toHaveText("1");
  } finally {
    releaseProgress?.();
  }
});

test("restores the signed Guest's completed levels on a later visit", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const firstVisit = await context.newPage();
  try {
    await firstVisit.goto("/sokoban");
    const firstLevel = firstVisit.getByRole("button", {
      name: "第 1 关",
      exact: true,
    });

    await solveLevelOne(firstVisit);
    await expect(firstLevel.getByText("已完成", { exact: true })).toBeVisible();
    await firstVisit.close();

    const laterVisit = await context.newPage();
    await laterVisit.goto("/sokoban");
    await expect(
      laterVisit
        .getByRole("button", { name: "第 1 关", exact: true })
        .getByText("已完成", { exact: true }),
    ).toBeVisible();
    await expect(
      laterVisit.getByText("1 / 20 已完成", { exact: true }),
    ).toBeVisible();
    await expect(
      laterVisit.getByRole("button", { name: "第 1 关", exact: true })
        .getByText("最佳 33 步", { exact: true }),
    ).toBeVisible();
    await laterVisit.close();

    const verifiedVisit = await context.newPage();
    await verifiedVisit.goto("/sokoban");
    await expect(
      verifiedVisit
        .getByRole("button", { name: "第 1 关", exact: true })
        .getByText("已完成", { exact: true }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

test("retries a temporarily failed completion from the local pending queue", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  let failedOnce = false;
  await page.route("**/api/sokoban/progress/record", async (route) => {
    if (!failedOnce) {
      failedOnce = true;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "temporary_failure" }),
      });
      return;
    }
    await route.continue();
  });

  try {
    await page.goto("/sokoban");
    const firstFailed = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/sokoban/progress/record") &&
        response.status() === 503,
    );
    await solveLevelOne(page);
    await firstFailed;
    await expect(page.getByText(/暂未同步/u)).toBeVisible();

    await page.unroute("**/api/sokoban/progress/record");
    const retried = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/sokoban/progress/record") &&
        response.ok(),
    );
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    expect((await retried).ok()).toBe(true);
    await expect(
      page
        .getByRole("button", { name: "第 1 关", exact: true })
        .getByText("已完成", { exact: true }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

test("reloads existing progress when the connection recovers", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const firstVisit = await context.newPage();
  try {
    await firstVisit.goto("/sokoban");
    const recorded = firstVisit.waitForResponse(
      (response) =>
        response.url().endsWith("/api/sokoban/progress/record") &&
        response.ok(),
    );
    await solveLevelOne(firstVisit);
    await recorded;
    await firstVisit.close();

    const laterVisit = await context.newPage();
    let failedOnce = false;
    await laterVisit.route("**/api/sokoban/progress", async (route) => {
      if (!failedOnce) {
        failedOnce = true;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "temporary_failure" }),
        });
        return;
      }
      await route.continue();
    });
    await laterVisit.goto("/sokoban");
    await expect(laterVisit.getByText(/暂未同步/u)).toBeVisible();

    await laterVisit.unroute("**/api/sokoban/progress");
    const restored = laterVisit.waitForResponse(
      (response) =>
        response.url().endsWith("/api/sokoban/progress") && response.ok(),
    );
    await laterVisit.evaluate(() => window.dispatchEvent(new Event("online")));
    await restored;
    await expect(
      laterVisit
        .getByRole("button", { name: "第 1 关", exact: true })
        .getByText("已完成", { exact: true }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

test("automatically retries a failed reload after the Guest session changes", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  let rejectedRecord = false;
  let rejectedReload = false;

  await page.route("**/api/sokoban/progress/record", async (route) => {
    if (!rejectedRecord) {
      rejectedRecord = true;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: "sokoban.progress.session_changed" }),
      });
      return;
    }
    await route.continue();
  });
  await page.route("**/api/sokoban/progress", async (route) => {
    if (rejectedRecord && !rejectedReload) {
      rejectedReload = true;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "temporary_failure" }),
      });
      return;
    }
    await route.continue();
  });

  try {
    await page.goto("/sokoban");
    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/sokoban/progress/record") &&
        response.ok(),
      // The first progress request can wait behind a cold Durable Object on
      // the shared CI runner. Keep this in line with the CI expect window so
      // a slow but healthy response does not consume a retry.
      { timeout: 30_000 },
    );
    await solveLevelOne(page);
    await expect(page.getByText(/暂时无法确认游客记录/u)).toBeVisible();
    expect((await saved).ok()).toBe(true);
    expect(rejectedReload).toBe(true);
  } finally {
    await context.close();
  }
});
