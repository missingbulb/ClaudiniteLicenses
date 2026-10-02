import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import record from "../../../docs/license-record.md?raw";
import { routeTable } from "../../../tools/route-table.mjs";
import { resetJwksCache } from "../src/oidc.ts";
import { actionsClaims, base, call, env, freshDatabase, HEAD, NONCE, oidcIssuer, resetWorld, seedRepo, world } from "./helpers.ts";
import type { Env } from "../src/index.ts";

// Every route the security review lists for this Worker, each driven well-formed and malformed,
// against a healthy GitHub, OIDC issuer and Polar and against ones failing every call, with every
// secret set to a value of its own: none may appear in an answer's body or headers or in a log
// line. ISSUING_KEY_CERT is left out: it is public, and every key carries it.
const rows = routeTable(record).filter((r) => r.worker === "key");

const SECRETS = {
  GITHUB_APP_ID: "SENTINEL-GITHUB-APP-ID",
  GITHUB_APP_CLIENT_SECRET: "SENTINEL-GITHUB-APP-CLIENT-SECRET",
  POLAR_ACCESS_TOKEN: "SENTINEL-POLAR-ACCESS-TOKEN",
  // These two must parse, so their real dev values stand in, each distinct from every other.
  GITHUB_APP_PRIVATE_KEY: base.GITHUB_APP_PRIVATE_KEY,
  ISSUING_KEY_PRIVATE: base.ISSUING_KEY_PRIVATE,
};

/** What would give a secret away: the whole value, and each long line of a multi-line one such as a PEM. */
const needles = Object.entries(SECRETS).flatMap(([name, value]) => [value, ...value.split("\n").filter((l) => l.length >= 24 && !/^-----/.test(l))].map((n) => ({ name, n: n.trim() })));

type Scenario = (e: Env) => Promise<Response>;
const json = (path: string, body: unknown, headers: Record<string, string> = {}) => (e: Env) =>
  call(path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }, e);

let issuer: Awaited<ReturnType<typeof oidcIssuer>>;
async function actionsKeyFor(e: Env): Promise<string> {
  const res = await call("/v1/actions-key", { method: "POST", headers: { Authorization: `Bearer ${await issuer.sign(actionsClaims())}` }, body: "{}" }, e);
  return ((await res.json()) as { key?: string }).key ?? "no-key";
}

const SCENARIOS: Record<string, Scenario[]> = {
  "POST /v1/session-key": [json("/v1/session-key", { repo: "acme-user/acme-repo", nonce: NONCE, engine_version: "1.1.0" }, { Authorization: "Bearer ghu_acme" }), json("/v1/session-key", "not json", { Authorization: "Bearer ghu_acme" })],
  "POST /v1/actions-key": [async (e) => json("/v1/actions-key", { engine_version: "1.1.0" }, { Authorization: `Bearer ${await issuer.sign(actionsClaims())}` })(e), json("/v1/actions-key", "{", { Authorization: "Bearer not.a.jwt" })],
  "POST /v1/item-grant": [async (e) => json("/v1/item-grant", { issue: 7 }, { Authorization: `Bearer ${await actionsKeyFor(e)}` })(e), json("/v1/item-grant", { issue: "x" }, { Authorization: "Bearer garbage" })],
  "GET /v1/login/config": [(e) => call("/v1/login/config", {}, e)],
  "POST /v1/login/refresh": [json("/v1/login/refresh", { refresh_token: "ghr_acme" }), json("/v1/login/refresh", "not json")],
  "GET /v1/key/health": [(e) => call("/v1/key/health", {}, e)],
  "POST /webhook": [
    json(
      "/webhook",
      {
        action: "claudinite-key",
        repository: { id: 1002, name: "acme-private", full_name: "acme-user/acme-private", private: true, owner: { id: 2002, login: "acme-user", type: "User" } },
        installation: { id: 5005 },
        sender: { id: 3003, login: "acme-dev", type: "User" },
        client_payload: { nonce: NONCE, engine_version: "1.1.0", head: HEAD },
      },
      { "X-GitHub-Event": "repository_dispatch", "X-GitHub-Delivery": "acme-delivery" },
    ),
    json("/webhook", "not json", { "X-GitHub-Event": "repository_dispatch" }),
  ],
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
          Object.assign(world, { user: fail, repo: fail, oauth: fail, polarProducts: fail, polarCheckout: fail, polarSession: fail });
        }
        const e = env({ ...SECRETS, ipLimit: Number.POSITIVE_INFINITY });
        const seen = await exposure(SCENARIOS[route] ?? [], e);
        expect(seen.length).toBeGreaterThan(0);
        for (const { name, n } of needles) for (const text of seen) expect(text.includes(n), `${name} in ${text.slice(0, 200)}`).toBe(false);
      });
    }
  }
});
