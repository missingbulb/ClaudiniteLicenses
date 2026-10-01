import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auditCoverage } from "../src/coverage.ts";
import worker from "../src/index.ts";
import { env, fakeGitHub, freshDatabase, repo, type FakeGitHub } from "./github.ts";
import { fakePolar, type FakePolar } from "./polar.ts";

const T = 1_790_000_000;
let logs: string[];

async function seedRepo(repoId: number, ownerId: number) {
  await env.DB.prepare("INSERT INTO repos (repo_id, owner_id, owner_type, owner_login, visibility, installation_id, full_name, default_branch, updated_at) VALUES (?, ?, 'User', 'acme-user', 'private', 5005, ?, 'main', 1)")
    .bind(repoId, ownerId, `acme-user/acme-repo-${repoId}`)
    .run();
}

async function seedSubscription(id: string, over: Partial<{ owner_id: number; plan: string; repo_ids: string | null; status: string; ended_at: number | null }> = {}) {
  const r = { owner_id: 2002, plan: "personal", repo_ids: null, status: "active", ended_at: null, ...over };
  await env.DB.prepare("INSERT INTO subscriptions (polar_subscription_id, owner_id, owner_type, plan, seats, repo_ids, source, modified_at, raw, status, ended_at) VALUES (?, ?, 'User', ?, 3, ?, 'polar', 1, '{}', ?, ?)")
    .bind(id, r.owner_id, r.plan, r.repo_ids, r.status, r.ended_at)
    .run();
}

const stamp = () => env.DB.prepare("SELECT at, detail FROM sync_state WHERE name = 'paying_uncovered'").first<{ at: number; detail: string }>();
const uncoveredLines = () => logs.filter((l) => l.includes('"marker":"paying-uncovered"')).map((l) => JSON.parse(l));

beforeEach(async () => {
  await freshDatabase();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
});

afterEach(() => vi.restoreAllMocks());

describe("auditCoverage", () => {
  it("counts a Private repo row naming a repo with no row and a Personal row whose owner has none, and ignores a revoked and a covered row", async () => {
    await seedRepo(1001, 2002);
    await seedSubscription("sub_covered_repo", { plan: "private-repo", repo_ids: "[1001]" });
    await seedSubscription("sub_uncovered_repo", { plan: "private-repo", repo_ids: "[1001, 4040]" });
    await seedSubscription("sub_covered_owner", { plan: "personal" });
    await seedSubscription("sub_uncovered_owner", { owner_id: 7007, plan: "organization" });
    await seedSubscription("sub_revoked", { owner_id: 8008, plan: "personal", status: "canceled", ended_at: T - 1 });
    await seedSubscription("sub_incomplete", { owner_id: 8009, plan: "personal", status: "incomplete" });
    expect(await auditCoverage(env.DB, T)).toBe(2);
    expect(await stamp()).toEqual({ at: T, detail: "2" });
    expect(uncoveredLines()).toEqual([
      { marker: "paying-uncovered", owner_id: 2002, plan: "private-repo", repo_ids: [4040] },
      { marker: "paying-uncovered", owner_id: 7007, plan: "organization", repo_ids: [] },
    ]);
  });

  it("counts a past_due and a trialing row as paying, and an internal row by its owner", async () => {
    await seedSubscription("sub_late", { owner_id: 1, plan: "personal", status: "past_due" });
    await seedSubscription("sub_trial", { owner_id: 2, plan: "internal", status: "trialing" });
    expect(await auditCoverage(env.DB, T)).toBe(2);
  });

  it("stamps zero when every paying account is covered, and nothing logged", async () => {
    await seedRepo(1001, 2002);
    await seedSubscription("sub_a", { plan: "private-repo", repo_ids: "[1001]" });
    expect(await auditCoverage(env.DB, T)).toBe(0);
    expect(await stamp()).toEqual({ at: T, detail: "0" });
    expect(uncoveredLines()).toEqual([]);
  });
});

describe("where the audit runs", () => {
  let gh: FakeGitHub;
  let polar: FakePolar;
  const health = async () => (await (await worker.fetch(new Request("https://license.claudinite.com/v1/sync/health"), env, createExecutionContext())).json()) as Record<string, unknown>;
  const admin = { method: "POST", headers: { Authorization: "Bearer acme-admin-token" } };

  beforeEach(() => {
    gh = fakeGitHub();
    polar = fakePolar();
  });

  it("reads paying_uncovered back as null until audited", async () => {
    expect((await health()).paying_uncovered).toBeNull();
  });

  it("re-judges at the end of POST /v1/sync/reconcile, so a repo leaving the App shows at once and its return clears it", async () => {
    await seedSubscription("sub_repo", { plan: "private-repo", repo_ids: "[1]" });
    gh.installations = [{ id: 5005, account: { id: 2002, login: "acme-user", type: "User" }, repos: [repo(1)] }];
    expect((await worker.fetch(new Request("https://license.claudinite.com/v1/sync/reconcile", admin), env, createExecutionContext())).status).toBe(200);
    expect((await health()).paying_uncovered).toBe(0);
    gh.installations[0]!.repos = [];
    await worker.fetch(new Request("https://license.claudinite.com/v1/sync/reconcile", admin), env, createExecutionContext());
    expect((await health()).paying_uncovered).toBe(1);
  });

  it("re-judges at the end of POST /v1/sync/polar-reconcile", async () => {
    polar.subscriptions = [];
    await seedSubscription("sub_owner", { owner_id: 7007, plan: "personal" });
    expect((await worker.fetch(new Request("https://license.claudinite.com/v1/sync/polar-reconcile", admin), env, createExecutionContext())).status).toBe(200);
    expect((await health()).paying_uncovered).toBe(1);
  });

  it("runs at the end of the nightly cron, after both reconciles", async () => {
    await seedSubscription("sub_owner", { owner_id: 7007, plan: "personal" });
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: new Date(T * 1000), cron: "17 3 * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await stamp()).toEqual({ at: T, detail: "1" });
  });
});
