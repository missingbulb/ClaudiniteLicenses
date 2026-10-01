import { createExecutionContext, env as testEnv } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index.ts";
import wranglerConfig from "../wrangler.jsonc?raw";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const NONCE = "acme-nonce-0123456789abcdef";
const ID = (testEnv as unknown as { CF_VERSION_METADATA: { id: string } }).CF_VERSION_METADATA.id;
const env = () => ({ ...(testEnv as unknown as Env), KEY_COUNTS: { writeDataPoint: () => {} } as unknown as AnalyticsEngineDataset });
const send = (path: string, init?: RequestInit) => worker.fetch(new Request(`https://license.claudinite.com${path}`, init), env(), createExecutionContext());
const dispatch = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    action: "claudinite-key-public",
    repository: { id: 1001, name: "acme-repo", full_name: "acme-user/acme-repo", private: false, owner: { id: 2002, login: "acme-user", type: "User" } },
    installation: { id: 5005 },
    sender: { id: 3003, login: "acme-dev", type: "User" },
    client_payload: { nonce: NONCE, engine_version: "1.1.0", head: HEAD },
    ...over,
  });

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.url.endsWith("/access_tokens")) return Response.json({ token: "ghs_acme" }, { status: 201 });
    if (req.url.endsWith("/check-runs")) return Response.json({ message: "boom" }, { status: 500 });
    if (req.url === "https://github-api.test/user") return Response.json({ id: 3003, login: "acme-dev", type: "User" });
    if (req.url === "https://github-api.test/repos/acme-user/acme-repo") return Response.json({ id: 1001, name: "acme-repo", full_name: "acme-user/acme-repo", private: true, owner: { id: 2002, login: "acme-user", type: "User" }, permissions: { push: true } });
    return new Response("unexpected", { status: 599 });
  });
});

afterEach(() => vi.restoreAllMocks());

describe("version", () => {
  it("is supplied by the binding the wrangler config declares", () => {
    expect(JSON.parse(wranglerConfig.replace(/^\s*\/\/.*$/gm, "")).version_metadata).toEqual({ binding: "CF_VERSION_METADATA" });
    expect(ID).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("is named on every route's answer, 2xx, 4xx and 5xx alike", async () => {
    const answers = [
      await send("/v1/public/health"),
      await send("/v1/public/session-key", { method: "POST", headers: { Authorization: "Bearer ghu_acme" }, body: JSON.stringify({ repo: "acme-user/acme-repo", nonce: NONCE, engine_version: "1.1.0" }) }),
      await send("/v1/public/session-key", { method: "POST", body: "{}" }),
      await send("/webhook", { method: "POST", body: dispatch() }),
      await send("/webhook", { method: "POST", body: "{not json" }),
      await send("/elsewhere"),
    ];
    expect(answers.map((r) => r.status)).toEqual([200, 403, 401, 502, 400, 404]);
    expect(answers.map((r) => r.headers.get("X-Claudinite-Version"))).toEqual(answers.map(() => ID));
  });

  it("is the health body's version", async () => {
    const res = await send("/v1/public/health");
    expect(((await res.json()) as { version: string }).version).toBe(res.headers.get("X-Claudinite-Version"));
  });
});
