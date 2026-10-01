import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dayOf } from "../../../packages/licensing/src/index.ts";
import { FEATURES } from "../../../packages/signing/src/index.ts";
import { resolvePlan, type Resolution } from "../src/plan.ts";
import { DAY, env, freshDatabase, nowS, resetWorld, seedOveruse, seedRepo, seedSeats, seedSubscription, seedUsage, world } from "./helpers.ts";

beforeEach(async () => {
  await freshDatabase();
  resetWorld();
});

afterEach(() => vi.restoreAllMocks());

const allButFleet = FEATURES.filter((f) => f !== "fleet");
const NEW_USER = 3003;

const session = (over: Partial<{ repoId: number; visibility: string; ownerId: number; userId: number | null }> = {}) =>
  ({ repoId: 1001, visibility: "private", ownerId: 2002, userId: NEW_USER, typ: "session" as const, ...over });

function issued(r: Resolution) {
  if ("refused" in r) throw new Error(`refused ${r.refused}`);
  return r;
}

const kinds = (r: Resolution) => issued(r).writes.map((w) => w.kind).sort();

describe("resolvePlan", () => {
  it("refuses a repo the App is not installed on", async () => {
    expect(await resolvePlan(env(), session({ visibility: "public" }))).toEqual({ refused: "app-not-installed" });
  });

  it("gives a public repo with no paid owner plan the Public plan, no seats and no write", async () => {
    await seedRepo();
    const r = issued(await resolvePlan(env(), session({ visibility: "public" })));
    expect(r).toMatchObject({ plan: "public", state: "ok", seats: null, notice: null, writes: [], grace_until: null, row: { repo_id: 1001, default_branch: "main", owner_type: "User" } });
    expect(r.features).toEqual(allButFleet);
  });

  it("gives a private repo with no subscription a Private repo key in grace, zero paid seats, a grace-start and a usage write", async () => {
    await seedRepo({ visibility: "private" });
    const r = issued(await resolvePlan(env(), session()));
    expect(r).toMatchObject({ plan: "private-repo", state: "grace", seats: { paid: 0, counted: 1, headroom: 0 }, notice: "overused" });
    expect(r.grace_until).toBeGreaterThanOrEqual(nowS() + 7 * DAY - 5);
    expect(r.features).toEqual(allButFleet);
    expect(r.writes).toEqual([
      { v: 1, kind: "usage", at: expect.any(Number), repo_id: 1001, user_id: NEW_USER, owner_id: 2002, plan: "private-repo", day: dayOf(nowS()) },
      { v: 1, kind: "grace-start", at: expect.any(Number), owner_id: 2002 },
    ]);
  });

  it("takes visibility from the caller, never from the row", async () => {
    await seedRepo({ visibility: "public" });
    expect(issued(await resolvePlan(env(), session({ visibility: "private" }))).plan).toBe("private-repo");
    await seedRepo({ repo_id: 1002, visibility: "private" });
    expect(issued(await resolvePlan(env(), session({ repoId: 1002, visibility: "public" }))).plan).toBe("public");
    expect(issued(await resolvePlan(env(), session({ visibility: "internal" }))).plan).toBe("private-repo");
  });

  describe("under a Personal subscription of 5 seats", () => {
    beforeEach(async () => {
      await seedRepo({ visibility: "private" });
      await seedSubscription({ plan: "personal", seats: 5 });
    });

    it("gives a new user beside two seated ones an ok Personal key with every feature", async () => {
      await seedSeats(2002, 2);
      const r = issued(await resolvePlan(env(), session()));
      expect(r).toMatchObject({ plan: "personal", state: "ok", notice: null, seats: { paid: 5, counted: 3, headroom: 1 }, subscribed: true });
      expect(r.features).toEqual([...FEATURES]);
      expect(kinds(r)).toEqual(["usage"]);
    });

    it("tells the sixth user the licensee is over its count, within headroom", async () => {
      await seedSeats(2002, 5);
      expect(issued(await resolvePlan(env(), session()))).toMatchObject({ state: "ok", notice: "over-within-headroom", seats: { counted: 6 } });
    });

    it("starts grace for the seventh, ending 7 days out", async () => {
      await seedSeats(2002, 6);
      const r = issued(await resolvePlan(env(), session()));
      expect(r).toMatchObject({ state: "grace", notice: "overused" });
      expect(r.grace_until! - nowS()).toBeGreaterThan(7 * DAY - 5);
      expect(kinds(r)).toEqual(["grace-start", "usage"]);
    });

    it("degrades the seventh once grace started 8 days ago, while the user ranked 3 keeps every feature", async () => {
      await seedSeats(2002, 6);
      await seedOveruse(2002, nowS() - 8 * DAY, nowS() + 22 * DAY);
      expect(issued(await resolvePlan(env(), session()))).toMatchObject({ state: "degraded", notice: "seat-refused", features: [] });
      const third = issued(await resolvePlan(env(), session({ userId: 4003 })));
      expect(third).toMatchObject({ state: "ok" });
      expect(third.features).toEqual([...FEATURES]);
    });

    it("sends no usage write when today's usage row and the user's seat already exist", async () => {
      await seedSeats(2002, 2);
      await seedUsage(1001, 4001, dayOf(nowS()));
      expect(issued(await resolvePlan(env(), session({ userId: 4001 }))).writes).toEqual([]);
    });

    it("sends a usage write when today's usage row exists but the user has no seat under this licensee", async () => {
      await seedUsage(1001, NEW_USER, dayOf(nowS()));
      expect(kinds(await resolvePlan(env(), session()))).toEqual(["usage"]);
    });

    it("asks for a grace-reset once back within the count with a start stored", async () => {
      await seedSeats(2002, 2);
      await seedOveruse(2002, nowS() - DAY, nowS() + 29 * DAY);
      expect(kinds(await resolvePlan(env(), session()))).toEqual(["grace-reset", "usage"]);
    });
  });

  it("gives a Private repo subscription naming the repo every feature but fleet, and one naming another repo no seats", async () => {
    await seedRepo({ visibility: "private" });
    await seedRepo({ repo_id: 1002, visibility: "private" });
    await seedSubscription({ plan: "private-repo", seats: 3, repo_ids: "[1001]" });
    const named = issued(await resolvePlan(env(), session()));
    expect(named).toMatchObject({ plan: "private-repo", state: "ok", seats: { paid: 3, counted: 1, headroom: 1 } });
    expect(named.features).toEqual(allButFleet);
    expect(named.writes.find((w) => w.kind === "usage")).toMatchObject({ plan: "private-repo", repo_id: 1001 });
    expect(issued(await resolvePlan(env(), session({ repoId: 1002 })))).toMatchObject({ plan: "private-repo", state: "grace", seats: { paid: 0 } });
  });

  it("gives a public repo under an Organization subscription the Organization plan with fleet, reading no seat and writing nothing", async () => {
    await seedRepo({ owner_id: 8008, owner_type: "Organization", owner_login: "acme-org" });
    await seedSubscription({ owner_id: 8008, owner_type: "Organization", plan: "organization", seats: 10 });
    const r = issued(await resolvePlan(env(), session({ visibility: "public", ownerId: 8008 })));
    expect(r).toMatchObject({ plan: "organization", state: "ok", seats: null, writes: [], notice: null });
    expect(r.features).toEqual([...FEATURES]);
    expect(world.dbSql.map((s) => s.split(" FROM ")[1]?.split(" ")[0])).toEqual(["repos", "subscriptions"]);
  });

  it("reads a revoked subscription as no paid seats", async () => {
    await seedRepo({ visibility: "private" });
    await seedSubscription({ plan: "personal", seats: 5, status: "canceled", ended_at: nowS() - DAY });
    expect(issued(await resolvePlan(env(), session()))).toMatchObject({ plan: "private-repo", state: "grace", seats: { paid: 0 }, subscribed: true });
  });

  it("gives an internal subscription every feature", async () => {
    await seedRepo({ visibility: "private" });
    await seedSubscription({ plan: "internal", seats: 50 });
    const r = issued(await resolvePlan(env(), session()));
    expect(r).toMatchObject({ plan: "internal", state: "ok" });
    expect(r.features).toEqual([...FEATURES]);
  });

  it("reads an Actions key's state from the licensee alone, with no caller and no write", async () => {
    await seedRepo({ visibility: "private" });
    await seedSubscription({ plan: "personal", seats: 5 });
    await seedSeats(2002, 7);
    const actions = { ...session({ userId: null }), typ: "actions" as const };
    expect(issued(await resolvePlan(env(), actions))).toMatchObject({ state: "grace", writes: [], seats: { counted: 7 } });
    await seedOveruse(2002, nowS() - 8 * DAY, nowS() + 22 * DAY);
    expect(issued(await resolvePlan(env(), actions))).toMatchObject({ state: "degraded", features: [], writes: [] });
  });

  it("fails open on a private repo with a Private repo key, unverified, every feature and one usage write, logging d1-unreadable", async () => {
    const r = issued(await resolvePlan(env({ brokenDb: true }), session()));
    expect(r).toMatchObject({ plan: "private-repo", state: "unverified", seats: null, row: null });
    expect(r.features).toEqual([...FEATURES]);
    expect(r.writes).toEqual([{ v: 1, kind: "usage", at: expect.any(Number), repo_id: 1001, user_id: NEW_USER, owner_id: 2002, plan: "private-repo", day: dayOf(nowS()) }]);
    expect(world.logs.some((l) => JSON.parse(l).marker === "d1-unreadable")).toBe(true);
  });

  it("fails open on a public repo with a Public key and no write", async () => {
    const r = issued(await resolvePlan(env({ brokenDb: true }), session({ visibility: "public" })));
    expect(r).toMatchObject({ plan: "public", state: "unverified", writes: [] });
  });

  it("refuses server-error when D1 throws and FAIL_OPEN is anything but true", async () => {
    for (const FAIL_OPEN of ["false", undefined, "TRUE"]) {
      expect(await resolvePlan(env({ brokenDb: true, FAIL_OPEN }), session({ visibility: "public" })), String(FAIL_OPEN)).toEqual({ refused: "server-error" });
    }
  });

  it("can be told the App is installed, as a webhook through an installation proves", async () => {
    expect(await resolvePlan(env(), session({ visibility: "public" }), { installed: true })).toMatchObject({ plan: "public", state: "ok", row: null });
    expect(await resolvePlan(env(), session(), { installed: true })).toMatchObject({ plan: "private-repo", state: "grace" });
  });
});
