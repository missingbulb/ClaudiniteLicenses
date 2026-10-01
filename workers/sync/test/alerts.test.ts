import { createExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateAlerts, type IncidentCounts, type Stamps } from "../src/alerts.ts";
import worker from "../src/index.ts";
import { env, freshDatabase } from "./github.ts";

const H = 3600;
const NOW = 1_790_000_000;
const s = (at: number, detail: string | null = null) => ({ at, detail });
/** A database whose every stamp is fresh and clean: no alert. */
const healthy = (): Stamps => ({
  last_webhook_at: s(NOW - H),
  last_reconcile_at: s(NOW - H),
  last_polar_reconcile_at: s(NOW - H),
  last_polar_reconcile_corrections: s(NOW - H, "0"),
  last_queue_at: s(NOW - 60),
  queue_lag_s: s(NOW - 60, "4"),
  paying_uncovered: s(NOW - H, "0"),
});
const ids = (stamps: Stamps, counts: IncidentCounts = {}) => evaluateAlerts(stamps, counts, NOW).map((a) => a.id);

describe("evaluateAlerts, one case each side of every threshold", () => {
  it("is silent on a healthy database and on a fresh one", () => {
    expect(ids(healthy())).toEqual([]);
    expect(ids({})).toEqual([]);
  });

  it("polar-reconcile-stale: the last reconcile older than 26 hours", () => {
    expect(ids({ ...healthy(), last_polar_reconcile_at: s(NOW - 26 * H - 1) })).toEqual(["polar-reconcile-stale"]);
    expect(ids({ ...healthy(), last_polar_reconcile_at: s(NOW - 26 * H + 1) })).toEqual([]);
  });

  it("polar-reconcile-stale: none yet, once the Worker has run a day", () => {
    const { last_polar_reconcile_at: _r, last_polar_reconcile_corrections: _c, ...never } = healthy();
    expect(ids({ ...never, last_queue_at: s(NOW - 24 * H - 1), last_webhook_at: s(NOW - H) })).toEqual(["polar-reconcile-stale"]);
    expect(ids({ ...never, last_queue_at: s(NOW - H), last_webhook_at: s(NOW - 24 * H - 1) })).toEqual(["polar-reconcile-stale"]);
    expect(ids({ ...never, last_queue_at: s(NOW - 24 * H + 1), last_webhook_at: s(NOW - 24 * H + 1) })).toEqual([]);
  });

  it("polar-reconcile-failing: the last attempt's error stands", () => {
    const a = evaluateAlerts({ ...healthy(), last_polar_reconcile_error: s(NOW - 60, "503") }, {}, NOW);
    expect(a).toEqual([{ id: "polar-reconcile-failing", since: NOW - 60, detail: "503" }]);
  });

  it("polar-reconcile-corrected: the latest reconcile corrected a row, clearing at the next clean one", () => {
    expect(ids({ ...healthy(), last_polar_reconcile_corrections: s(NOW - H, "1") })).toEqual(["polar-reconcile-corrected"]);
    expect(ids({ ...healthy(), last_polar_reconcile_corrections: s(NOW - H, "0") })).toEqual([]);
  });

  it("github-reconcile-stale: the last GitHub reconcile older than 26 hours", () => {
    expect(ids({ ...healthy(), last_reconcile_at: s(NOW - 26 * H - 1) })).toEqual(["github-reconcile-stale"]);
    expect(ids({ ...healthy(), last_reconcile_at: s(NOW - 26 * H + 1) })).toEqual([]);
  });

  it("queue-lagging: a lag over 15 minutes on a batch consumed within a day", () => {
    expect(ids({ ...healthy(), queue_lag_s: s(NOW - 60, "901") })).toEqual(["queue-lagging"]);
    expect(ids({ ...healthy(), queue_lag_s: s(NOW - 60, "900") })).toEqual([]);
    expect(ids({ ...healthy(), last_queue_at: s(NOW - 24 * H - 1), queue_lag_s: s(NOW - 24 * H - 1, "5000") })).toEqual([]);
  });

  it("writes-dead-lettered: a dead letter within a day", () => {
    expect(ids({ ...healthy(), last_dead_letter_at: s(NOW - 24 * H + 1) })).toEqual(["writes-dead-lettered"]);
    expect(ids({ ...healthy(), last_dead_letter_at: s(NOW - 24 * H - 1) })).toEqual([]);
  });

  it("paying-uncovered: any paying account the App no longer covers", () => {
    expect(evaluateAlerts({ ...healthy(), paying_uncovered: s(NOW - H, "2") }, {}, NOW)).toEqual([{ id: "paying-uncovered", since: NOW - H, detail: "2" }]);
    expect(ids({ ...healthy(), paying_uncovered: s(NOW - H, "0") })).toEqual([]);
  });

  const counted: [string, string, number][] = [
    ["polar-webhooks-refused", "polar-webhook-refused", 3],
    ["d1-unreadable", "d1-unreadable", 1],
    ["polar-unreachable", "polar-unreachable", 3],
    ["app-not-installed", "app-not-installed", 5],
    ["secondary-rate-limit", "secondary-rate-limit", 1],
  ];
  for (const [id, marker, atLeast] of counted) {
    it(`${id}: ${atLeast} or more ${marker} in the last hour`, () => {
      const at = (count: number): IncidentCounts => (count === 0 ? {} : { [marker]: { count, first: NOW - 600 } });
      expect(evaluateAlerts(healthy(), at(atLeast), NOW)).toEqual([{ id, since: NOW - 600, detail: `${atLeast} in the last hour` }]);
      expect(ids(healthy(), at(atLeast - 1))).toEqual([]);
    });
  }

  it("ignores write-dead-lettered rows, which the dead-letter stamp already alerts on", () => {
    expect(ids(healthy(), { "write-dead-lettered": { count: 9, first: NOW - 60 } })).toEqual([]);
  });
});

describe("GET /v1/sync/alerts", () => {
  const alerts = async (e = env) => {
    const res = await worker.fetch(new Request("https://license.claudinite.com/v1/sync/alerts"), e, createExecutionContext());
    return { status: res.status, body: (await res.json()) as { ok: boolean; checked_at: number; alerts: { id: string; since: number | null; detail: string | null }[] } };
  };
  const now = () => Math.floor(Date.now() / 1000);
  const incident = (marker: string, at: number) => env.DB.prepare("INSERT INTO incidents (marker, at) VALUES (?, ?)").bind(marker, at).run();

  beforeEach(async () => {
    await freshDatabase();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it("answers 200 with no alerts on a fresh database", async () => {
    const { status, body } = await alerts();
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, checked_at: expect.any(Number), alerts: [] });
    expect(Math.abs(body.checked_at - now())).toBeLessThan(5);
  });

  it("answers 503 with the list, counting only incidents inside the hour", async () => {
    await env.DB.prepare("INSERT INTO sync_state (name, at, detail) VALUES ('paying_uncovered', ?, '1')").bind(now()).run();
    await incident("polar-unreachable", now() - 10);
    await incident("polar-unreachable", now() - 20);
    await incident("polar-unreachable", now() - H - 60);
    expect((await alerts()).body.alerts.map((a) => a.id)).toEqual(["paying-uncovered"]);
    await incident("polar-unreachable", now() - 30);
    const { status, body } = await alerts();
    expect(status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.alerts.map((a) => a.id).sort()).toEqual(["paying-uncovered", "polar-unreachable"]);
    expect(body.alerts.find((a) => a.id === "polar-unreachable")).toMatchObject({ detail: "3 in the last hour" });
  });

  it("answers 503 sync-d1-unreadable when D1 cannot be read", async () => {
    const broken = { ...env, DB: new Proxy(env.DB, { get: (t, p) => (p === "prepare" ? () => { throw new Error("D1_ERROR: acme outage"); } : Reflect.get(t, p)) }) as D1Database };
    const { status, body } = await alerts(broken);
    expect(status).toBe(503);
    expect(body).toMatchObject({ ok: false, alerts: [{ id: "sync-d1-unreadable" }] });
  });
});
