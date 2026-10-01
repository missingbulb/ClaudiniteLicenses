import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { reconcileInstallations } from "../src/reconcile.ts";
import { env, fakeGitHub, freshDatabase, repo, rows, seed, type FakeGitHub } from "./github.ts";

const ACCOUNT = { id: 2002, login: "acme-user", type: "User" };
const ORG = { id: 8008, login: "acme-org", type: "Organization" };
let gh: FakeGitHub;

const fetchPath = (path: string, init?: RequestInit) => worker.fetch(new Request(`https://license.claudinite.com${path}`, init), env, createExecutionContext());

const healthy = () => fetchPath("/v1/sync/health").then((r) => r.json() as Promise<Record<string, unknown>>);

beforeEach(async () => {
  await freshDatabase();
  gh = fakeGitHub();
});

afterEach(() => vi.restoreAllMocks());

describe("reconcileInstallations", () => {
  it("adds a repo the App lists and the table lacks, deletes one it no longer lists, and leaves an identical row untouched", async () => {
    gh.installations = [{ id: 5005, account: ACCOUNT, repos: [repo(1), repo(2, { private: true, visibility: "private", default_branch: "trunk" })] }];
    await seed({ repo_id: 1, owner_id: 2002, owner_type: "User", owner_login: "acme-user", visibility: "public", installation_id: 5005, full_name: "acme-user/acme-repo-1", default_branch: "main", updated_at: 7 });
    await seed({ repo_id: 3, owner_id: 2002, owner_type: "User", owner_login: "acme-user", visibility: "public", installation_id: 5005, full_name: "acme-user/acme-repo-3", default_branch: "main" });
    const out = await reconcileInstallations(env, 1000);
    expect(out).toEqual({ repos: 2, corrections: 2 });
    const after = await rows();
    expect(after.map((r) => r.repo_id)).toEqual([1, 2]);
    expect(after[0]!.updated_at).toBe(7);
    expect(after[1]).toEqual({ repo_id: 2, owner_id: 2002, owner_type: "User", owner_login: "acme-user", visibility: "private", installation_id: 5005, full_name: "acme-user/acme-repo-2", default_branch: "trunk", updated_at: 1000 });
  });

  it("counts a changed row as one correction and pages both listings", async () => {
    const many = Array.from({ length: 130 }, (_, i) => repo(100 + i, { owner: ORG }));
    gh.installations = [
      ...Array.from({ length: 101 }, (_, i) => ({ id: 9000 + i, account: ORG, repos: [] })),
      { id: 6006, account: ORG, repos: many },
    ];
    await reconcileInstallations(env, 1000);
    expect((await rows()).length).toBe(130);
    expect(gh.calls).toContain("GET /app/installations?per_page=100&page=2");
    expect(gh.calls).toContain("GET /installation/repositories?per_page=100&page=2");
    gh.installations.at(-1)!.repos[5] = { ...many[5]!, default_branch: "trunk" };
    expect(await reconcileInstallations(env, 2000)).toEqual({ repos: 130, corrections: 1 });
    expect(await reconcileInstallations(env, 3000)).toEqual({ repos: 130, corrections: 0 });
  });

  it("asks each installation for a metadata: read token over the whole installation", async () => {
    gh.installations = [{ id: 5005, account: ACCOUNT, repos: [repo(1)] }];
    await reconcileInstallations(env, 1000);
    expect(gh.tokenBodies).toEqual([{ permissions: { metadata: "read" } }]);
  });

  it("skips a suspended installation, asking it for no token and deleting its rows, and reconciles the rest", async () => {
    gh.installations = [
      { id: 7007, account: ORG, repos: [repo(7, { owner: ORG })], suspended_at: "2026-09-30T12:00:00Z" },
      { id: 5005, account: ACCOUNT, repos: [repo(1)] },
    ];
    await seed({ repo_id: 7, owner_id: 8008, owner_type: "Organization", owner_login: "acme-org", visibility: "public", installation_id: 7007, full_name: "acme-org/acme-repo-7", default_branch: "main" });
    expect(await reconcileInstallations(env, 1000)).toEqual({ repos: 1, corrections: 2 });
    expect((await rows()).map((r) => r.repo_id)).toEqual([1]);
    expect(gh.calls.filter((c) => c.startsWith("POST"))).toEqual(["POST /app/installations/5005/access_tokens"]);
    expect((await healthy()).last_reconcile_at).toBe(1000);
  });

  it("writes and deletes nothing when a listing fails part way", async () => {
    gh.installations = [{ id: 5005, account: ACCOUNT, repos: [repo(1)] }];
    await seed({ repo_id: 3, owner_id: 2002, owner_type: "User", owner_login: "acme-user", visibility: "public", installation_id: 5005, full_name: "acme-user/acme-repo-3", default_branch: "main" });
    vi.mocked(globalThis.fetch).mockImplementation(async () => Response.json({ message: "boom" }, { status: 500 }));
    await expect(reconcileInstallations(env, 1000)).rejects.toThrow(/500/);
    expect((await rows()).map((r) => r.repo_id)).toEqual([3]);
    expect((await healthy()).last_reconcile_at).toBeNull();
  });
});

describe("scheduled", () => {
  it("runs the reconcile and stamps last_reconcile_at", async () => {
    gh.installations = [{ id: 5005, account: ACCOUNT, repos: [repo(1)] }];
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: new Date(1_790_000_000_000), cron: "17 3 * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect((await rows()).map((r) => r.repo_id)).toEqual([1]);
    expect(await healthy()).toMatchObject({ repos: 1, last_reconcile_at: 1_790_000_000, last_reconcile_corrections: 1 });
  });
});

describe("scheduled, when GitHub fails", () => {
  it("logs reconcile: failed rather than leaving the rejection unhandled", async () => {
    gh.installations = [{ id: 5005, account: ACCOUNT, repos: [repo(1)] }];
    vi.mocked(globalThis.fetch).mockImplementation(async () => Response.json({ message: "boom" }, { status: 500 }));
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.join(" ")));
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: new Date(1_790_000_000_000), cron: "17 3 * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(errors.some((e) => e.includes('"reconcile":"failed"'))).toBe(true);
    expect((await healthy()).last_reconcile_at).toBeNull();
  });
});

describe("POST /v1/sync/reconcile", () => {
  it("refuses a wrong or missing bearer with 401 and calls nothing", async () => {
    gh.installations = [{ id: 5005, account: ACCOUNT, repos: [repo(1)] }];
    for (const headers of [{ Authorization: "Bearer wrong" }, {} as Record<string, string>, { Authorization: "acme-admin-token" }]) {
      expect((await fetchPath("/v1/sync/reconcile", { method: "POST", headers })).status).toBe(401);
    }
    expect(gh.calls).toEqual([]);
  });

  it("with the admin token runs the reconcile, as the cron does", async () => {
    gh.installations = [{ id: 5005, account: ACCOUNT, repos: [repo(1), repo(2)] }];
    const res = await fetchPath("/v1/sync/reconcile", { method: "POST", headers: { Authorization: "Bearer acme-admin-token" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, repos: 2, corrections: 2 });
    expect((await rows()).map((r) => r.repo_id)).toEqual([1, 2]);
  });

  it("answers 502 when GitHub fails, so a deploy's read-back sees it", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async () => Response.json({ message: "boom" }, { status: 500 }));
    const res = await fetchPath("/v1/sync/reconcile", { method: "POST", headers: { Authorization: "Bearer acme-admin-token" } });
    expect(res.status).toBe(502);
  });
});

describe("GET /v1/sync/health", () => {
  it("reads back nulls on a fresh database", async () => {
    const res = await fetchPath("/v1/sync/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, repos: 0, last_webhook_at: null, last_reconcile_at: null, last_reconcile_corrections: null });
  });

  it("reads back the stamps after a webhook and a reconcile", async () => {
    gh.installations = [{ id: 5005, account: ACCOUNT, repos: [repo(1), repo(2)] }];
    const r = repo(1);
    await worker.fetch(
      new Request("https://sync/webhook", {
        method: "POST",
        headers: { "X-GitHub-Event": "installation_repositories" },
        body: JSON.stringify({ action: "added", installation: { id: 5005, account: ACCOUNT }, repositories_added: [{ id: r.id, name: r.name, full_name: r.full_name, private: false }], repositories_removed: [] }),
      }),
      env,
      createExecutionContext(),
    );
    await fetchPath("/v1/sync/reconcile", { method: "POST", headers: { Authorization: "Bearer acme-admin-token" } });
    const body = await healthy();
    expect(body).toMatchObject({ ok: true, repos: 2, last_reconcile_corrections: 1 });
    expect(typeof body.last_webhook_at).toBe("number");
    expect(typeof body.last_reconcile_at).toBe("number");
  });
});

it("answers 404 off its routes", async () => {
  expect((await fetchPath("/v1/sync/other")).status).toBe(404);
  expect((await fetchPath("/webhook")).status).toBe(404);
});
