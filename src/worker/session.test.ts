import { describe, expect, it } from "vitest";
import {
  createSignedGuestSessionValue,
  createSignedSessionValue,
  ensureGuestSession,
  readGuestSession,
  verifySignedGuestSessionValue,
  verifySignedSessionValue,
} from "./session";

describe("anonymous session", () => {
  it("reuses an authentic Guest ID and rejects a tampered value", async () => {
    const value = await createSignedSessionValue(
      "guest-123",
      "test-secret-with-enough-entropy",
    );

    await expect(
      verifySignedSessionValue(value, "test-secret-with-enough-entropy"),
    ).resolves.toBe("guest-123");
    await expect(
      verifySignedSessionValue(
        value.replace("guest-123", "guest-124"),
        "test-secret-with-enough-entropy",
      ),
    ).resolves.toBeNull();
  });

  it("binds the Display Name to the authenticated Guest session", async () => {
    const secret = "test-secret-with-enough-entropy";
    const value = await createSignedGuestSessionValue(
      { guestId: "guest-123", displayName: "棋友甲" },
      secret,
    );

    await expect(
      verifySignedGuestSessionValue(value, secret),
    ).resolves.toEqual({ guestId: "guest-123", displayName: "棋友甲" });
    const last = value.at(-1);
    const tampered = `${value.slice(0, -1)}${last === "A" ? "B" : "A"}`;
    await expect(
      verifySignedGuestSessionValue(tampered, secret),
    ).resolves.toBeNull();
  });

  it("upgrades a legacy cookie while preserving its Guest identity", async () => {
    const secret = "test-secret-with-enough-entropy";
    const legacy = await createSignedSessionValue("guest-123", secret);
    const upgraded = await ensureGuestSession(
      new Request("https://play.example/api/session", {
        headers: { Cookie: `ym_session=${legacy}` },
      }),
      secret,
      "新昵称",
    );
    const cookie = upgraded.setCookie.split(";", 1)[0]!;

    expect(upgraded).toMatchObject({
      guestId: "guest-123",
      displayName: "新昵称",
    });
    await expect(
      readGuestSession(
        new Request("https://play.example/api", {
          headers: { Cookie: cookie },
        }),
        secret,
      ),
    ).resolves.toEqual({ guestId: "guest-123", displayName: "新昵称" });
  });
});
