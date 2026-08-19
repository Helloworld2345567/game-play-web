import { describe, expect, it } from "vitest";
import {
  createSignedSessionValue,
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
});
