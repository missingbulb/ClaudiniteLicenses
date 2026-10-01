import { createExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { env, freshDatabase } from "./github.ts";
import { polarDelivery, polarSub, subscriptionRows, unix } from "./polar.ts";

let logs: string[];
const send = async (req: Request, e = env) => worker.fetch(req, e, createExecutionContext());
const stamp = () => env.DB.prepare("SELECT at FROM sync_state WHERE name = 'last_polar_webhook_at'").first<{ at: number }>();

beforeEach(async () => {
  await freshDatabase();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("no outbound call expected", { status: 599 }));
});

afterEach(() => vi.restoreAllMocks());

describe("POST /v1/sync/polar-webhook", () => {
  it("writes a signed subscription.created into every column, and stamps last_polar_webhook_at", async () => {
    const sub = polarSub();
    const res = await send(await polarDelivery("subscription.created", sub));
    expect(res.status).toBe(200);
    expect(await subscriptionRows()).toEqual([
      {
        polar_subscription_id: "sub_acme",
        owner_id: 2002,
        owner_type: "User",
        plan: "personal",
        seats: 5,
        repo_ids: null,
        source: "polar",
        period_end: unix("2026-10-01T00:00:00Z"),
        cancel_at_period_end: 0,
        modified_at: unix("2026-09-02T00:00:00Z"),
        raw: JSON.stringify(sub),
        status: "active",
        ended_at: null,
        product_id: "prod_personal_month",
        interval: "month",
      },
    ]);
    expect((await stamp())?.at).toBeGreaterThan(0);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("moves seats on a later .updated, and ignores an .updated older than the stored row", async () => {
    await send(await polarDelivery("subscription.created", polarSub()));
    await send(await polarDelivery("subscription.updated", polarSub({ seats: 8, modified_at: "2026-09-05T00:00:00Z" })));
    expect((await subscriptionRows())[0]).toMatchObject({ seats: 8, modified_at: unix("2026-09-05T00:00:00Z") });
    const late = await send(await polarDelivery("subscription.updated", polarSub({ seats: 3, modified_at: "2026-09-03T00:00:00Z" })));
    expect(late.status).toBe(200);
    expect((await subscriptionRows())[0]).toMatchObject({ seats: 8, modified_at: unix("2026-09-05T00:00:00Z") });
  });

  it("reads modified_at as created_at when Polar has never modified the subscription", async () => {
    await send(await polarDelivery("subscription.created", polarSub({ modified_at: null })));
    expect((await subscriptionRows())[0]!.modified_at).toBe(unix("2026-09-01T00:00:00Z"));
  });

  it("stores a revoke's status and ended_at, and a cancellation that keeps its seats to the period's end", async () => {
    await send(await polarDelivery("subscription.canceled", polarSub({ cancel_at_period_end: true, modified_at: "2026-09-03T00:00:00Z" })));
    expect((await subscriptionRows())[0]).toMatchObject({ seats: 5, cancel_at_period_end: 1, status: "active", ended_at: null });
    await send(await polarDelivery("subscription.revoked", polarSub({ status: "canceled", ended_at: "2026-09-04T00:00:00Z", modified_at: "2026-09-04T00:00:00Z" })));
    expect((await subscriptionRows())[0]).toMatchObject({ status: "canceled", ended_at: unix("2026-09-04T00:00:00Z") });
  });

  it("stores a Private repo subscription's one repo id", async () => {
    const sub = polarSub({ plan: "private-repo", metadata: { claudinite_plan: "private-repo", github_owner_id: "2002", github_owner_type: "Organization", github_repo_id: "1001", github_repo_full_name: "acme-org/acme-repo" } });
    await send(await polarDelivery("subscription.active", sub));
    expect((await subscriptionRows())[0]).toMatchObject({ plan: "private-repo", repo_ids: "[1001]", owner_type: "Organization" });
  });

  it("writes nothing for a subscription with no numeric external id, or on a product we do not manage, and logs why", async () => {
    for (const externalId of [null, "acme-user"]) {
      expect((await send(await polarDelivery("subscription.created", polarSub({ externalId })))).status).toBe(200);
    }
    expect(logs.filter((l) => l.includes('"marker":"polar-no-external-id"'))).toHaveLength(2);
    expect((await send(await polarDelivery("subscription.created", polarSub({ managed: false })))).status).toBe(200);
    expect(logs.some((l) => l.includes('"marker":"polar-not-managed"'))).toBe(true);
    expect(await subscriptionRows()).toEqual([]);
  });

  it("answers 401 with the reason and stamps nothing when the signature is wrong, stale or missing", async () => {
    const wrong = await send(await polarDelivery("subscription.created", polarSub(), { secret: `whsec_${btoa("someone else's secret")}` }));
    expect([wrong.status, await wrong.text()]).toEqual([401, "signature-mismatch"]);
    const stale = await send(await polarDelivery("subscription.created", polarSub(), { timestamp: Math.floor(Date.now() / 1000) - 600 }));
    expect([stale.status, await stale.text()]).toEqual([401, "timestamp-skew"]);
    const bare = await send(new Request("https://license.claudinite.com/v1/sync/polar-webhook", { method: "POST", body: "{}" }));
    expect([bare.status, await bare.text()]).toEqual([401, "signature-missing"]);
    const { POLAR_WEBHOOK_SECRET: _unset, ...noSecret } = env;
    const unset = await send(await polarDelivery("subscription.created", polarSub()), noSecret);
    expect(unset.status).toBe(401);
    expect(await subscriptionRows()).toEqual([]);
    expect(await stamp()).toBeNull();
    expect(logs.filter((l) => l.includes('"marker":"polar-webhook-refused"')).map((l) => JSON.parse(l).reason)).toEqual(["signature-mismatch", "timestamp-skew", "signature-missing", "secret-unset"]);
  });

  it("answers checkout.created and any other event 204 with no write, and stamps", async () => {
    const res = await send(await polarDelivery("checkout.created", { id: "chk_acme" }));
    expect(res.status).toBe(204);
    expect(await subscriptionRows()).toEqual([]);
    expect(await stamp()).not.toBeNull();
    expect((await send(await polarDelivery("order.paid", { id: "ord_acme" }))).status).toBe(204);
  });
});
