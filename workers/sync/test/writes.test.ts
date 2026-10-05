import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WriteMessage } from "../../../packages/licensing/src/index.ts";
import worker from "../src/index.ts";
import { DEAD_LETTER_QUEUE, WRITES_QUEUE } from "../src/writes.ts";
import { env, freshDatabase } from "./github.ts";

const T = 1_790_000_000;
const incident = (at = T, marker: WriteMessage["marker"] = "polar-unreachable"): WriteMessage => ({ v: 1, kind: "incident", at, marker, detail: "checkout" });
const usage = { v: 1, kind: "usage", at: T, repo_id: 1001, user_id: 3003, owner_id: 2002, plan: "personal", day: "2026-09-21" };

let logs: string[];

async function consume(bodies: unknown[], queue = WRITES_QUEUE, e = env) {
  const batch = createMessageBatch(queue, bodies.map((body, i) => ({ id: `m${i}`, timestamp: new Date(), attempts: 1, body })));
  const ctx = createExecutionContext();
  await worker.queue(batch, e, ctx);
  return getQueueResult(batch, ctx);
}

const ID = (env as unknown as { CF_VERSION_METADATA: { id: string } }).CF_VERSION_METADATA.id;
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
  it("acks a retired seat message (usage, grace-start, grace-reset) as malformed, writing no row", async () => {
    const res = await consume([usage, { v: 1, kind: "grace-start", at: T, owner_id: 2002 }, { v: 1, kind: "grace-reset", at: T, owner_id: 2002 }]);
    expect(res).toMatchObject({ ackAll: true });
    expect(logs.filter((l) => l.includes('"marker":"write-malformed"'))).toHaveLength(3);
    expect(await all("SELECT COUNT(*) AS n FROM incidents")).toEqual([{ n: 0 }]);
  });

  it("writes in message order within one batch", async () => {
    await consume([incident(T), incident(T + 1, "d1-unreadable")]);
    expect(await all("SELECT marker, at FROM incidents ORDER BY id")).toEqual([
      { marker: "polar-unreachable", at: T },
      { marker: "d1-unreadable", at: T + 1 },
    ]);
  });

  it("retries every message and writes nothing when D1 throws", async () => {
    const broken = { ...env, DB: new Proxy(env.DB, { get: (t, p) => (p === "batch" ? async () => Promise.reject(new Error("D1_ERROR: acme outage")) : Reflect.get(t, p)) }) as D1Database };
    const res = await consume([incident(), incident()], WRITES_QUEUE, broken);
    expect(res).toMatchObject({ ackAll: false, retryBatch: { retry: true } });
    expect(await all("SELECT COUNT(*) AS n FROM incidents")).toEqual([{ n: 0 }]);
    expect(await stampOf("last_queue_at")).toBeNull();
  });

  it("stamps last_queue_at and the lag of the oldest message", async () => {
    const now = Math.floor(Date.now() / 1000);
    await consume([incident(now - 40), incident(now - 10)]);
    const at = await stampOf("last_queue_at");
    expect(at!.at).toBeGreaterThanOrEqual(now);
    const lag = await stampOf("queue_lag_s");
    expect(Number(lag!.detail)).toBeGreaterThanOrEqual(40);
    expect(Number(lag!.detail)).toBeLessThan(45);
  });

  it("stamps last_queue_version with the running version beside last_queue_at, on a writes batch and on a dead-letter batch", async () => {
    const now = Math.floor(Date.now() / 1000);
    await consume([incident()]);
    const at = await stampOf("last_queue_at");
    expect(await stampOf("last_queue_version")).toEqual({ at: at!.at, detail: ID });
    expect(at!.at).toBeGreaterThanOrEqual(now);
    await freshDatabase();
    await consume([incident()], DEAD_LETTER_QUEUE);
    const dead = await stampOf("last_dead_letter_at");
    expect(await stampOf("last_queue_version")).toEqual({ at: dead!.at, detail: ID });
  });

  it("stamps neither last_queue_at nor last_queue_version when the batch is retried", async () => {
    const broken = { ...env, DB: new Proxy(env.DB, { get: (t, p) => (p === "batch" ? async () => Promise.reject(new Error("D1_ERROR: acme outage")) : Reflect.get(t, p)) }) as D1Database };
    await consume([incident()], WRITES_QUEUE, broken);
    expect(await stampOf("last_queue_version")).toBeNull();
  });

  it("writes the deploy's deploy-read-back message as an incidents row and acks it", async () => {
    const detail = "https://github.com/missingbulb/ClaudiniteLicenses/actions/runs/1";
    const res = await consume([{ v: 1, kind: "incident", at: T, marker: "deploy-read-back", detail }]);
    expect(res).toMatchObject({ outcome: "ok", ackAll: true, retryBatch: { retry: false } });
    expect(await all("SELECT marker, at, detail FROM incidents")).toEqual([{ marker: "deploy-read-back", at: T, detail }]);
    expect((await stampOf("last_queue_version"))!.detail).toBe(ID);
  });

  it("acks and logs a message it does not know rather than retrying it forever", async () => {
    const res = await consume([{ v: 2, kind: "incident" }, incident()]);
    expect(res).toMatchObject({ ackAll: true });
    expect(logs.some((l) => l.includes('"marker":"write-malformed"'))).toBe(true);
    expect(await all("SELECT COUNT(*) AS n FROM incidents")).toEqual([{ n: 1 }]);
  });

  it("writes nothing from the dead-letter queue: it logs each message and stamps last_dead_letter_at", async () => {
    const res = await consume([incident(), usage], DEAD_LETTER_QUEUE);
    expect(res).toMatchObject({ ackAll: true });
    expect(await all("SELECT COUNT(*) AS n FROM incidents WHERE marker <> 'write-dead-lettered'")).toEqual([{ n: 0 }]);
    const lines = logs.filter((l) => l.includes('"marker":"write-dead-lettered"')).map((l) => JSON.parse(l));
    expect(lines).toEqual([
      { marker: "write-dead-lettered", kind: "incident", at: T },
      { marker: "write-dead-lettered", kind: "usage", at: T },
    ]);
    expect(await stampOf("last_dead_letter_at")).not.toBeNull();
  });

  it("writes one write-dead-lettered incident per dead-lettered message", async () => {
    const now = Math.floor(Date.now() / 1000);
    await consume([incident(), usage], DEAD_LETTER_QUEUE);
    const rows = await all("SELECT marker, at, detail FROM incidents ORDER BY id");
    expect(rows).toEqual([
      { marker: "write-dead-lettered", at: expect.any(Number), detail: "incident" },
      { marker: "write-dead-lettered", at: expect.any(Number), detail: "usage" },
    ]);
    expect((rows[0] as { at: number }).at).toBeGreaterThanOrEqual(now);
  });

  it("writes an incident message as an incidents row, with or without its detail", async () => {
    const res = await consume([
      { v: 1, kind: "incident", at: T, marker: "d1-unreadable", detail: "actions" },
      { v: 1, kind: "incident", at: T + 1, marker: "polar-unreachable" },
    ]);
    expect(res).toMatchObject({ ackAll: true });
    expect(await all("SELECT marker, at, detail FROM incidents ORDER BY id")).toEqual([
      { marker: "d1-unreadable", at: T, detail: "actions" },
      { marker: "polar-unreachable", at: T + 1, detail: null },
    ]);
  });
});
