// The repos table and the sync stamps, and the installation and repository webhooks that write
// them. Writes are last-write-wins; the reconcile repairs whatever order a webhook burst left.
import { GitHubError, githubCall, installationToken, type GitHubClient } from "../../../packages/github-app/src/index.ts";

export interface RepoRow {
  repo_id: number;
  owner_id: number;
  owner_type: "User" | "Organization" | null;
  owner_login: string;
  visibility: "public" | "private" | "internal";
  installation_id: number;
  full_name: string;
  default_branch: string | null;
}

/** The columns the sync Worker owns, in the order the reconcile compares them. */
export const ROW_FIELDS = ["owner_id", "owner_type", "owner_login", "visibility", "installation_id", "full_name", "default_branch"] as const;

export type StampName =
  | "last_webhook_at"
  | "last_reconcile_at"
  | "last_reconcile_corrections"
  | "last_polar_webhook_at"
  | "last_polar_reconcile_at"
  | "last_polar_reconcile_corrections"
  | "last_polar_reconcile_error"
  | "last_queue_at"
  | "last_queue_version"
  | "queue_lag_s"
  | "last_cron_at"
  | "last_cron_version"
  | "last_dead_letter_at"
  | "paying_uncovered";

export function upsertRepo(db: D1Database, r: RepoRow, nowS: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO repos (repo_id, owner_id, owner_type, owner_login, visibility, installation_id, full_name, default_branch, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (repo_id) DO UPDATE SET
         owner_id = excluded.owner_id, owner_type = excluded.owner_type, owner_login = excluded.owner_login,
         visibility = excluded.visibility, installation_id = excluded.installation_id, full_name = excluded.full_name,
         default_branch = COALESCE(excluded.default_branch, repos.default_branch), updated_at = excluded.updated_at`,
    )
    .bind(r.repo_id, r.owner_id, r.owner_type, r.owner_login, r.visibility, r.installation_id, r.full_name, r.default_branch, nowS);
}

export function deleteRepo(db: D1Database, repoId: number): D1PreparedStatement {
  return db.prepare("DELETE FROM repos WHERE repo_id = ?").bind(repoId);
}

export function stamp(db: D1Database, name: StampName, at: number, detail: string | null = null): D1PreparedStatement {
  return db.prepare("INSERT INTO sync_state (name, at, detail) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET at = excluded.at, detail = excluded.detail").bind(name, at, detail);
}

export function ownerType(t: unknown): RepoRow["owner_type"] {
  return t === "User" || t === "Organization" ? t : null;
}

export function visibilityOf(r: { private?: unknown; visibility?: unknown }): RepoRow["visibility"] {
  if (r.visibility === "internal") return "internal";
  return r.private === true ? "private" : "public";
}

interface Account {
  id?: unknown;
  login?: unknown;
  type?: unknown;
}

interface ListedRepo {
  id?: unknown;
  name?: unknown;
  full_name?: unknown;
  private?: unknown;
  visibility?: unknown;
  default_branch?: unknown;
  owner?: Account;
}

interface Payload {
  action?: unknown;
  installation?: { id?: unknown; account?: Account };
  repositories?: ListedRepo[];
  repositories_added?: ListedRepo[];
  repositories_removed?: ListedRepo[];
  repository?: ListedRepo;
  changes?: { default_branch?: unknown };
}

const isListed = (r: ListedRepo): r is ListedRepo & { id: number; name: string; full_name: string } =>
  typeof r.id === "number" && typeof r.name === "string" && typeof r.full_name === "string";

/**
 * Reads each repo's default branch with one installation token holding metadata: read on exactly
 * those repos. A GitHub error leaves every branch unknown (null) and is returned beside them.
 */
async function readDefaultBranches(gh: GitHubClient, installationId: number, repos: { name: string; full_name: string }[], nowS: number) {
  const branches = new Map<string, string>();
  try {
    const token = await installationToken(gh, installationId, { repositories: repos.map((r) => r.name), permissions: { metadata: "read" } }, nowS);
    for (const r of repos) {
      const answer = (await githubCall(gh, "GET", `/repos/${r.full_name}`, token, undefined, "repo read")) as { default_branch?: unknown };
      if (typeof answer.default_branch === "string") branches.set(r.full_name, answer.default_branch);
    }
    return { branches, error: null };
  } catch (err) {
    if (!(err instanceof GitHubError)) throw err;
    return { branches: new Map<string, string>(), error: err };
  }
}

export interface WebhookEnv {
  DB: D1Database;
}

/** Applies one installation, installation_repositories or repository webhook to repos. */
export async function applyWebhook(env: WebhookEnv, gh: GitHubClient, event: string, p: Payload, nowS: number, delivery: string | null): Promise<Response> {
  const db = env.DB;
  const installationId = p.installation?.id;
  const account = p.installation?.account;
  const writes: D1PreparedStatement[] = [];
  let githubError: GitHubError | null = null;

  const upsertListed = async (listed: ListedRepo[]) => {
    if (typeof installationId !== "number" || typeof account?.id !== "number" || typeof account.login !== "string") return false;
    const repos = listed.filter(isListed);
    if (repos.length === 0) return true;
    const read = await readDefaultBranches(gh, installationId, repos, nowS);
    githubError = read.error;
    for (const r of repos) {
      writes.push(
        upsertRepo(
          db,
          {
            repo_id: r.id,
            owner_id: account.id,
            owner_type: ownerType(account.type),
            owner_login: account.login,
            visibility: visibilityOf(r),
            installation_id: installationId,
            full_name: r.full_name,
            default_branch: read.branches.get(r.full_name) ?? null,
          },
          nowS,
        ),
      );
    }
    return true;
  };

  const action = p.action;
  const repo = p.repository;
  let handled = true;
  if (event === "installation" && (action === "created" || action === "unsuspend" || action === "new_permissions_accepted")) {
    handled = await upsertListed(p.repositories ?? []);
  } else if (event === "installation" && (action === "deleted" || action === "suspend")) {
    if (typeof installationId !== "number") handled = false;
    else writes.push(db.prepare("DELETE FROM repos WHERE installation_id = ?").bind(installationId));
  } else if (event === "installation_repositories" && action === "added") {
    handled = await upsertListed(p.repositories_added ?? []);
  } else if (event === "installation_repositories" && action === "removed") {
    for (const r of p.repositories_removed ?? []) if (typeof r.id === "number") writes.push(deleteRepo(db, r.id));
  } else if (event === "repository" && typeof repo?.id === "number") {
    if (action === "publicized" || action === "privatized") {
      writes.push(db.prepare("UPDATE repos SET visibility = ?, updated_at = ? WHERE repo_id = ?").bind(visibilityOf(repo), nowS, repo.id));
    } else if ((action === "renamed" || action === "transferred") && typeof repo.full_name === "string" && typeof repo.owner?.id === "number" && typeof repo.owner.login === "string") {
      writes.push(
        db
          .prepare("UPDATE repos SET owner_id = ?, owner_type = ?, owner_login = ?, full_name = ?, updated_at = ? WHERE repo_id = ?")
          .bind(repo.owner.id, ownerType(repo.owner.type), repo.owner.login, repo.full_name, nowS, repo.id),
      );
    } else if (action === "edited" && p.changes?.default_branch !== undefined && typeof repo.default_branch === "string") {
      writes.push(db.prepare("UPDATE repos SET default_branch = ?, updated_at = ? WHERE repo_id = ?").bind(repo.default_branch, nowS, repo.id));
    } else if (action === "deleted") {
      writes.push(deleteRepo(db, repo.id));
    } else {
      return new Response(null, { status: 204 });
    }
  } else {
    return new Response(null, { status: 204 });
  }
  if (!handled) {
    console.log(JSON.stringify({ refused: "malformed-payload", event, action, delivery }));
    return new Response("malformed-payload", { status: 400 });
  }

  if (githubError) {
    const err = githubError as GitHubError;
    if (writes.length > 0) await db.batch(writes);
    console.error(JSON.stringify({ githubError: err.call, status: err.status, delivery, event, action }));
    // GitHub never redelivers on its own; the 202 marks the delivery in the App's log and the reconcile fills the branch.
    return new Response(`written without default branch; ${err.call} answered ${err.status}`, { status: 202 });
  }
  writes.push(stamp(db, "last_webhook_at", nowS));
  await db.batch(writes);
  return new Response(`${event}/${action}: ${writes.length - 1} write(s)`, { status: 200 });
}
