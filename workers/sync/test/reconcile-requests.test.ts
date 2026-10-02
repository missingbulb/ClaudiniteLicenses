import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { DEAD_LETTER_QUEUE, WRITES_QUEUE } from "../src/writes.ts";
import { env, fakeGitHub, freshDatabase, repo, rows, type FakeGitHub } from "./github.ts";
import { fakePolar, polarSub, subscriptionRows, type FakePolar } from "./polar.ts";

// The deploy asks for each reconcile by pushing a marker onto the writes queue; the consumer runs it.
const ACCOUNT = { id: 2002, login: "acme-user", type: "User" };
let gh: FakeGitHub;
let polar: FakePolar;
let logs: string[];

const nowS = () => Math.floor(Date.now() / 1000);
const request = (marker: string, at = nowS()) => ({ v: 1, kind: "incident", at, marker, detail: "https://github.test/acme/runs/1" });
const githubListings = () => gh.calls.filter((c) => c.startsWith("GET /app/installations")).length;
const all = async (sql: string) => (await env.DB.prepare(sql).all()).results;
const stampAt = async (name: string) => (await env.DB.prepare("SELECT at FROM sync_state WHERE name = ?").bind(name).first<{ at: number }>())?.at ?? null;

async function consume(bodies: unknown[], queue = WRITES_QUEUE, e = env) {
  const batch = createMessageBatch(queue, bodies.map((body, i) => ({ id: `m${i}`, timestamp: new Date(), attempts: 1, body })));
  const ctx = createExecutionContext();
  await worker.queue(batch, e, ctx);
  return getQueueResult(batch, ctx);
}

beforeEach(async () => {
  await freshDatabase();
  gh = fakeGitHub();
  polar = fakePolar();
  gh.installations = [{ id: 5005, account: ACCOUNT, repos: [repo(1), repo(2)] }];
  polar.subscriptions = [polarSub()];
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
});

afterEach(() => vi.restoreAllMocks());

describe("a reconcile requested through the writes queue", () => {
  it("runs the GitHub reconcile on reconcile-now, stamps last_reconcile_at, records the request and acks", async () => {
    const before = nowS();
    const res = await consume([request("reconcile-now")]);
    expect(res).toMatchObject({ outcome: "ok", ackAll: true, retryBatch: { retry: false } });
    expect((await rows()).map((r) => r.repo_id)).toEqual([1, 2]);
    expect(await stampAt("last_reconcile_at")).toBeGreaterThanOrEqual(before);
    expect(await stampAt("last_polar_reconcile_at")).toBeNull();
    expect(await all("SELECT marker, detail FROM incidents")).toEqual([{ marker: "reconcile-now", detail: "https://github.test/acme/runs/1" }]);
    expect(polar.calls).toEqual([]);
  });

  it("runs the Polar reconcile on polar-reconcile-now and stamps last_polar_reconcile_at", async () => {
    const before = nowS();
    await consume([request("polar-reconcile-now")]);
    expect((await subscriptionRows()).length).toBe(1);
    expect(await stampAt("last_polar_reconcile_at")).toBeGreaterThanOrEqual(before);
    expect(await stampAt("last_reconcile_at")).toBeNull();
    expect(githubListings()).toBe(0);
  });

  it("runs each reconcile once for a batch carrying several requests of it, beside other writes", async () => {
    await consume([request("reconcile-now"), request("polar-reconcile-now"), request("reconcile-now"), { v: 1, kind: "grace-start", at: nowS(), owner_id: 2002 }, request("polar-reconcile-now")]);
    expect(githubListings()).toBe(1);
    expect(polar.calls).toHaveLength(1);
    expect(await all("SELECT COUNT(*) AS n FROM overuse")).toEqual([{ n: 1 }]);
  });

  it("runs nothing again for a redelivered request a reconcile since has already answered", async () => {
    const msg = [request("reconcile-now", nowS() - 5), request("polar-reconcile-now", nowS() - 5)];
    await consume(msg);
    expect([githubListings(), polar.calls.length]).toEqual([1, 1]);
    await consume(msg);
    expect([githubListings(), polar.calls.length]).toEqual([1, 1]);
    expect(logs.filter((l) => l.includes('"reconcile":"already-answered"'))).toHaveLength(2);
  });

  it("runs a request made after the last reconcile", async () => {
    await env.DB.prepare("INSERT INTO sync_state (name, at) VALUES ('last_reconcile_at', ?), ('last_polar_reconcile_at', ?)").bind(nowS() - 3600, nowS() - 3600).run();
    await consume([request("reconcile-now"), request("polar-reconcile-now")]);
    expect([githubListings(), polar.calls.length]).toEqual([1, 1]);
  });

  it("logs a failing reconcile, leaves its stamp alone and still acks, so the request is not repeated", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async () => Response.json({ message: "boom" }, { status: 500 }));
    const res = await consume([request("reconcile-now"), request("polar-reconcile-now")]);
    expect(res).toMatchObject({ ackAll: true, retryBatch: { retry: false } });
    expect(await stampAt("last_reconcile_at")).toBeNull();
    expect(await stampAt("last_polar_reconcile_at")).toBeNull();
    expect(logs.some((l) => l.includes('"reconcile":"failed"') && l.includes('"requested":"reconcile-now"'))).toBe(true);
    expect(logs.some((l) => l.includes('"reconcile":"polar-failed"') && l.includes('"requested":"polar-reconcile-now"'))).toBe(true);
  });

  it("runs no reconcile for a request from the dead-letter queue", async () => {
    await consume([request("reconcile-now"), request("polar-reconcile-now")], DEAD_LETTER_QUEUE);
    expect([githubListings(), polar.calls.length]).toEqual([0, 0]);
  });

  it("runs no reconcile when the batch's writes failed and it is retried", async () => {
    const broken = { ...env, DB: new Proxy(env.DB, { get: (t, p) => (p === "batch" ? async () => Promise.reject(new Error("D1_ERROR: acme outage")) : Reflect.get(t, p)) }) as D1Database };
    const res = await consume([request("reconcile-now")], WRITES_QUEUE, broken);
    expect(res).toMatchObject({ retryBatch: { retry: true } });
    expect(githubListings()).toBe(0);
  });

  it("acks and logs a marker this version does not know, which is how an older version meets a newer request", async () => {
    const res = await consume([{ v: 1, kind: "incident", at: nowS(), marker: "acme-marker-now" }]);
    expect(res).toMatchObject({ ackAll: true, retryBatch: { retry: false } });
    expect(logs.some((l) => l.includes('"marker":"write-malformed"'))).toBe(true);
    expect([githubListings(), polar.calls.length]).toEqual([0, 0]);
  });
});
