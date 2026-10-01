import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker, { type Env } from "../src/index.ts";

const SECRET = "acme-webhook-secret";
const URL_ = "https://license.claudinite.com/github-webhook";

async function sign(body: string, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return "sha256=" + Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

interface Call {
  url: string;
  method: string;
  body: string;
  event: string | null;
  delivery: string | null;
}

function stub(status: number, text = "") {
  const calls: Call[] = [];
  const fetcher = {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const req = new Request(input, init);
      calls.push({ url: req.url, method: req.method, body: await req.text(), event: req.headers.get("X-GitHub-Event"), delivery: req.headers.get("X-GitHub-Delivery") });
      return new Response(text, { status });
    },
  } as unknown as Fetcher;
  return { calls, fetcher };
}

async function deliver(env: Partial<Env>, event: string, payload: unknown, opts: { signature?: string | null; method?: string; url?: string } = {}) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const headers: Record<string, string> = { "X-GitHub-Event": event, "X-GitHub-Delivery": "acme-delivery-1", "Content-Type": "application/json" };
  const sig = opts.signature === undefined ? await sign(body) : opts.signature;
  if (sig !== null) headers["X-Hub-Signature-256"] = sig;
  const method = opts.method ?? "POST";
  const req = new Request(opts.url ?? URL_, { method, headers, body: method === "GET" ? undefined : body });
  return worker.fetch(req, { GITHUB_APP_WEBHOOK_SECRET: SECRET, ...env } as Env, createExecutionContext());
}

describe("router", () => {
  it("forwards claudinite-key-public to PUBLIC_KEY with the body and headers, returning its answer", async () => {
    const pk = stub(201, "issued");
    const payload = { action: "claudinite-key-public", client_payload: { nonce: "x" } };
    const res = await deliver({ PUBLIC_KEY: pk.fetcher }, "repository_dispatch", payload);
    expect(res.status).toBe(201);
    expect(await res.text()).toBe("issued");
    expect(pk.calls).toEqual([
      { url: "https://public-key/webhook", method: "POST", body: JSON.stringify(payload), event: "repository_dispatch", delivery: "acme-delivery-1" },
    ]);
  });

  it("refuses a wrong signature and a missing one with 401, calling nothing", async () => {
    const pk = stub(201);
    const payload = { action: "claudinite-key-public" };
    expect((await deliver({ PUBLIC_KEY: pk.fetcher }, "repository_dispatch", payload, { signature: await sign("other", SECRET) })).status).toBe(401);
    expect((await deliver({ PUBLIC_KEY: pk.fetcher }, "repository_dispatch", payload, { signature: "sha256=zz" })).status).toBe(401);
    expect((await deliver({ PUBLIC_KEY: pk.fetcher }, "repository_dispatch", payload, { signature: null })).status).toBe(401);
    expect(pk.calls).toHaveLength(0);
  });

  it("answers 202 unrouted for claudinite-key while KEY is unbound", async () => {
    const res = await deliver({}, "repository_dispatch", { action: "claudinite-key" });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("unrouted: repository_dispatch/claudinite-key");
  });

  it("answers 204 for another dispatch type", async () => {
    const pk = stub(201);
    expect((await deliver({ PUBLIC_KEY: pk.fetcher }, "repository_dispatch", { action: "deploy" })).status).toBe(204);
    expect(pk.calls).toHaveLength(0);
  });

  it("sends installation events to SYNC when bound, 202 when not", async () => {
    const sync = stub(200);
    for (const event of ["installation", "installation_repositories", "repository"]) {
      expect((await deliver({ SYNC: sync.fetcher }, event, { action: "added" })).status).toBe(200);
    }
    expect(sync.calls.map((c) => c.event)).toEqual(["installation", "installation_repositories", "repository"]);
    const res = await deliver({}, "installation_repositories", { action: "added" });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("unrouted: installation_repositories");
  });

  it("answers ping with 200 and any other event with 204, calling nothing", async () => {
    const pk = stub(201);
    const sync = stub(200);
    expect((await deliver({ PUBLIC_KEY: pk.fetcher, SYNC: sync.fetcher }, "ping", { zen: "hi" })).status).toBe(200);
    expect((await deliver({ PUBLIC_KEY: pk.fetcher, SYNC: sync.fetcher }, "issues", { action: "opened" })).status).toBe(204);
    expect(pk.calls.length + sync.calls.length).toBe(0);
  });

  it("refuses a body over 1 MiB with 413 before computing any signature", async () => {
    const big = "x".repeat(2 * 1024 * 1024);
    const req = new Request(URL_, { method: "POST", headers: { "X-GitHub-Event": "ping", "X-Hub-Signature-256": "sha256=00" }, body: big });
    // No secret in env: reaching the signature check would throw, so a 413 proves it came first.
    const res = await worker.fetch(req, {} as Env, createExecutionContext());
    expect(res.status).toBe(413);
  });

  it("answers 404 off its one path and method", async () => {
    expect((await deliver({}, "ping", {}, { method: "GET" })).status).toBe(404);
    expect((await deliver({}, "ping", {}, { url: "https://license.claudinite.com/anything" })).status).toBe(404);
  });
});
