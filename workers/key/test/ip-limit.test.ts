import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetIpLimitLog } from "../../../packages/http/src/index.ts";
import { VERSION_HEADER } from "../../../packages/version/src/index.ts";
import record from "../../../docs/license-record.md?raw";
import { perAddressCap, routeTable } from "../../../tools/route-table.mjs";
import { base, call, env, freshDatabase, NONCE, resetWorld, seedRepo, world } from "./helpers.ts";

const rows = routeTable(record).filter((r) => r.worker === "key");
const version = (base as unknown as { CF_VERSION_METADATA: { id: string } }).CF_VERSION_METADATA.id;

/** A request each route would spend something on if nothing stood in front of it. */
function costly(method: string, path: string, ip = "192.0.2.1"): RequestInit {
  const headers: Record<string, string> = { "CF-Connecting-IP": ip, "Content-Type": "application/json", Authorization: "Bearer ghu_acme" };
  const bodies: Record<string, unknown> = {
    "/v1/session-key": { repo: "acme-user/acme-repo", nonce: NONCE, engine_version: "1.1.0" },
    "/v1/actions-key": { engine_version: "1.1.0" },
    "/v1/item-grant": { issue: 7 },
    "/v1/login/refresh": { refresh_token: "ghr_acme" },
  };
  return method === "GET" ? { headers } : { method, headers, body: JSON.stringify(bodies[path] ?? {}) };
}

beforeEach(async () => {
  await freshDatabase();
  await seedRepo();
  resetWorld();
  resetIpLimitLog();
});
afterEach(() => vi.restoreAllMocks());

describe("the key Worker's per-address cap", () => {
  it("reads its routes from the security review's table", () => {
    expect(rows.filter(perAddressCap).length).toBeGreaterThanOrEqual(6);
  });

  for (const r of rows.filter(perAddressCap)) {
    it(`caps ${r.method} ${r.path} before anything costs`, async () => {
      const e = env({ ipLimit: 0, GITHUB_APP_CLIENT_SECRET: "acme-client-secret" });
      const res = await call(r.path, costly(r.method, r.path), e);
      expect([res.status, await res.json()]).toEqual([429, { refused: "rate-limited" }]);
      expect(res.headers.get(VERSION_HEADER)).toBe(version);
      expect({ calls: world.calls.length, db: world.dbCalls, points: world.points.length, sent: world.sent.length, owner: world.limited }).toEqual({ calls: 0, db: 0, points: 0, sent: 0, owner: {} });
      expect(world.ipLimited).toEqual({ "ip:192.0.2.1": 1 });
    });
  }

  for (const r of rows.filter((x) => !perAddressCap(x))) {
    it(`leaves ${r.method} ${r.path} uncapped`, async () => {
      const res = await call(r.path, { method: r.method, headers: { "Content-Type": "application/json" }, body: "{}" }, env({ ipLimit: 0 }));
      expect(res.status).not.toBe(429);
      expect(world.ipLimited).toEqual({});
    });
  }

  // Three hundred answers through the Worker, each with its own D1 read on some routes: far past the default 5 s on a loaded runner.
  it("answers the 300th health read from one address in a minute and refuses the 301st, while another address still answers", async () => {
    const e = env({ ipLimit: 300 });
    for (let i = 1; i <= 300; i++) expect((await call("/v1/key/health", costly("GET", "/v1/key/health"), e)).status, String(i)).toBe(200);
    const db = world.dbCalls;
    expect((await call("/v1/key/health", costly("GET", "/v1/key/health"), e)).status).toBe(429);
    expect(world.dbCalls).toBe(db);
    expect((await call("/v1/key/health", costly("GET", "/v1/key/health", "192.0.2.2"), e)).status).toBe(200);
    expect(world.logs.filter((l) => l.includes('"ip-limited"'))).toHaveLength(1);
  }, 30_000);

  it("lets requests through when the limiter throws, logging ip-limit-unavailable once", async () => {
    const e = env({ IP_LIMIT: { limit: async () => Promise.reject(new Error("acme limiter outage")) } as unknown as RateLimit });
    for (let i = 0; i < 3; i++) expect((await call("/v1/key/health", costly("GET", "/v1/key/health"), e)).status).toBe(200);
    expect(world.logs.filter((l) => l.includes("ip-limit-unavailable"))).toHaveLength(1);
  });
});
