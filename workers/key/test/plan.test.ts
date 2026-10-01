import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FEATURES } from "../../../packages/signing/src/index.ts";
import { resolvePlan } from "../src/plan.ts";
import { env, freshDatabase, resetWorld, seedRepo, world } from "./helpers.ts";

beforeEach(async () => {
  await freshDatabase();
  resetWorld();
});

afterEach(() => vi.restoreAllMocks());

const allButFleet = FEATURES.filter((f) => f !== "fleet");

describe("resolvePlan", () => {
  it("refuses a repo the App is not installed on", async () => {
    expect(await resolvePlan(env(), { repoId: 1001, visibility: "public" })).toEqual({ refused: "app-not-installed" });
  });

  it("gives a public repo the Public plan with every feature but fleet, and the row", async () => {
    await seedRepo();
    const res = await resolvePlan(env(), { repoId: 1001, visibility: "public" });
    expect(res).toMatchObject({ plan: "public", state: "ok", features: allButFleet, row: { repo_id: 1001, default_branch: "main", owner_type: "User" } });
  });

  it("takes visibility from the caller, never from the row", async () => {
    await seedRepo({ visibility: "public" });
    expect(await resolvePlan(env(), { repoId: 1001, visibility: "private" })).toEqual({ refused: "no-plan" });
    await seedRepo({ repo_id: 1002, visibility: "private" });
    expect(await resolvePlan(env(), { repoId: 1002, visibility: "public" })).toMatchObject({ plan: "public", state: "ok" });
  });

  it("refuses a private or internal repo with no-plan until the seats chunk", async () => {
    await seedRepo({ visibility: "private" });
    expect(await resolvePlan(env(), { repoId: 1001, visibility: "private" })).toEqual({ refused: "no-plan" });
    expect(await resolvePlan(env(), { repoId: 1001, visibility: "internal" })).toEqual({ refused: "no-plan" });
  });

  it("fails open with every feature, unverified, and logs d1-unreadable when D1 throws and FAIL_OPEN is true", async () => {
    const res = await resolvePlan(env({ brokenDb: true }), { repoId: 1001, visibility: "private" });
    expect(res).toEqual({ plan: "public", state: "unverified", features: [...FEATURES], row: null });
    expect(world.logs.some((l) => JSON.parse(l).marker === "d1-unreadable")).toBe(true);
  });

  it("refuses server-error when D1 throws and FAIL_OPEN is anything but true", async () => {
    for (const FAIL_OPEN of ["false", undefined, "TRUE"]) {
      expect(await resolvePlan(env({ brokenDb: true, FAIL_OPEN }), { repoId: 1001, visibility: "public" }), String(FAIL_OPEN)).toEqual({ refused: "server-error" });
    }
  });

  it("can be told the App is installed, as a webhook through an installation proves", async () => {
    expect(await resolvePlan(env(), { repoId: 1001, visibility: "public" }, { installed: true })).toMatchObject({ plan: "public", state: "ok", row: null });
    expect(await resolvePlan(env(), { repoId: 1001, visibility: "private" }, { installed: true })).toEqual({ refused: "no-plan" });
  });
});
