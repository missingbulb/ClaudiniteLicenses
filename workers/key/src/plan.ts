// Plan resolution, shared by the web, desktop and Actions paths. Visibility is always the
// caller's, as GitHub reported it on that path, never the table's. The plan comes from the owner's
// subscriptions; a private repo's state, notice and queued writes from the seat rules.
import { dayOf, licenseeOf, paidSeats, planFeatures, type Notice, type PaidPlan, type SubscriptionRow, type WriteMessage } from "../../../packages/licensing/src/index.ts";
import { FEATURES, type KeySeats, type Plan } from "../../../packages/signing/src/index.ts";
import type { D1Reads } from "./db.ts";
import { failOpenEnabled, type Path } from "./env.ts";
import { incident, type IncidentEnv } from "./incidents.ts";
import { readLicensee, verdictFor } from "./seats.ts";

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

export type Refusal = "app-not-installed" | "server-error";

export interface Issued {
  plan: Plan;
  state: "ok" | "grace" | "degraded" | "unverified";
  grace_until: number | null;
  features: string[];
  seats: KeySeats | null;
  notice: Notice | null;
  /** What the sync Worker is asked to write, in order. */
  writes: WriteMessage[];
  row: RepoRow | null;
  /** Whether the owner has any subscription row, paying or not: the portal has something to show. */
  subscribed: boolean;
}

export type Resolution = Issued | { refused: Refusal };

export interface PlanRequest {
  repoId: number;
  visibility: string;
  ownerId: number;
  /** The key's user; null on an Actions key, which has none. */
  userId: number | null;
  typ: "session" | "actions";
}

export interface PlanEnv extends IncidentEnv {
  FAIL_OPEN?: string;
}

/** Where the request came from, so an unreadable D1 is reported as an incident naming the path. */
export interface PlanContext {
  ctx?: ExecutionContext;
  path?: Path;
}

const REPO_SQL = "SELECT repo_id, owner_id, owner_type, owner_login, visibility, installation_id, full_name, default_branch FROM repos WHERE repo_id = ?";
const SUBSCRIPTIONS_SQL = "SELECT plan, seats, repo_ids, status, ended_at FROM subscriptions WHERE owner_id = ?";

export async function readRepo(db: D1Reads, repoId: number): Promise<RepoRow | null> {
  return db.prepare(REPO_SQL).bind(repoId).first<RepoRow>();
}

/** The owner-wide plans, the one a repo takes first when the owner pays for several. */
const OWNER_WIDE: PaidPlan[] = ["internal", "organization", "personal"];

function choosePlan(subs: SubscriptionRow[], req: PlanRequest, now: number): { plan: Plan; paid: number } {
  for (const plan of OWNER_WIDE) {
    const paid = paidSeats(subs, now, { plan, repoId: req.repoId });
    if (paid > 0) return { plan, paid };
  }
  if (req.visibility === "public") return { plan: "public", paid: 0 };
  return { plan: "private-repo", paid: paidSeats(subs, now, { plan: "private-repo", repoId: req.repoId }) };
}

function usageMessage(req: PlanRequest & { userId: number }, plan: PaidPlan, now: number): WriteMessage {
  return { v: 1, kind: "usage", at: now, repo_id: req.repoId, user_id: req.userId, owner_id: req.ownerId, plan, day: dayOf(now) };
}

async function decide(db: D1Reads, req: PlanRequest, row: RepoRow | null, subs: SubscriptionRow[], now: number): Promise<Issued> {
  const subscribed = subs.length > 0;
  const { plan, paid } = choosePlan(subs, req, now);
  // A public repo's users take no seat, whatever plan covers it: no seat read, no write.
  if (req.visibility === "public") return { plan, state: "ok", grace_until: null, features: planFeatures(plan), seats: null, notice: null, writes: [], row, subscribed };

  const paidPlan = plan as PaidPlan;
  const licensee = licenseeOf(paidPlan, req.ownerId, req.repoId);
  const userId = req.typ === "session" ? req.userId : null;
  const reads = await readLicensee(db, { licensee, ownerId: req.ownerId, repoId: req.repoId, userId, now });
  const v = verdictFor(paidPlan, paid, reads, userId, now);
  const writes: WriteMessage[] = [];
  if (userId !== null) {
    // A plan change moves the licensee within a day, so a usage row alone does not prove the seat.
    const seatedHere = reads.seatRows.some((r) => r.user_id === userId);
    if (!reads.usedToday || !seatedHere) writes.push(usageMessage({ ...req, userId }, paidPlan, now));
    for (const kind of v.writes) writes.push({ v: 1, kind, at: now, owner_id: req.ownerId });
  }
  return { plan, state: v.state, grace_until: v.graceUntil, features: v.features, seats: { paid, counted: v.counted, headroom: v.headroom }, notice: v.notice, writes, row, subscribed };
}

function failOpen(env: PlanEnv, req: PlanRequest, err: unknown, now: number, from: PlanContext): Resolution {
  // The design's third layer: issue rather than degrade, and leave an incident the alerts count.
  incident(env, from.ctx, "d1-unreadable", from.path, { repo_id: req.repoId, error: String(err) });
  if (!failOpenEnabled(env)) return { refused: "server-error" };
  // The binary refuses a Public key on a private repo, so a private repo fails open on Private repo.
  const isPublic = req.visibility === "public";
  const writes = !isPublic && req.typ === "session" && req.userId !== null ? [usageMessage({ ...req, userId: req.userId }, "private-repo", now)] : [];
  return { plan: isPublic ? "public" : "private-repo", state: "unverified", grace_until: null, features: [...FEATURES], seats: null, notice: null, writes, row: null, subscribed: false };
}

/**
 * Resolves the key for one repo. `installed` says the caller already proved the App covers the
 * repo (a webhook that came through its installation), so a row the sync Worker has not written
 * yet is not a refusal. `db` is the request's one session (`reader`).
 */
export async function resolvePlan(env: PlanEnv, db: D1Reads, req: PlanRequest, opts: { installed?: boolean } & PlanContext = {}): Promise<Resolution> {
  const now = Math.floor(Date.now() / 1000);
  try {
    const [repo, subs] = await db.batch([db.prepare(REPO_SQL).bind(req.repoId), db.prepare(SUBSCRIPTIONS_SQL).bind(req.ownerId)]);
    const row = ((repo?.results ?? [])[0] as RepoRow | undefined) ?? null;
    if (!row && !opts.installed) return { refused: "app-not-installed" };
    return await decide(db, req, row, (subs?.results ?? []) as unknown as SubscriptionRow[], now);
  } catch (err) {
    return failOpen(env, req, err, now, opts);
  }
}

/** The key for a repo whose row the caller already read and checked, as the Actions path does. It never fails open. */
export async function resolveForRow(env: PlanEnv, db: D1Reads, req: PlanRequest, row: RepoRow, from: PlanContext = {}): Promise<Resolution> {
  const now = Math.floor(Date.now() / 1000);
  try {
    const { results } = await db.prepare(SUBSCRIPTIONS_SQL).bind(req.ownerId).all<SubscriptionRow>();
    return await decide(db, req, row, results, now);
  } catch (err) {
    incident(env, from.ctx, "d1-unreadable", from.path, { repo_id: req.repoId, path: req.typ, error: String(err) });
    return { refused: "server-error" };
  }
}

export const REFUSAL_TEXT: Record<Refusal, string> = {
  "app-not-installed": "the Claudinite App is not installed on this repo",
  "server-error": "the license server could not read its database; try again shortly",
};
