import { createExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BODY_MAX_WEBHOOK, resetIpLimitLog } from "../../../packages/http/src/index.ts";
import { VERSION_HEADER } from "../../../packages/version/src/index.ts";
import record from "../../../docs/license-record.md?raw";
import { perAddressCap, routeTable } from "../../../tools/route-table.mjs";
import worker, { type Env } from "../src/index.ts";
import { env as base, freshDatabase } from "./github.ts";
import { polarDelivery, polarSub } from "./polar.ts";

const rows = routeTable(record).filter((r) => r.worker === "sync");
let calls: string[];
let sql: string[];
let buckets: Record<string, number>;
let logs: string[];

/** D1, recording every statement prepared. */
const recordingDb = (inner: D1Database): D1Database =>
  new Proxy(inner, {
    get(target, prop) {
      if (prop === "prepare") return (s: string) => (sql.push(s), target.prepare(s));
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
/** The pool's real binding would count every test on one bucket; this one allows `limit` a key. */
const limiter = (limit: number) => ({ limit: async ({ key }: { key: string }) => ({ success: (buckets[key] = (buckets[key] ?? 0) + 1) <= limit }) });
const env = (limit: number, over: Partial<Env> = {}): Env => ({ ...base, DB: recordingDb(base.DB), IP_LIMIT: limiter(limit), ...over });

function request(method: string, path: string, ip = "192.0.2.1"): Request {
  const headers: Record<string, string> = { "CF-Connecting-IP": ip, "Content-Type": "application/json", Authorization: "Bearer acme-admin-token" };
  return new Request(`https://license.claudinite.com${path}`, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : "{}" });
}
const send = (req: Request, e: Env) => worker.fetch(req, e, createExecutionContext());
const incidents = async () => (await base.DB.prepare("SELECT COUNT(*) AS n FROM incidents").first<{ n: number }>())!.n;

beforeEach(async () => {
  await freshDatabase();
  calls = [];
  sql = [];
  buckets = {};
  logs = [];
  resetIpLimitLog();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Request(input, init).url);
    return new Response("no outbound call expected", { status: 599 });
  });
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
});
afterEach(() => vi.restoreAllMocks());

describe("the sync Worker's per-address cap", () => {
  it("reads its routes from the security review's table", () => {
    expect(rows.filter(perAddressCap).length).toBe(5);
  });

  for (const r of rows.filter(perAddressCap)) {
    it(`caps ${r.method} ${r.path} before anything costs`, async () => {
      const res = await send(request(r.method, r.path), env(0));
      expect([res.status, await res.json()]).toEqual([429, { refused: "rate-limited" }]);
      expect(res.headers.get(VERSION_HEADER)).toBeTruthy();
      expect({ calls, sql }).toEqual({ calls: [], sql: [] });
    });
  }

  for (const r of rows.filter((x) => !perAddressCap(x))) {
    it(`leaves ${r.method} ${r.path} uncapped`, async () => {
      const res = await send(request(r.method, r.path), env(0));
      expect(res.status).not.toBe(429);
      expect(buckets).toEqual({});
    });
  }

  it("refuses a badly signed delivery past the cap with no incident written, and never caps a signed one", async () => {
    const e = env(1);
    const badlySigned = async () => {
      const req = await polarDelivery("subscription.created", polarSub(), { secret: `whsec_${btoa("another secret, of 32 bytes!!!!!")}` });
      req.headers.set("CF-Connecting-IP", "192.0.2.1");
      return req;
    };
    expect((await send(await badlySigned(), e)).status).toBe(401);
    expect(await incidents()).toBe(1);
    const past = await send(await badlySigned(), e);
    expect([past.status, await past.json()]).toEqual([429, { refused: "rate-limited" }]);
    expect(await incidents()).toBe(1);
    const signed = await polarDelivery("subscription.created", polarSub());
    signed.headers.set("CF-Connecting-IP", "192.0.2.1");
    expect((await send(signed, e)).status).toBe(200);
    expect(buckets).toEqual({ "ip:192.0.2.1": 2 });
  });

  it("refuses an unsigned delivery while the secret is unset past the cap too", async () => {
    const res = await send(request("POST", "/v1/sync/polar-webhook"), env(0, { POLAR_WEBHOOK_SECRET: undefined }));
    expect(res.status).toBe(429);
    expect(await incidents()).toBe(0);
  });

  // Three hundred answers through the Worker, each with its own D1 read on some routes: far past the default 5 s on a loaded runner.
  it("answers the 300th health read from one address and refuses the 301st, while another address still answers", async () => {
    const e = env(300);
    for (let i = 1; i <= 300; i++) expect((await send(request("GET", "/v1/sync/health"), e)).status, String(i)).toBe(200);
    expect((await send(request("GET", "/v1/sync/health"), e)).status).toBe(429);
    expect((await send(request("GET", "/v1/sync/health", "192.0.2.2"), e)).status).toBe(200);
  }, 30_000);

  it("lets requests through when the limiter throws, logging ip-limit-unavailable once", async () => {
    const e = env(0, { IP_LIMIT: { limit: async () => Promise.reject(new Error("acme limiter outage")) } });
    for (let i = 0; i < 3; i++) expect((await send(request("GET", "/v1/sync/health"), e)).status).toBe(200);
    expect(logs.filter((l) => l.includes("ip-limit-unavailable"))).toHaveLength(1);
  });

  // The deploy's judge asserts `counted`: the binding is in the live version and the health route calls it.
  it("reports on its health whether the cap counted that very read, threw, or is unbound", async () => {
    const read = async (e: Env) => ((await (await send(request("GET", "/v1/sync/health"), e)).json()) as { ip_limit: string }).ip_limit;
    expect(await read(env(300))).toBe("counted");
    expect(buckets).toEqual({ "ip:192.0.2.1": 1 });
    expect(await read(env(300, { IP_LIMIT: { limit: async () => Promise.reject(new Error("acme limiter outage")) } }))).toBe("unavailable");
    expect(await read(env(300, { IP_LIMIT: undefined }))).toBe("unbound");
  });
});

describe("the sync Worker's webhook body caps", () => {
  it("refuses a Polar delivery and a GitHub App delivery over 1 MiB with 413 and no write", async () => {
    const big = "x".repeat(BODY_MAX_WEBHOOK + 1);
    for (const path of ["/v1/sync/polar-webhook", "/github-webhook"]) {
      const res = await send(new Request(`https://license.claudinite.com${path}`, { method: "POST", headers: { "CF-Connecting-IP": "192.0.2.1" }, body: big }), env(300));
      expect(res.status, path).toBe(413);
    }
    expect({ sql, incidents: await incidents() }).toEqual({ sql: [], incidents: 0 });
  });
});

describe("the sync Worker's answer to HEAD", () => {
  for (const path of ["/v1/sync/health", "/v1/sync/alerts"]) {
    it(`answers HEAD on ${path} with GET's status and no body`, async () => {
      const get = await send(request("GET", path), env(300));
      const head = await send(request("HEAD", path), env(300));
      expect([head.status, await head.text()]).toEqual([get.status, ""]);
      expect(head.status).toBe(200);
      expect(head.headers.get(VERSION_HEADER)).toBeTruthy();
    });
  }

  it("leaves HEAD on a route that is not a health check unanswered", async () => {
    const res = await send(request("HEAD", "/v1/sync/polar-webhook"), env(300));
    expect(res.status).toBe(404);
  });
});
