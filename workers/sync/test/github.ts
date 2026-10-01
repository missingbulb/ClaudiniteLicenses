import { applyD1Migrations, env as testEnv, type D1Migration } from "cloudflare:test";
import { vi } from "vitest";
import type { Env } from "../src/index.ts";

// A fetch spy standing in for GitHub: installation tokens, a repo read per full name, and the
// App's installations with their repositories, each list paged the way GitHub pages it. A
// suspended installation is listed with its suspended_at, and its token request answers 403.
export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  visibility?: string;
  default_branch: string;
  owner: { id: number; login: string; type: string };
}

export interface FakeGitHub {
  calls: string[];
  tokenBodies: unknown[];
  repoReadStatus: number;
  installations: { id: number; account: { id: number; login: string; type: string }; repos: GitHubRepo[]; suspended_at?: string | null }[];
}

export const env = testEnv as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };

export function repo(id: number, over: Partial<GitHubRepo> = {}): GitHubRepo {
  const owner = over.owner ?? { id: 2002, login: "acme-user", type: "User" };
  const name = over.name ?? `acme-repo-${id}`;
  return { id, name, full_name: `${owner.login}/${name}`, private: false, default_branch: "main", owner, ...over };
}

export async function freshDatabase(): Promise<void> {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.batch([env.DB.prepare("DELETE FROM repos"), env.DB.prepare("DELETE FROM sync_state")]);
}

export function fakeGitHub(): FakeGitHub {
  const gh: FakeGitHub = { calls: [], tokenBodies: [], repoReadStatus: 200, installations: [] };
  const page = <T>(items: T[], url: URL) => {
    const per = Number(url.searchParams.get("per_page") ?? 30);
    const n = Number(url.searchParams.get("page") ?? 1);
    return items.slice((n - 1) * per, n * per);
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    gh.calls.push(`${req.method} ${url.pathname}${url.search}`);
    let m: RegExpExecArray | null;
    if (req.method === "POST" && (m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname))) {
      gh.tokenBodies.push(await req.json());
      if (gh.installations.find((i) => i.id === Number(m![1]))?.suspended_at) return Response.json({ message: "This installation has been suspended" }, { status: 403 });
      return Response.json({ token: `ghs_inst_${m[1]}` }, { status: 201 });
    }
    if (req.method === "GET" && url.pathname === "/app/installations") {
      return Response.json(page(gh.installations.map((i) => ({ id: i.id, account: i.account, suspended_at: i.suspended_at ?? null })), url));
    }
    if (req.method === "GET" && url.pathname === "/installation/repositories") {
      const id = Number(/^Bearer ghs_inst_(\d+)$/.exec(req.headers.get("Authorization") ?? "")?.[1]);
      const repos = gh.installations.find((i) => i.id === id)?.repos ?? [];
      return Response.json({ total_count: repos.length, repositories: page(repos, url) });
    }
    if (req.method === "GET" && (m = /^\/repos\/([^/]+\/[^/]+)$/.exec(url.pathname))) {
      if (gh.repoReadStatus !== 200) return Response.json({ message: "stubbed failure" }, { status: gh.repoReadStatus });
      const found = gh.installations.flatMap((i) => i.repos).find((r) => r.full_name === m![1]);
      return found ? Response.json(found) : Response.json({ default_branch: "main", full_name: m[1] });
    }
    return new Response("unexpected", { status: 599 });
  });
  return gh;
}

export interface Row {
  repo_id: number;
  owner_id: number;
  owner_type: string | null;
  owner_login: string | null;
  visibility: string | null;
  installation_id: number | null;
  full_name: string | null;
  default_branch: string | null;
  updated_at: number;
}

export async function rows(): Promise<Row[]> {
  const { results } = await env.DB.prepare(
    "SELECT repo_id, owner_id, owner_type, owner_login, visibility, installation_id, full_name, default_branch, updated_at FROM repos ORDER BY repo_id",
  ).all<Row>();
  return results;
}

export async function seed(r: Omit<Row, "updated_at"> & { updated_at?: number }): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO repos (repo_id, owner_id, owner_type, owner_login, visibility, installation_id, full_name, default_branch, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(r.repo_id, r.owner_id, r.owner_type, r.owner_login, r.visibility, r.installation_id, r.full_name, r.default_branch, r.updated_at ?? 1)
    .run();
}
