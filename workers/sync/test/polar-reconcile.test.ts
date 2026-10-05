import { createExecutionContext, createMessageBatch, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { reconcilePolar } from "../src/polar-reconcile.ts";
import { WRITES_QUEUE } from "../src/writes.ts";
import { env, fakeGitHub, freshDatabase } from "./github.ts";
import { fakePolar, polarDelivery, polarSub, subscriptionRows, type FakePolar } from "./polar.ts";

let polar: FakePolar;
const fetchPath = (path: string, init?: RequestInit, e = env) => worker.fetch(new Request(`https://license.claudinite.com${path}`, init), e, createExecutionContext());
const health = () => fetchPath("/v1/sync/health").then((r) => r.json() as Promise<Record<string, unknown>>);
const polarCalls = () => polar.calls.length;

async function cron(cron: string, at: number) {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ scheduledTime: new Date(at * 1000), cron }), env, ctx);
  await waitOnExecutionContext(ctx);
}

beforeEach(async () => {
  await freshDatabase();
  fakeGitHub();
  polar = fakePolar();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("reconcilePolar", () => {
  it("adds a listed subscription the table lacks, repairs one whose seats differ, leaves an identical one, and counts the writes", async () => {
    polar.subscriptions = [polarSub({ id: "sub_a" }), polarSub({ id: "sub_b", seats: 9 }), polarSub({ id: "sub_c" })];
    for (const s of [polarSub({ id: "sub_b", seats: 4 }), polarSub({ id: "sub_c" })]) await worker.fetch(await polarDelivery("subscription.created", s), env, createExecutionContext());
    const out = await reconcilePolar(env, 1_790_000_000);
    expect(out).toEqual({ subscriptions: 3, corrections: 2 });
    expect((await subscriptionRows()).map((r) => [r.polar_subscription_id, r.seats])).toEqual([["sub_a", 5], ["sub_b", 9], ["sub_c", 5]]);
    expect(polar.calls[0]).toBe("GET /v1/subscriptions/?page=1&limit=100 Bearer polar_oat_acme 2026-10");
    expect(await health()).toMatchObject({ last_polar_reconcile_at: 1_790_000_000, last_polar_reconcile_corrections: 2, last_polar_reconcile_error: null });
    expect(await reconcilePolar(env, 1_790_000_100)).toEqual({ subscriptions: 3, corrections: 0 });
  });

  it("overwrites a stored row that differs even when its modified_at is later than Polar's", async () => {
    await worker.fetch(await polarDelivery("subscription.created", polarSub({ seats: 40, modified_at: "2026-12-01T00:00:00Z" })), env, createExecutionContext());
    polar.subscriptions = [polarSub()];
    expect(await reconcilePolar(env, 1_790_000_000)).toEqual({ subscriptions: 1, corrections: 1 });
    expect((await subscriptionRows())[0]!.seats).toBe(5);
  });

  it("walks every page and skips what pays for nobody", async () => {
    polar.subscriptions = [...Array.from({ length: 120 }, (_, i) => polarSub({ id: `sub_${String(i).padStart(3, "0")}`, externalId: String(5000 + i) })), polarSub({ id: "sub_orphan", externalId: null })];
    expect(await reconcilePolar(env, 1_790_000_000)).toEqual({ subscriptions: 120, corrections: 120 });
    expect(polar.calls.filter((c) => c.startsWith("GET"))).toHaveLength(2);
  });

  it("stamps the error and leaves every row when Polar answers 500, deleting nothing", async () => {
    await worker.fetch(await polarDelivery("subscription.created", polarSub()), env, createExecutionContext());
    polar.status = 500;
    await expect(reconcilePolar(env, 1_790_000_000)).rejects.toThrow(/500/);
    expect(await subscriptionRows()).toHaveLength(1);
    expect(await health()).toMatchObject({ last_polar_reconcile_at: null, last_polar_reconcile_error: "500" });
    polar.status = 200;
    polar.subscriptions = [];
    expect(await reconcilePolar(env, 1_790_000_100)).toEqual({ subscriptions: 0, corrections: 0 });
    expect(await subscriptionRows()).toHaveLength(1);
    expect(await health()).toMatchObject({ last_polar_reconcile_at: 1_790_000_100, last_polar_reconcile_error: null });
  });
});

describe("the crons", () => {
  const NIGHT = 1_790_000_000;

  it("runs both reconciles at night", async () => {
    await cron("17 3 * * *", NIGHT);
    expect(polarCalls()).toBe(1);
    expect(await health()).toMatchObject({ last_reconcile_at: NIGHT, last_polar_reconcile_at: NIGHT });
  });

  it("runs the Polar reconcile hourly only after a failure or a day without success", async () => {
    await cron("47 * * * *", NIGHT);
    expect(polarCalls()).toBe(1);
    await cron("47 * * * *", NIGHT + 3600);
    expect(polarCalls()).toBe(1);
    polar.status = 500;
    await cron("47 * * * *", NIGHT + 25 * 3600);
    expect(polarCalls()).toBe(2);
    expect((await health()).last_polar_reconcile_error).toBe("500");
    polar.status = 200;
    await cron("47 * * * *", NIGHT + 26 * 3600);
    expect(polarCalls()).toBe(3);
    expect(await health()).toMatchObject({ last_polar_reconcile_at: NIGHT + 26 * 3600, last_polar_reconcile_error: null });
    await cron("47 * * * *", NIGHT + 27 * 3600);
    expect(polarCalls()).toBe(3);
    expect(await health()).toMatchObject({ last_reconcile_at: null });
  });
});

describe("GET /v1/sync/health", () => {
  it("reads null for every stamp on a fresh database, and whether the webhook secret is set", async () => {
    expect(await health()).toEqual({
      ok: true,
      repos: 0,
      subscriptions: 0,
      last_webhook_at: null,
      last_reconcile_at: null,
      last_reconcile_corrections: null,
      last_polar_webhook_at: null,
      last_polar_reconcile_at: null,
      last_polar_reconcile_corrections: null,
      last_polar_reconcile_error: null,
      last_queue_at: null,
      last_queue_version: null,
      queue_lag_s: null,
      last_dead_letter_at: null,
      last_cron_at: null,
      last_cron: null,
      last_cron_version: null,
      paying_uncovered: null,
      polar_webhook_secret: true,
      github_webhook_secret: true,
      ip_limit: "counted",
      version: (env as unknown as { CF_VERSION_METADATA: { id: string } }).CF_VERSION_METADATA.id,
    });
    const { POLAR_WEBHOOK_SECRET: _unset, ...noSecret } = env;
    expect(await (await fetchPath("/v1/sync/health", undefined, noSecret)).json()).toMatchObject({ polar_webhook_secret: false });
    const { GITHUB_APP_WEBHOOK_SECRET: _gone, ...noGitHubSecret } = env;
    expect(await (await fetchPath("/v1/sync/health", undefined, noGitHubSecret)).json()).toMatchObject({ github_webhook_secret: false });
  });

  it("reads back every stamp after a webhook, a reconcile and a consumed batch", async () => {
    await worker.fetch(await polarDelivery("subscription.created", polarSub()), env, createExecutionContext());
    polar.subscriptions = [polarSub()];
    await reconcilePolar(env, Math.floor(Date.now() / 1000));
    const now = Math.floor(Date.now() / 1000);
    const batch = createMessageBatch(WRITES_QUEUE, [{ id: "m0", timestamp: new Date(), attempts: 1, body: { v: 1, kind: "incident", at: now - 5, marker: "polar-unreachable" } }]);
    await worker.queue(batch, env, createExecutionContext());
    const h = await health();
    expect(h).toMatchObject({ subscriptions: 1, last_polar_reconcile_corrections: 0 });
    expect(h).not.toHaveProperty("seats");
    for (const k of ["last_polar_webhook_at", "last_polar_reconcile_at", "last_queue_at", "queue_lag_s"]) expect(typeof h[k], k).toBe("number");
    expect(h.last_dead_letter_at).toBeNull();
  });
});
