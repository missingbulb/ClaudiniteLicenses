import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FEATURES } from "../../../packages/signing/src/index.ts";
import { reader } from "../src/db.ts";
import type { Env } from "../src/env.ts";
import { readRepo, resolveForRow, type PlanRequest, type RepoRow, type Resolution } from "../src/plan.ts";
import { DAY, env, freshDatabase, nowS, resetWorld, seedRepo, seedSubscription, world } from "./helpers.ts";

beforeEach(async () => {
  await freshDatabase();
  resetWorld();
});

afterEach(() => vi.restoreAllMocks());

const allButFleet = FEATURES.filter((f) => f !== "fleet");

const request = (over: Partial<PlanRequest> = {}): PlanRequest => ({ repoId: 1001, visibility: "private", ownerId: 2002, ...over });

function issued(r: Resolution) {
  if ("refused" in r) throw new Error(`refused ${r.refused}`);
  return r;
}

async function resolve(e: Env, req: PlanRequest): Promise<Resolution> {
  const row = (await readRepo(reader(e), req.repoId)) as RepoRow;
  world.dbSql = [];
  return resolveForRow(e, reader(e), req, row);
}

describe("resolveForRow", () => {
  it("gives a public repo with no paid owner plan the Public plan, ok, no seats and no notice", async () => {
    await seedRepo();
    const r = issued(await resolve(env(), request({ visibility: "public" })));
    expect(r).toMatchObject({ plan: "public", state: "ok", seats: null, notice: null, grace_until: null, subscribed: false, row: { repo_id: 1001 } });
    expect(r.features).toEqual(allButFleet);
  });

  it("reads the owner's subscriptions and nothing else: no seat, overuse or usage row", async () => {
    await seedRepo({ visibility: "private" });
    await seedSubscription({ plan: "personal", seats: 5 });
    issued(await resolve(env(), request()));
    expect(world.dbSql).toEqual(["SELECT plan, seats, repo_ids, status, ended_at FROM subscriptions WHERE owner_id = ?"]);
  });

  it("gives a paying Personal, Organization or internal owner its plan, ok, every feature, with no seats on the key", async () => {
    for (const plan of ["personal", "organization", "internal"]) {
      await freshDatabase();
      await seedRepo({ visibility: "private" });
      await seedSubscription({ plan, seats: 5 });
      const r = issued(await resolve(env(), request()));
      expect(r, plan).toMatchObject({ plan, state: "ok", seats: null, notice: null, subscribed: true });
      expect(r.features, plan).toEqual([...FEATURES]);
    }
  });

  it("reads a revoked subscription as no plan, while it still counts as subscribed", async () => {
    await seedRepo({ visibility: "public" });
    await seedSubscription({ plan: "personal", seats: 5, status: "canceled", ended_at: nowS() - DAY });
    expect(issued(await resolve(env(), request({ visibility: "public" })))).toMatchObject({ plan: "public", state: "ok", subscribed: true });
  });

  it("refuses server-error and reports d1-unreadable when the subscriptions cannot be read", async () => {
    await seedRepo();
    const row = (await readRepo(reader(env()), 1001)) as RepoRow;
    expect(await resolveForRow(env({ brokenDb: true }), reader(env({ brokenDb: true })), request(), row)).toEqual({ refused: "server-error" });
    expect(world.logs.some((l) => JSON.parse(l).marker === "d1-unreadable")).toBe(true);
  });
});
