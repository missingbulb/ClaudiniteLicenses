// Plan resolution for the Actions path: the fleet the owner's subscriptions pay for, by the owner's
// type, or Public. Neither the repo's visibility nor any seat count is read.
import { fleetPlan, planFeatures, type OwnerType, type SubscriptionRow } from "../../../packages/licensing/src/index.ts";
import type { KeySeats, Plan } from "../../../packages/signing/src/index.ts";
import type { D1Reads } from "./db.ts";
import type { Path } from "./env.ts";
import { incident, type IncidentEnv } from "./incidents.ts";

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

export type Refusal = "server-error";

export interface Issued {
  plan: Plan;
  state: "ok";
  grace_until: null;
  features: string[];
  seats: KeySeats | null;
  notice: null;
  row: RepoRow;
  /** Whether the owner has any subscription row, paying or not: the portal has something to show. */
  subscribed: boolean;
}

export type Resolution = Issued | { refused: Refusal };

export interface PlanRequest {
  repoId: number;
  ownerId: number;
  ownerType: OwnerType;
}

/** Where the request came from, so an unreadable D1 is reported as an incident naming the path. */
export interface PlanContext {
  ctx?: ExecutionContext;
  path?: Path;
}

const REPO_SQL = "SELECT repo_id, owner_id, owner_type, owner_login, visibility, installation_id, full_name, default_branch FROM repos WHERE repo_id = ?";
const SUBSCRIPTIONS_SQL = "SELECT plan, status, ended_at FROM subscriptions WHERE owner_id = ?";

export async function readRepo(db: D1Reads, repoId: number): Promise<RepoRow | null> {
  return db.prepare(REPO_SQL).bind(repoId).first<RepoRow>();
}

/** The key for a repo whose row the caller already read and checked. It never fails open. */
export async function resolveForRow(env: IncidentEnv, db: D1Reads, req: PlanRequest, row: RepoRow, from: PlanContext = {}): Promise<Resolution> {
  try {
    const { results } = await db.prepare(SUBSCRIPTIONS_SQL).bind(req.ownerId).all<SubscriptionRow>();
    const plan: Plan = fleetPlan(req.ownerId, req.ownerType, results) ?? "public";
    return { plan, state: "ok", grace_until: null, features: planFeatures(plan), seats: null, notice: null, row, subscribed: results.length > 0 };
  } catch (err) {
    incident(env, from.ctx, "d1-unreadable", from.path, { repo_id: req.repoId, path: "actions", error: String(err) });
    return { refused: "server-error" };
  }
}
