import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import wranglerConfig from "../wrangler.jsonc?raw";
import { base, call, env, freshDatabase, NONCE, resetWorld } from "./helpers.ts";

const ID = (base as unknown as { CF_VERSION_METADATA: { id: string } }).CF_VERSION_METADATA.id;

beforeEach(async () => {
  await freshDatabase();
  resetWorld();
});

afterEach(() => vi.restoreAllMocks());

describe("version", () => {
  it("is supplied by the binding the wrangler config declares", () => {
    expect(JSON.parse(wranglerConfig.replace(/^\s*\/\/.*$/gm, "")).version_metadata).toEqual({ binding: "CF_VERSION_METADATA" });
    expect(ID).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("is named on every route's answer, 2xx, 4xx and 5xx alike", async () => {
    const post = (body: unknown, headers: Record<string, string> = {}) => ({ method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    const answers = [
      await call("/v1/key/health"),
      await call("/v1/key/health", {}, env({ brokenDb: true })),
      await call("/v1/login/config"),
      await call("/v1/login/refresh", post({})),
      await call("/v1/session-key", post({ repo: "acme-user/acme-repo", nonce: NONCE, engine_version: "1.1.0" })),
      await call("/v1/actions-key", post({ engine_version: "1.1.0" })),
      await call("/v1/item-grant", post({ issue: 1 })),
      await call("/webhook", { method: "POST", body: "{not json" }),
      await call("/elsewhere"),
    ];
    expect(answers.map((r) => r.status)).toEqual([200, 503, 200, 400, 401, 401, 401, 400, 404]);
    expect(answers.map((r) => r.headers.get("X-Claudinite-Version"))).toEqual(answers.map(() => ID));
  });

  it("is the health body's version", async () => {
    const res = await call("/v1/key/health");
    expect(((await res.json()) as { version: string }).version).toBe(res.headers.get("X-Claudinite-Version"));
  });
});
