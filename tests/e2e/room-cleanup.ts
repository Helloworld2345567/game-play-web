import type { Dialog, Page } from "@playwright/test";

const ROOM_URL = /\/r\/[A-Za-z0-9_-]{16}\/?$/u;

/**
 * Explicitly leave a room before closing its browser context.
 *
 * Closing a context only disconnects the transport; the server then keeps a
 * vacant room during its reconnect grace period.  Use the product's Exit
 * action so the last player releases the room immediately.  The helper is
 * intentionally best-effort for pages that never reached a room (for
 * example, when creation failed before a test assertion).
 */
/** Leave a known-live room and fail if the product exit flow does not work. */
export async function leaveRoom(page: Page): Promise<void> {
  const exit = page.getByRole("button", { name: "退出房间", exact: true });
  let dialogSeen = false;
  const handleDialog = (dialog: Dialog): void => {
    dialogSeen = true;
    void (dialog.type() === "confirm"
      ? dialog.accept()
      : dialog.dismiss()
    ).catch(() => undefined);
  };
  page.once("dialog", handleDialog);
  try {
    await exit.click({ timeout: 5_000 });
  } finally {
    page.off("dialog", handleDialog);
  }
  if (!dialogSeen) throw new Error("Expected an exit confirmation");
  await page.waitForURL((url) => url.pathname === "/", { timeout: 5_000 });
}

/** Best-effort teardown wrapper for pages that may already be gone/offline. */
export async function leaveRoomIfPresent(page: Page): Promise<void> {
  try {
    if (page.isClosed() || !ROOM_URL.test(page.url())) return;

    // A test can fail while deliberately offline. Re-enable the transport for
    // teardown; this only affects the context that is about to be closed.
    await page.context().setOffline(false).catch(() => undefined);

    const exit = page.getByRole("button", { name: "退出房间", exact: true });
    if (
      (await exit.count()) === 0 ||
      !(await exit.isVisible({ timeout: 2_000 }).catch(() => false))
    ) {
      return;
    }
    await leaveRoom(page);
  } catch {
    // Cleanup must never replace the assertion that caused the test to fail.
  }
}
