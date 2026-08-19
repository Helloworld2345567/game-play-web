import { exports as workerExports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { reset } from "cloudflare:test";

interface TestExports {
  default: Fetcher;
}

const app = workerExports as unknown as TestExports;

function apiRequest(
  origin: string,
  path: string,
  init: RequestInit = {},
): Request {
  const headers = new Headers(init.headers);
  headers.set("Origin", origin);
  return new Request(`${origin}${path}`, { ...init, headers });
}

afterEach(async () => {
  await reset();
});

describe("Worker request boundary", () => {
  it("rejects an arbitrary deployment origin even when it is same-origin", async () => {
    const response = await app.default.fetch(
      apiRequest("https://untrusted.example", "/api/session", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "request.bad_origin" });
  });

  it.each(["https://play.ym0v0.com", "http://localhost:5173"])(
    "allows the configured production or local origin %s",
    async (origin) => {
      const response = await app.default.fetch(
        apiRequest(origin, "/api/session", { method: "POST" }),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Set-Cookie")).toContain("ym_session=");
    },
  );

  it("coarsely limits room creation by Cloudflare client IP across identities", async () => {
    const origin = "http://localhost:5173";
    const statuses: number[] = [];

    for (let index = 0; index < 6; index += 1) {
      const session = await app.default.fetch(
        apiRequest(origin, "/api/session", { method: "POST" }),
      );
      const cookie = session.headers.get("Set-Cookie")?.split(";", 1)[0];
      expect(cookie).toBeTruthy();

      const response = await app.default.fetch(
        apiRequest(origin, "/api/rooms", {
          method: "POST",
          headers: {
            "CF-Connecting-IP": "203.0.113.42",
            Cookie: cookie!,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            gameType: "gomoku",
            ruleSetId: "gomoku.freestyle15.v1",
          }),
        }),
      );
      statuses.push(response.status);
    }

    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
  });
});
