import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import record from "../../../docs/license-record.md?raw";
import { routeTable } from "../../../tools/route-table.mjs";
import { resetJwksCache } from "../src/oidc.ts";
import { actionsClaims, base, call, env, freshDatabase, oidcIssuer, resetWorld, seedRepo, world } from "./helpers.ts";
import type { Env } from "../src/index.ts";

// Every route the security review lists for this Worker, each driven well-formed and malformed,
// against a healthy OIDC issuer and Polar and against ones failing every call, with every
// secret set to a value of its own: none may appear in an answer's body or headers or in a log
// line. ISSUING_KEY_CERT is left out: it is public, and every key carries it.
const rows = routeTable(record).filter((r) => r.worker === "key");

const SECRETS = {
  POLAR_ACCESS_TOKEN: "SENTINEL-POLAR-ACCESS-TOKEN",
  // This one must parse, so its real dev value stands in.
  ISSUING_KEY_PRIVATE: base.ISSUING_KEY_PRIVATE,
};

/** What would give a secret away: the whole value, and each long line of a multi-line one such as a PEM. */
const needles = Object.entries(SECRETS).flatMap(([name, value]) => [value, ...value.split("\n").filter((l) => l.length >= 24 && !/^-----/.test(l))].map((n) => ({ name, n: n.trim() })));

type Scenario = (e: Env) => Promise<Response>;
const json = (path: string, body: unknown, headers: Record<string, string> = {}) => (e: Env) =>
  call(path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }, e);

let issuer: Awaited<ReturnType<typeof oidcIssuer>>;

const SCENARIOS: Record<string, Scenario[]> = {
  "POST /v1/actions-key": [async (e) => json("/v1/actions-key", { engine_version: "1.1.0" }, { Authorization: `Bearer ${await issuer.sign(actionsClaims())}` })(e), json("/v1/actions-key", "{", { Authorization: "Bearer not.a.jwt" })],
  "GET /v1/key/health": [(e) => call("/v1/key/health", {}, e)],
  "HEAD /v1/key/health": [(e) => call("/v1/key/health", { method: "HEAD" }, e)],
};

beforeEach(async () => {
  await freshDatabase();
  await seedRepo();
  await seedRepo({ repo_id: 1002, visibility: "private", full_name: "acme-user/acme-private" });
  resetWorld();
  resetJwksCache();
  issuer = await oidcIssuer();
  world.jwks = () => Response.json({ keys: [issuer.jwk] });
});
afterEach(() => vi.restoreAllMocks());

/** Every answer and log line of `scenarios`, as text. */
async function exposure(scenarios: Scenario[], e: Env): Promise<string[]> {
  const out: string[] = [];
  for (const s of scenarios) {
    const res = await s(e);
    out.push(await res.text(), JSON.stringify([...res.headers]));
  }
  return [...out, ...world.logs];
}

describe("secrets never leave the key Worker", () => {
  it("has a scenario for every route the security review lists, and no other", () => {
    expect(Object.keys(SCENARIOS).sort()).toEqual(rows.map((r) => `${r.method} ${r.path}`).sort());
    expect(new Set(needles.map((x) => x.name)).size).toBe(Object.keys(SECRETS).length);
  });

  for (const r of rows) {
    const route = `${r.method} ${r.path}`;
    for (const upstream of ["healthy", "failing"] as const) {
      it(`keeps every secret out of ${route}'s answers and log lines, upstream ${upstream}`, async () => {
        if (upstream === "failing") {
          const fail = () => Response.json({ message: "acme upstream failure" }, { status: 500 });
          Object.assign(world, { polarProducts: fail, polarCheckout: fail, polarSession: fail });
        }
        const e = env({ ...SECRETS, ipLimit: Number.POSITIVE_INFINITY });
        const seen = await exposure(SCENARIOS[route] ?? [], e);
        expect(seen.length).toBeGreaterThan(0);
        for (const { name, n } of needles) for (const text of seen) expect(text.includes(n), `${name} in ${text.slice(0, 200)}`).toBe(false);
      });
    }
  }
});
