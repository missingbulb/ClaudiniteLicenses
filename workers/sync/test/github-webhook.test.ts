import { createExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index.ts";
import wranglerConfig from "../wrangler.jsonc?raw";
import syncSource from "../src/github-webhook.ts?raw";
import { BODY_MAX_WEBHOOK } from "../../../packages/http/src/index.ts";
import { env, fakeGitHub, freshDatabase, repo, rows, signGitHub, type FakeGitHub } from "./github.ts";

// The Claudinite App's one webhook address is the sync Worker's own: it checks GitHub's signature
// and writes repos from the installation events, with no router in front of it.
const URL_ = "https://license.claudinite.com/github-webhook";
const ACCOUNT = { id: 2002, login: "acme-user", type: "User" };
let gh: FakeGitHub;

async function deliver(event: string, payload: unknown, opts: { signature?: string | null; method?: string; url?: string; e?: Partial<Env> } = {}) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const headers: Record<string, string> = { "X-GitHub-Event": event, "X-GitHub-Delivery": "acme-delivery-1", "Content-Type": "application/json" };
  const sig = opts.signature === undefined ? await signGitHub(body) : opts.signature;
  if (sig !== null) headers["X-Hub-Signature-256"] = sig;
  const method = opts.method ?? "POST";
  const req = new Request(opts.url ?? URL_, { method, headers, body: method === "GET" ? undefined : body });
  return worker.fetch(req, { ...env, ...opts.e } as Env, createExecutionContext());
}

const created = () => ({ action: "created", installation: { id: 5005, account: ACCOUNT }, repositories: [{ id: 1, name: "acme-repo-1", full_name: "acme-user/acme-repo-1", private: false }] });

beforeEach(async () => {
  await freshDatabase();
  gh = fakeGitHub();
  gh.installations = [{ id: 5005, account: ACCOUNT, repos: [repo(1)] }];
});

afterEach(() => vi.restoreAllMocks());

describe("POST /github-webhook", () => {
  it("writes an installation the App's signed delivery names", async () => {
    const res = await deliver("installation", created());
    expect(res.status).toBe(200);
    expect((await rows()).map((r) => r.repo_id)).toEqual([1]);
  });

  it("refuses a wrong signature and a missing one with 401, writing nothing and calling GitHub never", async () => {
    expect((await deliver("installation", created(), { signature: await signGitHub("other") })).status).toBe(401);
    expect((await deliver("installation", created(), { signature: "sha256=zz" })).status).toBe(401);
    expect((await deliver("installation", created(), { signature: null })).status).toBe(401);
    expect((await deliver("installation", created(), { signature: await signGitHub(JSON.stringify(created()), "another-secret") })).status).toBe(401);
    expect(await rows()).toEqual([]);
    expect(gh.calls).toEqual([]);
  });

  it("answers ping with 200, and a key dispatch or any other event with 204, writing nothing", async () => {
    expect((await deliver("ping", { zen: "hi" })).status).toBe(200);
    for (const [event, payload] of [["repository_dispatch", { action: "claudinite-key" }], ["repository_dispatch", { action: "claudinite-key-public" }], ["issues", { action: "opened" }]] as const) {
      expect((await deliver(event, payload)).status, `${event} ${JSON.stringify(payload)}`).toBe(204);
    }
    expect(await rows()).toEqual([]);
    expect(gh.calls).toEqual([]);
  });

  it("refuses a body over 1 MiB with 413 before computing any signature", async () => {
    const req = new Request(URL_, { method: "POST", headers: { "X-GitHub-Event": "ping", "X-Hub-Signature-256": "sha256=00" }, body: "x".repeat(BODY_MAX_WEBHOOK + 1) });
    // No secret in env: reaching the signature check would refuse 401, so a 413 proves the cap came first.
    const res = await worker.fetch(req, { ...env, GITHUB_APP_WEBHOOK_SECRET: undefined } as unknown as Env, createExecutionContext());
    expect(res.status).toBe(413);
    expect(syncSource).toContain("readCapped(req, BODY_MAX_WEBHOOK)");
  });

  it("refuses every delivery 401 while the secret is unset, rather than accepting an unsigned one", async () => {
    const res = await deliver("installation", created(), { e: { GITHUB_APP_WEBHOOK_SECRET: undefined } });
    expect([res.status, await res.text()]).toEqual([401, "secret-unset"]);
    expect(await rows()).toEqual([]);
  });

  it("answers a signed delivery that is not JSON with 400, writing nothing", async () => {
    expect((await deliver("installation", "{not json")).status).toBe(400);
    expect(await rows()).toEqual([]);
  });

  it("answers only POST /github-webhook: the old service-binding path and GET answer 404", async () => {
    expect((await deliver("installation", created(), { method: "GET" })).status).toBe(404);
    expect((await deliver("installation", created(), { url: "https://sync/webhook" })).status).toBe(404);
    expect(await rows()).toEqual([]);
  });

  it("is routed from license.claudinite.com/github-webhook, the address the App delivers to", () => {
    const config = JSON.parse(wranglerConfig.replace(/^\s*\/\/.*$/gm, "")) as { routes: { pattern: string }[] };
    expect(config.routes.map((r) => r.pattern)).toContain("license.claudinite.com/github-webhook");
  });
});
