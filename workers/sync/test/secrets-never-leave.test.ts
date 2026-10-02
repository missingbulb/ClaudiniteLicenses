import { createExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import record from "../../../docs/license-record.md?raw";
import { routeTable } from "../../../tools/route-table.mjs";
import worker, { type Env } from "../src/index.ts";
import { env as base, freshDatabase } from "./github.ts";
import { polarDelivery, polarSub } from "./polar.ts";

// Every route the security review lists for this Worker, driven well-formed and malformed against a
// healthy and a failing GitHub and Polar, with every secret set to a value of its own: none may
// appear in an answer or a log line.
const rows = routeTable(record).filter((r) => r.worker === "sync");
const WEBHOOK_KEY = btoa("SENTINEL-POLAR-WEBHOOK-SECRET-32");
const SECRETS = {
  GITHUB_APP_ID: "SENTINEL-GITHUB-APP-ID",
  SYNC_ADMIN_TOKEN: "SENTINEL-SYNC-ADMIN-TOKEN",
  POLAR_ACCESS_TOKEN: "SENTINEL-POLAR-ACCESS-TOKEN",
  POLAR_WEBHOOK_SECRET: `whsec_${WEBHOOK_KEY}`,
  // It must parse, so the pool's own PEM stands in.
  GITHUB_APP_PRIVATE_KEY: base.GITHUB_APP_PRIVATE_KEY,
};
const needles = [
  ...Object.entries(SECRETS).flatMap(([name, value]) => [value, ...value.split("\n").filter((l) => l.length >= 24 && !/^-----/.test(l))].map((n) => ({ name, n: n.trim() }))),
  { name: "POLAR_WEBHOOK_SECRET", n: WEBHOOK_KEY },
];

let logs: string[];
let failing: boolean;
const e = (): Env => ({ ...base, ...SECRETS, IP_LIMIT: { limit: async () => ({ success: true }) } });
const send = (req: Request) => worker.fetch(req, e(), createExecutionContext());
const req = (method: string, path: string, init: { body?: string; headers?: Record<string, string> } = {}) =>
  new Request(`https://license.claudinite.com${path}`, { method, headers: { "Content-Type": "application/json", ...init.headers }, body: init.body });
const admin = { Authorization: `Bearer ${SECRETS.SYNC_ADMIN_TOKEN}` };
const repo = { id: 1001, name: "acme-repo", full_name: "acme-user/acme-repo", private: false, visibility: "public" };

const SCENARIOS: Record<string, (() => Promise<Response>)[]> = {
  "GET /v1/sync/health": [() => send(req("GET", "/v1/sync/health"))],
  "GET /v1/sync/alerts": [() => send(req("GET", "/v1/sync/alerts"))],
  "POST /v1/sync/polar-webhook": [async () => send(await polarDelivery("subscription.created", polarSub(), { secret: SECRETS.POLAR_WEBHOOK_SECRET })), () => send(req("POST", "/v1/sync/polar-webhook", { body: "{}" }))],
  "POST /v1/sync/polar-reconcile": [() => send(req("POST", "/v1/sync/polar-reconcile", { headers: admin })), () => send(req("POST", "/v1/sync/polar-reconcile", { headers: { Authorization: "Bearer wrong" } }))],
  "POST /v1/sync/reconcile": [() => send(req("POST", "/v1/sync/reconcile", { headers: admin })), () => send(req("POST", "/v1/sync/reconcile"))],
  "POST /webhook": [
    () =>
      send(
        req("POST", "/webhook", {
          headers: { "X-GitHub-Event": "installation_repositories", "X-GitHub-Delivery": "acme-delivery" },
          body: JSON.stringify({ action: "added", installation: { id: 5005, account: { id: 2002, login: "acme-user", type: "User" } }, repositories_added: [repo], repositories_removed: [] }),
        }),
      ),
    () => send(req("POST", "/webhook", { headers: { "X-GitHub-Event": "repository" }, body: "not json" })),
  ],
};

beforeEach(async () => {
  await freshDatabase();
  logs = [];
  failing = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    if (failing) return Response.json({ message: "acme upstream failure" }, { status: 500 });
    if (url.pathname.endsWith("/access_tokens")) return Response.json({ token: "ghs_acme" }, { status: 201 });
    if (url.pathname === "/app/installations") return Response.json([]);
    if (url.pathname === "/installation/repositories") return Response.json({ total_count: 0, repositories: [] });
    if (url.pathname === "/repos/acme-user/acme-repo") return Response.json({ ...repo, default_branch: "main", owner: { id: 2002, login: "acme-user", type: "User" } });
    if (url.pathname === "/v1/subscriptions/") return Response.json({ items: [], pagination: { total_count: 0, max_page: 1 } });
    return new Response("unexpected", { status: 599 });
  });
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
});
afterEach(() => vi.restoreAllMocks());

describe("secrets never leave the sync Worker", () => {
  it("has a scenario for every route the security review lists, and no other", () => {
    expect(Object.keys(SCENARIOS).sort()).toEqual(rows.map((r) => `${r.method} ${r.path}`).sort());
  });

  for (const r of rows) {
    const route = `${r.method} ${r.path}`;
    for (const upstream of ["healthy", "failing"]) {
      it(`keeps every secret out of ${route}'s answers and log lines, upstream ${upstream}`, async () => {
        failing = upstream === "failing";
        const seen: string[] = [];
        for (const s of SCENARIOS[route] ?? []) {
          const res = await s();
          seen.push(await res.text(), JSON.stringify([...res.headers]));
        }
        seen.push(...logs);
        expect(seen.length).toBeGreaterThan(0);
        for (const { name, n } of needles) for (const text of seen) expect(text.includes(n), `${name} in ${text.slice(0, 200)}`).toBe(false);
      });
    }
  }
});
