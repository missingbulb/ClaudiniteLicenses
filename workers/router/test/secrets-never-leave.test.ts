import { createExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import record from "../../../docs/license-record.md?raw";
import { routeTable } from "../../../tools/route-table.mjs";
import worker, { type Env } from "../src/index.ts";

// The router's one route, signed and unsigned, against callees that answer and fail, with its one
// secret set to a value of its own: it may appear in no answer and no log line.
const rows = routeTable(record).filter((r) => r.worker === "router");
const SECRET = "SENTINEL-GITHUB-APP-WEBHOOK-SECRET";
let logs: string[];

async function sign(body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return "sha256=" + Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))), (b) => b.toString(16).padStart(2, "0")).join("");
}

const callee = (status: number) => ({ fetch: async () => new Response(`callee ${status}`, { status }) }) as unknown as Fetcher;

beforeEach(() => {
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
});
afterEach(() => vi.restoreAllMocks());

describe("secrets never leave the router", () => {
  it("covers the one route the security review lists", () => {
    expect(rows.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /github-webhook"]);
  });

  for (const status of [201, 502]) {
    it(`keeps the webhook secret out of every answer and log line, callees answering ${status}`, async () => {
      const env: Env = { GITHUB_APP_WEBHOOK_SECRET: SECRET, KEY: callee(status), PUBLIC_KEY: callee(status), SYNC: callee(status) };
      const seen: string[] = [];
      for (const [event, payload] of [
        ["repository_dispatch", { action: "claudinite-key" }],
        ["installation", { action: "created" }],
        ["ping", {}],
      ] as const) {
        const body = JSON.stringify(payload);
        for (const signature of [await sign(body), "sha256=" + "0".repeat(64), null]) {
          const headers: Record<string, string> = { "X-GitHub-Event": event, "X-GitHub-Delivery": "acme-delivery" };
          if (signature) headers["X-Hub-Signature-256"] = signature;
          const res = await worker.fetch(new Request("https://license.claudinite.com/github-webhook", { method: "POST", headers, body }), env, createExecutionContext());
          seen.push(await res.text(), JSON.stringify([...res.headers]));
        }
      }
      for (const text of [...seen, ...logs]) expect(text.includes(SECRET), text.slice(0, 200)).toBe(false);
    });
  }
});
