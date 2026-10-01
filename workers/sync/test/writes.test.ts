import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WriteMessage } from "../../../packages/licensing/src/index.ts";
import worker from "../src/index.ts";
import { DEAD_LETTER_QUEUE, WRITES_QUEUE } from "../src/writes.ts";
import { env, freshDatabase } from "./github.ts";

const DAY = 86400;
const T = 1_790_000_000;
const usage = (over: Partial<Extract<WriteMessage, { kind: "usage" }>> = {}): WriteMessage => ({ v: 1, kind: "usage", at: T, repo_id: 1001, user_id: 3003, owner_id: 2002, plan: "personal", day: "2026-09-21", ...over });
const grace = (kind: "grace-start" | "grace-reset", at = T): WriteMessage => ({ v: 1, kind, at, owner_id: 2002 });

let logs: string[];

async function consume(bodies: unknown[], queue = WRITES_QUEUE, e = env) {
  const batch = createMessageBatch(queue, bodies.map((body, i) => ({ id: `m${i}`, timestamp: new Date(), attempts: 1, body })));
  const ctx = createExecutionContext();
  await worker.queue(batch, e, ctx);
  return getQueueResult(batch, ctx);
}

const all = async (sql: string) => (await env.DB.prepare(sql).all()).results;
const stampOf = async (name: string) => env.DB.prepare("SELECT at, detail FROM sync_state WHERE name = ?").bind(name).first<{ at: number; detail: string | null }>();

beforeEach(async () => {
  await freshDatabase();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
});

afterEach(() => vi.restoreAllMocks());

describe("the writes queue consumer", () => {
  it("writes a usage message's usage row and its seat, keyed by the plan's licensee, and acks the batch", async () => {
    const res = await consume([usage(), usage({ plan: "private-repo", user_id: 3004 })]);
    expect(res).toMatchObject({ outcome: "ok", ackAll: true, retryBatch: { retry: false } });
    expect(await all("SELECT repo_id, user_id, day FROM usage ORDER BY user_id")).toEqual([
      { repo_id: 1001, user_id: 3003, day: "2026-09-21" },
      { repo_id: 1001, user_id: 3004, day: "2026-09-21" },
    ]);
    expect(await all("SELECT licensee_id, user_id, first_key_at, last_key_at FROM seats ORDER BY user_id")).toEqual([
      { licensee_id: 2002, user_id: 3003, first_key_at: T, last_key_at: T },
      { licensee_id: 1001, user_id: 3004, first_key_at: T, last_key_at: T },
    ]);
  });

  it("changes nothing on a redelivered message", async () => {
    await consume([usage()]);
    await consume([usage(), usage()]);
    expect(await all("SELECT COUNT(*) AS n FROM usage")).toEqual([{ n: 1 }]);
    expect(await all("SELECT first_key_at, last_key_at FROM seats")).toEqual([{ first_key_at: T, last_key_at: T }]);
  });

  it("moves last_key_at only on a later usage, never back", async () => {
    await consume([usage()]);
    await consume([usage({ at: T + DAY, day: "2026-09-22" })]);
    await consume([usage({ at: T - DAY, day: "2026-09-20" })]);
    expect(await all("SELECT first_key_at, last_key_at FROM seats")).toEqual([{ first_key_at: T, last_key_at: T + DAY }]);
    expect(await all("SELECT COUNT(*) AS n FROM usage")).toEqual([{ n: 3 }]);
  });

  it("starts the seat afresh on a usage more than 30 days after its last key", async () => {
    await consume([usage()]);
    await consume([usage({ at: T + 31 * DAY, day: "2026-10-22" })]);
    expect(await all("SELECT first_key_at, last_key_at FROM seats")).toEqual([{ first_key_at: T + 31 * DAY, last_key_at: T + 31 * DAY }]);
  });

  it("keeps the first grace start and the later spent date across two grace-starts", async () => {
    await consume([grace("grace-start", T)]);
    await consume([grace("grace-start", T + DAY)]);
    expect(await all("SELECT licensee_id, grace_started_at, grace_spent_until FROM overuse")).toEqual([{ licensee_id: 2002, grace_started_at: T, grace_spent_until: T + DAY + 30 * DAY }]);
  });

  it("clears the start on grace-reset and keeps grace_spent_until", async () => {
    await consume([grace("grace-start", T)]);
    await consume([grace("grace-reset", T + DAY)]);
    expect(await all("SELECT grace_started_at, grace_spent_until FROM overuse")).toEqual([{ grace_started_at: null, grace_spent_until: T + 30 * DAY }]);
  });

  it("writes in message order within one batch", async () => {
    await consume([grace("grace-start", T), grace("grace-reset", T + 1)]);
    expect(await all("SELECT grace_started_at FROM overuse")).toEqual([{ grace_started_at: null }]);
  });

  it("retries every message and writes nothing when D1 throws", async () => {
    const broken = { ...env, DB: new Proxy(env.DB, { get: (t, p) => (p === "batch" ? async () => Promise.reject(new Error("D1_ERROR: acme outage")) : Reflect.get(t, p)) }) as D1Database };
    const res = await consume([usage(), grace("grace-start")], WRITES_QUEUE, broken);
    expect(res).toMatchObject({ ackAll: false, retryBatch: { retry: true } });
    expect(await all("SELECT COUNT(*) AS n FROM usage")).toEqual([{ n: 0 }]);
    expect(await stampOf("last_queue_at")).toBeNull();
  });

  it("stamps last_queue_at and the lag of the oldest message", async () => {
    const now = Math.floor(Date.now() / 1000);
    await consume([usage({ at: now - 40 }), grace("grace-start", now - 10)]);
    const at = await stampOf("last_queue_at");
    expect(at!.at).toBeGreaterThanOrEqual(now);
    const lag = await stampOf("queue_lag_s");
    expect(Number(lag!.detail)).toBeGreaterThanOrEqual(40);
    expect(Number(lag!.detail)).toBeLessThan(45);
  });

  it("acks and logs a message it does not know rather than retrying it forever", async () => {
    const res = await consume([{ v: 2, kind: "usage" }, usage()]);
    expect(res).toMatchObject({ ackAll: true });
    expect(logs.some((l) => l.includes('"marker":"write-malformed"'))).toBe(true);
    expect(await all("SELECT COUNT(*) AS n FROM usage")).toEqual([{ n: 1 }]);
  });

  it("writes nothing from the dead-letter queue: it logs each message and stamps last_dead_letter_at", async () => {
    const res = await consume([usage(), grace("grace-start")], DEAD_LETTER_QUEUE);
    expect(res).toMatchObject({ ackAll: true });
    expect(await all("SELECT COUNT(*) AS n FROM usage")).toEqual([{ n: 0 }]);
    expect(await all("SELECT COUNT(*) AS n FROM overuse")).toEqual([{ n: 0 }]);
    const lines = logs.filter((l) => l.includes('"marker":"write-dead-lettered"')).map((l) => JSON.parse(l));
    expect(lines).toEqual([
      { marker: "write-dead-lettered", kind: "usage", at: T },
      { marker: "write-dead-lettered", kind: "grace-start", at: T },
    ]);
    expect(await stampOf("last_dead_letter_at")).not.toBeNull();
  });
});
