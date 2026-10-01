// Plan resolution, shared by the web, desktop and Actions paths. Visibility is always the
// caller's, as GitHub reported it on that path, never the table's. This chunk knows the Public
// plan only: a private repo is refused until the seats chunk reads subscriptions here.
import { FEATURES, type Plan } from "../../../packages/signing/src/index.ts";

export interface RepoRow {
  repo_id: number;
  owner_id: number;
  owner_type: "User" | "Organization" | null;
  owner_login: string | null;
  visibility: string | null;
  installation_id: number | null;
  full_name: string | null;
  default_branch: string | null;
}

export type Refusal = "app-not-installed" | "no-plan" | "server-error";

export type Resolution =
  | { plan: Plan; state: "ok" | "unverified"; features: string[]; row: RepoRow | null }
  | { refused: Refusal };

export const PUBLIC_FEATURES: string[] = FEATURES.filter((f) => f !== "fleet");

export interface PlanEnv {
  DB: D1Database;
  FAIL_OPEN?: string;
}

export async function readRepo(db: D1Database, repoId: number): Promise<RepoRow | null> {
  return db
    .prepare("SELECT repo_id, owner_id, owner_type, owner_login, visibility, installation_id, full_name, default_branch FROM repos WHERE repo_id = ?")
    .bind(repoId)
    .first<RepoRow>();
}

/**
 * Resolves the plan for one repo. `installed` says the caller already proved the App covers the
 * repo (a webhook that came through its installation), so a row the sync Worker has not written
 * yet is not a refusal.
 */
export async function resolvePlan(env: PlanEnv, req: { repoId: number; visibility: string }, opts: { installed?: boolean } = {}): Promise<Resolution> {
  let row: RepoRow | null;
  try {
    row = await readRepo(env.DB, req.repoId);
  } catch (err) {
    // The design's third layer: issue rather than degrade, and leave a line the alerts can find.
    console.log(JSON.stringify({ marker: "d1-unreadable", repo_id: req.repoId, error: String(err) }));
    if (env.FAIL_OPEN === "true") return { plan: "public", state: "unverified", features: [...FEATURES], row: null };
    return { refused: "server-error" };
  }
  if (!row && !opts.installed) return { refused: "app-not-installed" };
  return planFor(row, req.visibility);
}

/** The plan for a repo the App covers, from its row and the caller's visibility. */
export function planFor(row: RepoRow | null, visibility: string): Resolution {
  if (visibility !== "public") return { refused: "no-plan" };
  return { plan: "public", state: "ok", features: [...PUBLIC_FEATURES], row };
}

export const REFUSAL_TEXT: Record<Refusal, string> = {
  "app-not-installed": "the Claudinite App is not installed on this repo",
  "no-plan": "this private repo has no plan yet; the Public plan covers public repos only",
  "server-error": "the license server could not read its database; try again shortly",
};
