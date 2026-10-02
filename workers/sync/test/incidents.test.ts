import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { INCIDENT_KEEP_S, pruneIncidents } from "../src/incidents.ts";
import { env, fakeGitHub, freshDatabase } from "./github.ts";
import { fakePolar, polarDelivery, polarSub } from "./polar.ts";

const DAY = 86400;
const T = 1_790_000_000;
const seedIncident = (marker: string, at: number) => env.DB.prepare("INSERT INTO incidents (marker, at) VALUES (?, ?)").bind(marker, at).run();
const incidents = async () => (await env.DB.prepare("SELECT marker, at, detail FROM incidents ORDER BY id").all()).results;

beforeEach(async () => {
  await freshDatabase();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("pruneIncidents", () => {
  it("removes an 8-day-old incident and keeps a 6-day-old one", async () => {
    expect(INCIDENT_KEEP_S).toBe(7 * DAY);
    await seedIncident("d1-unreadable", T - 8 * DAY);
    await seedIncident("d1-unreadable", T - 6 * DAY);
    expect(await pruneIncidents(env.DB, T)).toBe(1);
    expect(await incidents()).toEqual([{ marker: "d1-unreadable", at: T - 6 * DAY, detail: null }]);
  });

  it("removes an 8-day-old deploy-read-back with the rest", async () => {
    await seedIncident("deploy-read-back", T - 8 * DAY);
    await seedIncident("deploy-read-back", T - 6 * DAY);
    expect(await pruneIncidents(env.DB, T)).toBe(1);
    expect(await incidents()).toEqual([{ marker: "deploy-read-back", at: T - 6 * DAY, detail: null }]);
  });

  it("runs at the end of the nightly cron, and not on the hourly one", async () => {
    fakeGitHub();
    fakePolar();
    const now = Math.floor(Date.now() / 1000);
    await seedIncident("polar-unreachable", now - 8 * DAY);
    const run = async (cron: string) => {
      const ctx = createExecutionContext();
      await worker.scheduled(createScheduledController({ scheduledTime: new Date(now * 1000), cron }), env, ctx);
      await waitOnExecutionContext(ctx);
    };
    await env.DB.prepare("INSERT INTO sync_state (name, at) VALUES ('last_polar_reconcile_at', ?)").bind(now).run();
    await run("47 * * * *");
    expect(await incidents()).toHaveLength(1);
    await run("17 3 * * *");
    expect(await incidents()).toEqual([]);
  });
});

describe("the cron stamps", () => {
  const ID = (env as unknown as { CF_VERSION_METADATA: { id: string } }).CF_VERSION_METADATA.id;
  const stampOf = async (name: string) => env.DB.prepare("SELECT at, detail FROM sync_state WHERE name = ?").bind(name).first<{ at: number; detail: string | null }>();
  const run = async (cron: string, at: number) => {
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: new Date(at * 1000), cron }), env, ctx);
    await waitOnExecutionContext(ctx);
  };

  it("both crons stamp last_cron_at with their own expression and last_cron_version with the running version", async () => {
    fakeGitHub();
    fakePolar();
    const now = Math.floor(Date.now() / 1000);
    await run("47 * * * *", now - 60);
    expect(await stampOf("last_cron_at")).toEqual({ at: now - 60, detail: "47 * * * *" });
    expect(await stampOf("last_cron_version")).toEqual({ at: now - 60, detail: ID });
    await run("17 3 * * *", now);
    expect(await stampOf("last_cron_at")).toEqual({ at: now, detail: "17 3 * * *" });
    expect(await stampOf("last_cron_version")).toEqual({ at: now, detail: ID });
  });

  it("stamps on the hourly cron even when the Polar reconcile is not due, and before the work fails", async () => {
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare("INSERT INTO sync_state (name, at) VALUES ('last_polar_reconcile_at', ?)").bind(now).run();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Promise.reject(new Error("acme outage")));
    await run("47 * * * *", now);
    await run("17 3 * * *", now + 1);
    expect(await stampOf("last_cron_at")).toEqual({ at: now + 1, detail: "17 3 * * *" });
    expect((await stampOf("last_cron_version"))!.detail).toBe(ID);
  });
});

describe("the sync Worker's own incidents", () => {
  it("writes a polar-webhook-refused row naming the reason for each refused Polar delivery", async () => {
    const send = (req: Request, e = env) => worker.fetch(req, e, createExecutionContext());
    const wrong = await polarDelivery("subscription.created", polarSub(), { secret: `whsec_${btoa("another secret, of 32 bytes!!!!!")}` });
    expect((await send(wrong)).status).toBe(401);
    const { POLAR_WEBHOOK_SECRET: _unset, ...noSecret } = env;
    expect((await send(await polarDelivery("subscription.created", polarSub()), noSecret)).status).toBe(401);
    expect(await incidents()).toEqual([
      { marker: "polar-webhook-refused", at: expect.any(Number), detail: "signature-mismatch" },
      { marker: "polar-webhook-refused", at: expect.any(Number), detail: "secret-unset" },
    ]);
  });

  it("stops recording refusals past a hundred an hour, so an unsigned flood cannot grow the table without bound", async () => {
    const now = Math.floor(Date.now() / 1000);
    await env.DB.batch(Array.from({ length: 100 }, () => env.DB.prepare("INSERT INTO incidents (marker, at) VALUES ('polar-webhook-refused', ?)").bind(now - 60)));
    const res = await worker.fetch(new Request("https://license.claudinite.com/v1/sync/polar-webhook", { method: "POST", body: "{}" }), env, createExecutionContext());
    expect(res.status).toBe(401);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM incidents").first()).toEqual({ n: 100 });
  });
});
