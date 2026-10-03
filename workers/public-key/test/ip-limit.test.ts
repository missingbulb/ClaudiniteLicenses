import { createExecutionContext, env as testEnv } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BODY_MAX_JSON, resetIpLimitLog } from "../../../packages/http/src/index.ts";
import { VERSION_HEADER } from "../../../packages/version/src/index.ts";
import record from "../../../docs/license-record.md?raw";
import { perAddressCap, routeTable } from "../../../tools/route-table.mjs";
import worker, { type Env } from "../src/index.ts";

const rows = routeTable(record).filter((r) => r.worker === "public-key");
const NONCE = "acme-nonce-0123456789abcdef";
let calls: string[];
let points: { blobs?: string[] }[];
let buckets: Record<string, number>;
let logs: string[];

/** The pool's real binding would count every test on one bucket; this one allows `limit` a key. */
const limiter = (limit: number) => ({ limit: async ({ key }: { key: string }) => ({ success: (buckets[key] = (buckets[key] ?? 0) + 1) <= limit }) });
const env = (limit: number, over: Partial<Env> = {}): Env => ({
  ...(testEnv as unknown as Env),
  KEY_COUNTS: { writeDataPoint: (p: { blobs?: string[] }) => void points.push(p) } as unknown as AnalyticsEngineDataset,
  IP_LIMIT: limiter(limit),
  ...over,
});
const send = (method: string, path: string, e: Env, init: { ip?: string; body?: string; headers?: Record<string, string> } = {}) =>
  worker.fetch(
    new Request(`https://license.claudinite.com${path}`, {
      method,
      headers: { "CF-Connecting-IP": init.ip ?? "192.0.2.1", "Content-Type": "application/json", Authorization: "Bearer ghu_acme", ...init.headers },
      body: method === "GET" || method === "HEAD" ? undefined : (init.body ?? JSON.stringify({ repo: "acme-user/acme-repo", nonce: NONCE, engine_version: "1.1.0" })),
    }),
    e,
    createExecutionContext(),
  );

beforeEach(() => {
  calls = [];
  points = [];
  buckets = {};
  logs = [];
  resetIpLimitLog();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    calls.push(req.url);
    if (req.url === "https://github-api.test/user") return Response.json({ message: "Bad credentials" }, { status: 401 });
    return new Response("unexpected", { status: 599 });
  });
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
});
afterEach(() => vi.restoreAllMocks());

describe("the public key Worker's per-address cap", () => {
  it("reads its routes from the security review's table", () => {
    expect(rows.filter(perAddressCap).map((r) => `${r.method} ${r.path}`)).toEqual(["POST /v1/public/session-key", "GET /v1/public/health", "HEAD /v1/public/health"]);
  });

  for (const r of rows.filter(perAddressCap)) {
    it(`caps ${r.method} ${r.path} before anything costs`, async () => {
      const res = await send(r.method, r.path, env(0));
      expect([res.status, await res.json()]).toEqual([429, { refused: "rate-limited" }]);
      expect(res.headers.get(VERSION_HEADER)).toBeTruthy();
      expect({ calls, points }).toEqual({ calls: [], points: [] });
    });
  }

  for (const r of rows.filter((x) => !perAddressCap(x))) {
    it(`leaves ${r.method} ${r.path} uncapped`, async () => {
      const res = await send(r.method, r.path, env(0), { body: "{}" });
      expect(res.status).not.toBe(429);
      expect(buckets).toEqual({});
    });
  }

  // Three hundred answers through the Worker, each with its own D1 read on some routes: far past the default 5 s on a loaded runner.
  it("answers the 300th request from one address and refuses the 301st, while another address still answers", async () => {
    const e = env(300);
    for (let i = 1; i <= 300; i++) expect((await send("GET", "/v1/public/health", e)).status, String(i)).toBe(200);
    expect((await send("GET", "/v1/public/health", e)).status).toBe(429);
    expect((await send("GET", "/v1/public/health", e, { ip: "192.0.2.2" })).status).toBe(200);
  }, 30_000);

  it("lets requests through when the limiter throws, logging ip-limit-unavailable once", async () => {
    const e = env(0, { IP_LIMIT: { limit: async () => Promise.reject(new Error("acme limiter outage")) } });
    for (let i = 0; i < 3; i++) expect((await send("GET", "/v1/public/health", e)).status).toBe(200);
    expect(logs.filter((l) => l.includes("ip-limit-unavailable"))).toHaveLength(1);
  });

  // The deploy's read-back asserts `counted`: the binding is in the live version and the health route calls it.
  it("reports on its health whether the cap counted that very read, threw, or is unbound", async () => {
    const read = async (e: Env) => ((await (await send("GET", "/v1/public/health", e)).json()) as { ip_limit: string }).ip_limit;
    expect(await read(env(300))).toBe("counted");
    expect(buckets).toEqual({ "ip:192.0.2.1": 1 });
    expect(await read(env(300, { IP_LIMIT: { limit: async () => Promise.reject(new Error("acme limiter outage")) } }))).toBe("unavailable");
    expect(await read(env(300, { IP_LIMIT: undefined }))).toBe("unbound");
  });
});

describe("the public key Worker's body cap and usage points", () => {
  it("refuses a 16 KiB + 1 desktop body and a lying Content-Length with 413 before GitHub is asked", async () => {
    const big = JSON.stringify({ repo: "acme-user/acme-repo", nonce: NONCE, pad: "a".repeat(BODY_MAX_JSON) });
    for (const res of [await send("POST", "/v1/public/session-key", env(300), { body: big }), await send("POST", "/v1/public/session-key", env(300), { body: "{}", headers: { "Content-Length": String(BODY_MAX_JSON + 1) } })]) {
      expect([res.status, await res.json()]).toEqual([413, { refused: "body-too-large" }]);
    }
    expect(calls).toEqual([]);
  });

  it("writes no point for a token GitHub refuses", async () => {
    const res = await send("POST", "/v1/public/session-key", env(300));
    expect([res.status, await res.json()]).toEqual([401, { refused: "token-invalid" }]);
    expect(calls).toEqual(["https://github-api.test/user"]);
    expect(points).toEqual([]);
  });
});

describe("the public key Worker's answer to HEAD", () => {
  it("answers HEAD on its health with GET's status and no body", async () => {
    const get = await send("GET", "/v1/public/health", env(300));
    const head = await send("HEAD", "/v1/public/health", env(300));
    expect([head.status, await head.text()]).toEqual([get.status, ""]);
    expect(head.status).toBe(200);
    expect(head.headers.get(VERSION_HEADER)).toBeTruthy();
  });

  it("leaves HEAD on a route that is not a health check unanswered", async () => {
    const res = await send("HEAD", "/v1/public/session-key", env(300));
    expect(res.status).toBe(404);
  });
});
