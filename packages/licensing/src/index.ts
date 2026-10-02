// The license design's seat rules ("Seats and overuse" 1-5, headroom, grace) as pure functions, and
// the write messages the key Worker queues for the sync Worker. Both Workers bundle this package, so
// the key Worker's verdict and the sync Worker's writes agree. No I/O: callers pass the rows.
import { FEATURES, type Plan } from "../../signing/src/index.ts";

export const DAY_S = 86_400;
/** A seat lapses this long after its user's last key. */
export const SEAT_WINDOW_S = 30 * DAY_S;
/** How long grace lasts from its start. */
export const GRACE_S = 7 * DAY_S;
/** No new grace starts until this long after the last one started. */
export const GRACE_SPENT_S = 30 * DAY_S;

export type PaidPlan = Exclude<Plan, "public">;
export type SeatState = "ok" | "grace" | "degraded";
export type Notice = "over-within-headroom" | "overused" | "seat-refused";
export type SeatWrite = "grace-start" | "grace-reset";

/** The subscription columns the paid-seat rule reads. `repo_ids` is the stored JSON text, or an array. */
export interface SubscriptionRow {
  plan: string;
  seats: number | null;
  repo_ids: string | number[] | null;
  status: string | null;
  ended_at: number | null;
}

export interface SeatRow {
  user_id: number;
  first_key_at: number;
  last_key_at: number;
}

export interface OveruseRow {
  grace_started_at: number | null;
  grace_spent_until: number | null;
}

/** The id `seats` rows are keyed by: the repo under a Private repo plan, the owner otherwise. The `overuse` row is always the owner's. */
export function licenseeOf(plan: PaidPlan, ownerId: number, repoId: number): number {
  return plan === "private-repo" ? repoId : ownerId;
}

const PAYING = ["active", "trialing", "past_due"];

function repoIdsOf(v: SubscriptionRow["repo_ids"]): number[] {
  if (Array.isArray(v)) return v;
  if (typeof v !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.map(Number) : [];
  } catch {
    return [];
  }
}

/**
 * The seats the owner's rows pay for under `plan`: a row counts while its status is active,
 * trialing or past_due and it has not ended; a Private repo row only for the repos it names.
 */
export function paidSeats(subscriptions: SubscriptionRow[], _now: number, scope: { plan: PaidPlan; repoId: number }): number {
  let paid = 0;
  for (const s of subscriptions) {
    if (s.plan !== scope.plan || s.ended_at !== null || !PAYING.includes(s.status ?? "")) continue;
    if (scope.plan === "private-repo" && !repoIdsOf(s.repo_ids).includes(scope.repoId)) continue;
    paid += typeof s.seats === "number" && s.seats > 0 ? s.seats : 0;
  }
  return paid;
}

/** 10% more users than paid for, at least one; none for a licensee paying for nothing. */
export function headroom(paid: number): number {
  return paid === 0 ? 0 : Math.max(1, Math.ceil(paid / 10));
}

/** The features `ok` and `grace` keys carry: everything but fleet on Public and Private repo, everything on the owner-wide plans. */
export function planFeatures(plan: Plan): string[] {
  return plan === "public" || plan === "private-repo" ? FEATURES.filter((f) => f !== "fleet") : [...FEATURES];
}

export interface SeatVerdict {
  state: SeatState;
  graceUntil: number | null;
  counted: number;
  headroom: number;
  /** The caller's place among the seated users, or null with no caller. */
  rank: number | null;
  seated: boolean;
  notice: Notice | null;
  features: string[];
  writes: SeatWrite[];
}

/**
 * "Seats and overuse" 1-5 for one licensee. `seatRows` are its rows; those whose last key is older
 * than the 30-day window are left out. Ranked by first key then user id, the caller is its row's
 * place, or one past the rows when it has none; with no caller (an Actions key) only the rows
 * count. The first key beyond headroom starts grace and assumes the start it asks to be written.
 */
export function resolveSeats(input: { plan: PaidPlan; paid: number; seatRows: SeatRow[]; userId: number | null; overuse: OveruseRow | null; now: number }): SeatVerdict {
  const { plan, paid, userId, now } = input;
  const rows = input.seatRows.filter((r) => r.last_key_at >= now - SEAT_WINDOW_S).sort((a, b) => a.first_key_at - b.first_key_at || a.user_id - b.user_id);
  const at = userId === null ? -1 : rows.findIndex((r) => r.user_id === userId);
  const counted = rows.length + (userId !== null && at === -1 ? 1 : 0);
  const rank = userId === null ? null : at === -1 ? counted : at + 1;
  const seated = rank !== null && rank <= paid;
  const room = headroom(paid);
  const started = input.overuse?.grace_started_at ?? null;
  const spentUntil = input.overuse?.grace_spent_until ?? null;
  const verdict = (state: SeatState, notice: Notice | null, graceUntil: number | null = null, writes: SeatWrite[] = []): SeatVerdict => ({
    state,
    graceUntil,
    counted,
    headroom: room,
    rank,
    seated,
    notice,
    features: state === "degraded" ? [] : planFeatures(plan),
    writes,
  });

  if (counted <= paid) return verdict("ok", null, null, started !== null ? ["grace-reset"] : []);
  if (counted <= paid + room) return verdict("ok", "over-within-headroom");
  if (started !== null && now < started + GRACE_S) return verdict("grace", "overused", started + GRACE_S);
  if (started === null && (spentUntil === null || now >= spentUntil)) return verdict("grace", "overused", now + GRACE_S, ["grace-start"]);
  return seated ? verdict("ok", "overused") : verdict("degraded", "seat-refused");
}

/** The UTC day of a unix time, as the `usage` table keys it. */
export function dayOf(at: number): string {
  return new Date(at * 1000).toISOString().slice(0, 10);
}

/**
 * The markers the deploy pushes onto the writes queue to have the consumer run a reconcile at once,
 * `reconcile-now` the GitHub one and `polar-reconcile-now` the Polar one.
 */
export const RECONCILE_MARKERS = ["reconcile-now", "polar-reconcile-now"] as const;
export type ReconcileMarker = (typeof RECONCILE_MARKERS)[number];

/**
 * The markers an `incidents` row carries, one row per occurrence. The alerts count none of
 * `deploy-read-back`, the message every deploy pushes onto the writes queue to prove the consumer,
 * or the reconcile requests.
 */
export const INCIDENT_MARKERS = ["d1-unreadable", "polar-unreachable", "app-not-installed", "polar-webhook-refused", "write-dead-lettered", "secondary-rate-limit", "deploy-read-back", ...RECONCILE_MARKERS] as const;
export type IncidentMarker = (typeof INCIDENT_MARKERS)[number];
/** The longest `detail` an incident carries. */
export const INCIDENT_DETAIL_MAX = 200;

/** What the key Worker queues and the sync Worker writes, one message each. */
export type WriteMessage =
  | { v: 1; kind: "usage"; at: number; repo_id: number; user_id: number; owner_id: number; plan: PaidPlan; day: string }
  | { v: 1; kind: "grace-start"; at: number; owner_id: number }
  | { v: 1; kind: "grace-reset"; at: number; owner_id: number }
  | { v: 1; kind: "incident"; at: number; marker: IncidentMarker; detail?: string };

const PAID_PLANS: readonly string[] = ["private-repo", "personal", "organization", "internal"];
const isId = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

/** Whether a queued body is a message this version writes. */
export function isWriteMessage(m: unknown): m is WriteMessage {
  if (typeof m !== "object" || m === null) return false;
  const r = m as Record<string, unknown>;
  if (r.v !== 1 || typeof r.at !== "number" || !Number.isSafeInteger(r.at)) return false;
  if (r.kind === "incident") {
    return (INCIDENT_MARKERS as readonly unknown[]).includes(r.marker) && (r.detail === undefined || (typeof r.detail === "string" && r.detail.length <= INCIDENT_DETAIL_MAX));
  }
  if (!isId(r.owner_id)) return false;
  if (r.kind === "grace-start" || r.kind === "grace-reset") return true;
  return r.kind === "usage" && isId(r.repo_id) && isId(r.user_id) && PAID_PLANS.includes(r.plan as string) && typeof r.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.day);
}

export { KEY_COUNT_BLOBS, keyCountBlobs, type KeyCountBlob } from "./key-counts.ts";
