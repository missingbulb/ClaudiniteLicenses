import { createExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { env, fakeGitHub, freshDatabase, repo, rows, seed, signGitHub, type FakeGitHub, type Row } from "./github.ts";

const ACCOUNT = { id: 2002, login: "acme-user", type: "User" };
let gh: FakeGitHub;

async function deliver(event: string, payload: unknown): Promise<Response> {
  const body = JSON.stringify(payload);
  const req = new Request("https://license.claudinite.com/github-webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-GitHub-Event": event, "X-GitHub-Delivery": "acme-delivery", "X-Hub-Signature-256": await signGitHub(body) },
    body,
  });
  return worker.fetch(req, env, createExecutionContext());
}

// What an installation event carries per repository: no owner, no default branch.
const listed = (id: number, over: { private?: boolean; visibility?: string } = {}) => {
  const r = repo(id);
  return { id: r.id, name: r.name, full_name: r.full_name, private: over.private ?? false, ...(over.visibility ? { visibility: over.visibility } : {}) };
};

const row = (id: number, over: Partial<Row> = {}): Omit<Row, "updated_at"> => ({
  repo_id: id,
  owner_id: 2002,
  owner_type: "User",
  owner_login: "acme-user",
  visibility: "public",
  installation_id: 5005,
  full_name: `acme-user/acme-repo-${id}`,
  default_branch: "main",
  ...over,
});

const withoutTime = (rs: Row[]) => rs.map(({ updated_at: _t, ...r }) => r);

async function stamp(name: string) {
  return env.DB.prepare("SELECT at FROM sync_state WHERE name = ?").bind(name).first<{ at: number }>();
}

beforeEach(async () => {
  await freshDatabase();
  gh = fakeGitHub();
  gh.installations = [{ id: 5005, account: ACCOUNT, repos: [repo(1, { default_branch: "trunk" }), repo(2)] }];
});

afterEach(() => vi.restoreAllMocks());

describe("installation", () => {
  for (const action of ["created", "unsuspend", "new_permissions_accepted"]) {
    it(`${action} upserts one complete row per listed repo, the default branch read from GitHub`, async () => {
      const res = await deliver("installation", { action, installation: { id: 5005, account: ACCOUNT }, repositories: [listed(1), listed(2, { private: true })] });
      expect(res.status).toBe(200);
      expect(withoutTime(await rows())).toEqual([row(1, { default_branch: "trunk" }), row(2, { visibility: "private" })]);
      expect(gh.tokenBodies).toEqual([{ repositories: ["acme-repo-1", "acme-repo-2"], permissions: { metadata: "read" } }]);
      expect(gh.calls.filter((c) => c.startsWith("GET"))).toEqual(["GET /repos/acme-user/acme-repo-1", "GET /repos/acme-user/acme-repo-2"]);
      expect(await stamp("last_webhook_at")).not.toBeNull();
    });
  }

  it("records internal only when the payload says so", async () => {
    await deliver("installation", { action: "created", installation: { id: 5005, account: ACCOUNT }, repositories: [listed(1, { private: true, visibility: "internal" })] });
    expect((await rows())[0]!.visibility).toBe("internal");
  });

  for (const action of ["deleted", "suspend"]) {
    it(`${action} removes that installation's rows and only those`, async () => {
      await seed(row(1));
      await seed(row(2));
      await seed(row(3, { installation_id: 6006, owner_id: 7007 }));
      const res = await deliver("installation", { action, installation: { id: 5005, account: ACCOUNT } });
      expect(res.status).toBe(200);
      expect((await rows()).map((r) => r.repo_id)).toEqual([3]);
      expect(gh.calls).toEqual([]);
    });
  }
});

describe("installation_repositories", () => {
  it("added writes a complete row for a repo never seen before any installation event", async () => {
    const res = await deliver("installation_repositories", { action: "added", installation: { id: 5005, account: ACCOUNT }, repositories_added: [listed(1)], repositories_removed: [] });
    expect(res.status).toBe(200);
    const [r] = await rows();
    expect(withoutTime([r!])).toEqual([row(1, { default_branch: "trunk" })]);
    expect(Object.values(r!).every((v) => v !== null)).toBe(true);
  });

  it("removed deletes the removed repos", async () => {
    await seed(row(1));
    await seed(row(2));
    const res = await deliver("installation_repositories", { action: "removed", installation: { id: 5005, account: ACCOUNT }, repositories_added: [], repositories_removed: [listed(2)] });
    expect(res.status).toBe(200);
    expect((await rows()).map((r) => r.repo_id)).toEqual([1]);
  });
});

describe("repository", () => {
  const repoPayload = (action: string, over: Record<string, unknown> = {}) => ({
    action,
    installation: { id: 5005 },
    repository: { ...repo(1), ...over },
  });

  it("publicized and privatized set the visibility", async () => {
    await seed(row(1));
    await deliver("repository", repoPayload("privatized", { private: true, visibility: "private" }));
    expect((await rows())[0]!.visibility).toBe("private");
    await deliver("repository", repoPayload("publicized", { private: false, visibility: "public" }));
    expect((await rows())[0]!.visibility).toBe("public");
  });

  it("renamed and transferred set the owner and full name from the repository", async () => {
    await seed(row(1));
    await deliver("repository", repoPayload("renamed", { name: "acme-renamed", full_name: "acme-user/acme-renamed" }));
    expect((await rows())[0]).toMatchObject({ full_name: "acme-user/acme-renamed", owner_login: "acme-user" });
    const org = { id: 8008, login: "acme-org", type: "Organization" };
    await deliver("repository", repoPayload("transferred", { full_name: "acme-org/acme-renamed", owner: org }));
    expect((await rows())[0]).toMatchObject({ full_name: "acme-org/acme-renamed", owner_id: 8008, owner_type: "Organization", owner_login: "acme-org" });
  });

  it("edited with a default branch change sets the default branch", async () => {
    await seed(row(1));
    await deliver("repository", { ...repoPayload("edited", { default_branch: "trunk" }), changes: { default_branch: { from: "main" } } });
    expect((await rows())[0]!.default_branch).toBe("trunk");
  });

  it("deleted removes the row", async () => {
    await seed(row(1));
    await seed(row(2));
    await deliver("repository", repoPayload("deleted"));
    expect((await rows()).map((r) => r.repo_id)).toEqual([2]);
  });
});

describe("everything else", () => {
  it("answers 204 and writes nothing", async () => {
    await seed(row(1));
    const before = await rows();
    for (const [event, payload] of [
      ["installation", { action: "new_thing", installation: { id: 5005, account: ACCOUNT } }],
      ["repository", { action: "archived", installation: { id: 5005 }, repository: repo(1) }],
      ["repository", { action: "edited", installation: { id: 5005 }, repository: repo(1), changes: { description: { from: "x" } } }],
      ["push", { ref: "refs/heads/main" }],
    ] as const) {
      expect((await deliver(event, payload)).status, `${event} ${JSON.stringify(payload)}`).toBe(204);
    }
    expect(await rows()).toEqual(before);
    expect(await stamp("last_webhook_at")).toBeNull();
  });

  it("refuses a malformed payload with 400", async () => {
    const res = await worker.fetch(new Request("https://license.claudinite.com/github-webhook", { method: "POST", headers: { "X-GitHub-Event": "installation", "X-Hub-Signature-256": await signGitHub("{") }, body: "{" }), env, createExecutionContext());
    expect(res.status).toBe(400);
  });
});

describe("a GitHub error reading the default branch", () => {
  it("still writes the row with a null default branch and answers 202, leaving the branch to the reconcile", async () => {
    gh.repoReadStatus = 500;
    const res = await deliver("installation_repositories", { action: "added", installation: { id: 5005, account: ACCOUNT }, repositories_added: [listed(1)], repositories_removed: [] });
    expect(res.status).toBe(202);
    expect(withoutTime(await rows())).toEqual([row(1, { default_branch: null })]);
  });

  it("keeps a default branch already known rather than nulling it", async () => {
    await seed(row(1, { default_branch: "trunk" }));
    gh.repoReadStatus = 500;
    await deliver("installation_repositories", { action: "added", installation: { id: 5005, account: ACCOUNT }, repositories_added: [listed(1)], repositories_removed: [] });
    expect((await rows())[0]!.default_branch).toBe("trunk");
  });
});
