import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dayOf } from "../../../packages/licensing/src/index.ts";
import { call, env, freshDatabase, githubRepo, NONCE, nowS, resetWorld, seedRepo, sentMessages, world } from "./helpers.ts";

beforeEach(async () => {
  await freshDatabase();
  resetWorld();
});

afterEach(() => vi.restoreAllMocks());

const ask = (e = env()) =>
  call("/v1/session-key", { method: "POST", headers: { Authorization: "Bearer ghu_acme", "Content-Type": "application/json" }, body: JSON.stringify({ repo: "acme-user/acme-repo", nonce: NONCE, engine_version: "1.1.0" }) }, e);

const usage = () => sentMessages().filter((m) => m.kind === "usage");

describe("the writes producer", () => {
  beforeEach(() => {
    world.repo = () => Response.json(githubRepo({ private: true, visibility: "private" }));
  });

  it("sends one usage message on the first private-repo key of the day, inside waitUntil, and none on the second once it is written", async () => {
    await seedRepo({ visibility: "private" });
    await ask();
    expect(world.waited).toHaveLength(1);
    expect(usage()).toEqual([{ v: 1, kind: "usage", at: expect.any(Number), repo_id: 1001, user_id: 3003, owner_id: 2002, plan: "private-repo", day: dayOf(nowS()) }]);
    await env().DB.batch([
      env().DB.prepare("INSERT INTO usage (repo_id, user_id, day) VALUES (1001, 3003, ?)").bind(dayOf(nowS())),
      env().DB.prepare("INSERT INTO seats (licensee_id, user_id, first_key_at, last_key_at) VALUES (1001, 3003, ?, ?)").bind(nowS(), nowS()),
    ]);
    resetWorld();
    world.repo = () => Response.json(githubRepo({ private: true, visibility: "private" }));
    await ask();
    expect(usage()).toEqual([]);
  });

  it("sends nothing for a public repo", async () => {
    await seedRepo();
    world.repo = () => Response.json(githubRepo());
    await ask();
    expect(world.sent).toEqual([]);
    expect(world.waited).toEqual([]);
  });

  it("sends one usage message on a fail-open key", async () => {
    await ask(env({ brokenDb: true }));
    expect(usage()).toHaveLength(1);
  });

  it("still answers the key and logs queue-send-failed when sendBatch throws", async () => {
    await seedRepo({ visibility: "private" });
    world.send = async () => {
      throw new Error("acme queue outage");
    };
    const res = await ask();
    expect(res.status).toBe(200);
    expect(((await res.json()) as { key: string }).key).toBeTruthy();
    expect(world.logs.some((l) => l.includes('"marker":"queue-send-failed"'))).toBe(true);
  });

  it("answers without a queue binding, logging the send it could not make", async () => {
    await seedRepo({ visibility: "private" });
    const res = await ask(env({ WRITES: undefined }));
    expect(res.status).toBe(200);
    expect(world.logs.some((l) => l.includes('"marker":"queue-send-failed"'))).toBe(true);
  });
});
