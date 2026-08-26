import { describe, expect, it } from "vitest";
import {
  createSignedGuestSessionValue,
  createSignedSessionValue,
  createSokobanProgressSyncId,
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

  it("renews a secure Guest identity for the browser's maximum long-lived window", async () => {
    const session = await ensureGuestSession(
      new Request("https://play.example/api/session"),
      "test-secret-with-enough-entropy",
      "棋友甲",
      "guest-123",
    );

    expect(session.setCookie).toContain("Max-Age=34560000");
    expect(session.setCookie).toContain("Path=/");
    expect(session.setCookie).toContain("Secure");
    expect(session.setCookie).toContain("HttpOnly");
    expect(session.setCookie).toContain("SameSite=Lax");
    expect(session.setCookie).not.toContain("Domain=");
  });

  it("derives a stable purpose-bound pseudonym without exposing the Guest ID", async () => {
    const secret = "test-secret-with-enough-entropy";
    const first = await createSokobanProgressSyncId("guest-123", secret);
    const repeat = await createSokobanProgressSyncId("guest-123", secret);
    const other = await createSokobanProgressSyncId("guest-124", secret);

    expect(first).toBe(repeat);
    expect(first).not.toBe(other);
    expect(first).toMatch(/^v1\.[A-Za-z0-9_-]{43}$/u);
    expect(first).not.toContain("guest-123");
  });
});
