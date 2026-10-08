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

const request = (over: Partial<PlanRequest> = {}): PlanRequest => ({ repoId: 1001, ownerId: 2002, ownerType: "User", ...over });

function issued(r: Resolution) {
  if ("refused" in r) throw new Error(`refused ${r.refused}`);
  return r;
}

async function resolve(e: Env, req: PlanRequest): Promise<Resolution> {
  const row = (await readRepo(reader(e), req.repoId)) as RepoRow;
  world.dbSql = [];
  return resolveForRow(e, reader(e), req, row);
}

const org = { owner_id: 8008, owner_type: "Organization", owner_login: "acme-org", full_name: "acme-org/acme-repo" };
const orgRequest = request({ ownerId: 8008, ownerType: "Organization" });

describe("resolveForRow", () => {
  it("gives an owner with no fleet the Public plan, ok, no seats and no notice, whether the repo is public or private", async () => {
    for (const visibility of ["public", "private"]) {
      await freshDatabase();
      await seedRepo({ visibility });
      const r = issued(await resolve(env(), request()));
      expect(r, visibility).toMatchObject({ plan: "public", state: "ok", seats: null, notice: null, grace_until: null, subscribed: false, row: { repo_id: 1001 } });
      expect(r.features, visibility).toEqual(allButFleet);
    }
  });

  it("reads the owner's subscriptions and nothing else, and never their seats", async () => {
    await seedRepo({ visibility: "private" });
    await seedSubscription({ plan: "personal" });
    issued(await resolve(env(), request()));
    expect(world.dbSql).toEqual(["SELECT plan, status, ended_at FROM subscriptions WHERE owner_id = ?"]);
  });

  it("gives a User paying for the Personal fleet Personal, and an Organization paying for the Organization fleet Organization, every feature and no seats", async () => {
    await seedRepo({ visibility: "private" });
    await seedSubscription({ plan: "personal" });
    const personal = issued(await resolve(env(), request()));
    expect(personal).toMatchObject({ plan: "personal", state: "ok", seats: null, notice: null, subscribed: true });
    expect(personal.features).toEqual([...FEATURES]);
    await freshDatabase();
    await seedRepo({ repo_id: 1001, ...org });
    await seedSubscription({ owner_id: 8008, owner_type: "Organization", plan: "organization", seats: 0 });
    const organization = issued(await resolve(env(), orgRequest));
    expect(organization).toMatchObject({ plan: "organization", state: "ok", seats: null, notice: null, subscribed: true });
    expect(organization.features).toEqual([...FEATURES]);
  });

  it("gives no fleet to a User whose row is an Organization fleet, or an Organization whose row is a Personal fleet", async () => {
    await seedRepo();
    await seedSubscription({ plan: "organization" });
    expect(issued(await resolve(env(), request()))).toMatchObject({ plan: "public", subscribed: true });
    await freshDatabase();
    await seedRepo({ repo_id: 1001, ...org });
    await seedSubscription({ owner_id: 8008, owner_type: "Organization", plan: "personal" });
    expect(issued(await resolve(env(), orgRequest))).toMatchObject({ plan: "public", subscribed: true });
  });

  it("gives an internal row's owner Internal, of either type, ahead of any fleet", async () => {
    await seedRepo();
    await seedSubscription({ plan: "personal" });
    await seedSubscription({ plan: "internal" });
    expect(issued(await resolve(env(), request()))).toMatchObject({ plan: "internal", features: [...FEATURES] });
    await freshDatabase();
    await seedRepo({ repo_id: 1001, ...org });
    await seedSubscription({ owner_id: 8008, owner_type: "Organization", plan: "internal" });
    expect(issued(await resolve(env(), orgRequest))).toMatchObject({ plan: "internal" });
  });

  it("gives missingbulb Internal with no subscription row, by its GitHub id", async () => {
    await seedRepo({ owner_id: 73882448, owner_login: "missingbulb", full_name: "missingbulb/Shepherd" });
    expect(issued(await resolve(env(), request({ ownerId: 73882448 })))).toMatchObject({ plan: "internal", features: [...FEATURES], subscribed: false });
  });

  it("reads a revoked subscription as no fleet, while it still counts as subscribed", async () => {
    await seedRepo();
    await seedSubscription({ plan: "personal", status: "canceled", ended_at: nowS() - DAY });
    expect(issued(await resolve(env(), request()))).toMatchObject({ plan: "public", state: "ok", subscribed: true });
  });

  it("refuses server-error and reports d1-unreadable when the subscriptions cannot be read", async () => {
    await seedRepo();
    const row = (await readRepo(reader(env()), 1001)) as RepoRow;
    expect(await resolveForRow(env({ brokenDb: true }), reader(env({ brokenDb: true })), request(), row)).toEqual({ refused: "server-error" });
    expect(world.logs.some((l) => JSON.parse(l).marker === "d1-unreadable")).toBe(true);
  });
});
