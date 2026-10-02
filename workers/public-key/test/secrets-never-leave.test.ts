import { createExecutionContext, env as testEnv } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import record from "../../../docs/license-record.md?raw";
import { routeTable } from "../../../tools/route-table.mjs";
import worker, { type Env } from "../src/index.ts";

// Every route the security review lists for this Worker, driven well-formed and malformed against
// a healthy and a failing GitHub, with every secret set to a value of its own: none may appear in
// an answer or a log line. ISSUING_KEY_CERT is public, and every key carries it.
const rows = routeTable(record).filter((r) => r.worker === "public-key");
const base = testEnv as unknown as Env;
const NONCE = "acme-nonce-0123456789abcdef";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const SECRETS = { GITHUB_APP_ID: "SENTINEL-GITHUB-APP-ID", GITHUB_APP_PRIVATE_KEY: base.GITHUB_APP_PRIVATE_KEY, ISSUING_KEY_PRIVATE: base.ISSUING_KEY_PRIVATE };
const needles = Object.entries(SECRETS).flatMap(([name, value]) => [value, ...value.split("\n").filter((l) => l.length >= 24 && !/^-----/.test(l))].map((n) => ({ name, n: n.trim() })));

let logs: string[];
let failing: boolean;
const e = (): Env => ({ ...base, ...SECRETS, KEY_COUNTS: { writeDataPoint: () => {} } as unknown as AnalyticsEngineDataset, IP_LIMIT: { limit: async () => ({ success: true }) } });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => () =>
  worker.fetch(new Request(`https://license.claudinite.com${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }), e(), createExecutionContext());

const SCENARIOS: Record<string, (() => Promise<Response>)[]> = {
  "POST /v1/public/session-key": [post("/v1/public/session-key", { repo: "acme-user/acme-repo", nonce: NONCE, engine_version: "1.1.0" }, { Authorization: "Bearer ghu_acme" }), post("/v1/public/session-key", "not json", { Authorization: "Bearer ghu_acme" })],
  "GET /v1/public/health": [() => worker.fetch(new Request("https://license.claudinite.com/v1/public/health"), e(), createExecutionContext())],
  "POST /webhook": [
    post(
      "/webhook",
      {
        action: "claudinite-key-public",
        repository: { id: 1001, name: "acme-repo", full_name: "acme-user/acme-repo", private: false, owner: { id: 2002, login: "acme-user", type: "User" } },
        installation: { id: 5005 },
        sender: { id: 3003, login: "acme-dev", type: "User" },
        client_payload: { nonce: NONCE, engine_version: "1.1.0", head: HEAD },
      },
      { "X-GitHub-Event": "repository_dispatch", "X-GitHub-Delivery": "acme-delivery" },
    ),
    post("/webhook", "not json"),
  ],
};

beforeEach(() => {
  logs = [];
  failing = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    if (failing) return Response.json({ message: "acme upstream failure" }, { status: 500 });
    if (url.pathname.endsWith("/access_tokens")) return Response.json({ token: "ghs_acme" }, { status: 201 });
    if (url.pathname.endsWith("/check-runs")) return Response.json({ id: 77 }, { status: 201 });
    if (url.pathname === "/user") return Response.json({ id: 3003, login: "acme-dev", type: "User" });
    if (url.pathname === "/repos/acme-user/acme-repo") return Response.json({ id: 1001, name: "acme-repo", full_name: "acme-user/acme-repo", private: false, owner: { id: 2002, login: "acme-user", type: "User" }, permissions: { push: true } });
    return new Response("unexpected", { status: 599 });
  });
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
});
afterEach(() => vi.restoreAllMocks());

describe("secrets never leave the public key Worker", () => {
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
