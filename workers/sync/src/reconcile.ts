// The reconcile: re-reads every installation of the App and every repo it covers from GitHub,
// writes each row that differs, and deletes each row GitHub no longer lists. Nothing is written
// unless every listing was read, so a failure part way leaves the table as it was.
import { appJwt, githubCall, installationToken, type GitHubClient } from "../../../packages/github-app/src/index.ts";
import type { Env } from "./index.ts";
import { deleteRepo, ownerType, ROW_FIELDS, stamp, upsertRepo, visibilityOf, type RepoRow } from "./repos.ts";

const PER_PAGE = 100;

async function pages<T>(read: (page: number) => Promise<T[]>): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; ; page++) {
    const items = await read(page);
    all.push(...items);
    if (items.length < PER_PAGE) return all;
  }
}

interface ListedRepo {
  id: number;
  full_name: string;
  private?: boolean;
  visibility?: string;
  default_branch?: string;
  owner: { id: number; login: string; type: string };
}

export function githubClient(env: Env): GitHubClient {
  return { base: env.GITHUB_API_BASE ?? "https://api.github.com", userAgent: "claudinite-sync", appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY };
}

export async function reconcileInstallations(env: Env, nowS: number): Promise<{ repos: number; corrections: number }> {
  const gh = githubClient(env);
  const jwt = await appJwt(gh.appId, gh.privateKey, nowS);
  const installations = await pages(
    (page) => githubCall(gh, "GET", `/app/installations?per_page=${PER_PAGE}&page=${page}`, jwt, undefined, "installations") as Promise<{ id: number; suspended_at?: string | null }[]>,
  );
  const wanted = new Map<number, RepoRow>();
  for (const inst of installations) {
    // A suspended installation refuses a token; its repos are left out, so their rows go.
    if (inst.suspended_at) continue;
    const token = await installationToken(gh, inst.id, { permissions: { metadata: "read" } }, nowS);
    const repos = await pages(async (page) => {
      const answer = (await githubCall(gh, "GET", `/installation/repositories?per_page=${PER_PAGE}&page=${page}`, token, undefined, "installation repositories")) as { repositories: ListedRepo[] };
      return answer.repositories;
    });
    for (const r of repos) {
      wanted.set(r.id, {
        repo_id: r.id,
        owner_id: r.owner.id,
        owner_type: ownerType(r.owner.type),
        owner_login: r.owner.login,
        visibility: visibilityOf(r),
        installation_id: inst.id,
        full_name: r.full_name,
        default_branch: typeof r.default_branch === "string" ? r.default_branch : null,
      });
    }
  }

  const { results: held } = await env.DB.prepare(`SELECT repo_id, ${ROW_FIELDS.join(", ")} FROM repos`).all<RepoRow>();
  const heldById = new Map(held.map((r) => [r.repo_id, r]));
  const writes: D1PreparedStatement[] = [];
  for (const row of wanted.values()) {
    const have = heldById.get(row.repo_id);
    if (!have || ROW_FIELDS.some((f) => have[f] !== row[f])) writes.push(upsertRepo(env.DB, row, nowS));
  }
  for (const r of held) if (!wanted.has(r.repo_id)) writes.push(deleteRepo(env.DB, r.repo_id));
  const corrections = writes.length;
  writes.push(stamp(env.DB, "last_reconcile_corrections", nowS, String(corrections)), stamp(env.DB, "last_reconcile_at", nowS));
  await env.DB.batch(writes);
  return { repos: wanted.size, corrections };
}
