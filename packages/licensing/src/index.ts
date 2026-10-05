// The plan rules the key Worker decides from, as pure functions, and the write messages the key
// Worker queues for the sync Worker. Both Workers bundle this package, so the plan a key carries and
// the rows the sync Worker writes follow one definition. No I/O: callers pass the rows.
import { FEATURES, type Plan } from "../../signing/src/index.ts";

export type PaidPlan = Exclude<Plan, "public">;

/** The subscription columns the paid-seat rule reads. `repo_ids` is the stored JSON text, or an array. */
export interface SubscriptionRow {
  plan: string;
  seats: number | null;
  repo_ids: string | number[] | null;
  status: string | null;
  ended_at: number | null;
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

/** The features `ok` keys carry: everything but fleet on Public and Private repo, everything on the owner-wide plans. */
export function planFeatures(plan: Plan): string[] {
  return plan === "public" || plan === "private-repo" ? FEATURES.filter((f) => f !== "fleet") : [...FEATURES];
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
export const INCIDENT_MARKERS = ["d1-unreadable", "polar-unreachable", "app-not-installed", "polar-webhook-refused", "write-dead-lettered", "deploy-read-back", ...RECONCILE_MARKERS] as const;
export type IncidentMarker = (typeof INCIDENT_MARKERS)[number];
/** The longest `detail` an incident carries. */
export const INCIDENT_DETAIL_MAX = 200;

/** What the key Worker queues and the sync Worker writes: an incident, one message each. */
export type WriteMessage = { v: 1; kind: "incident"; at: number; marker: IncidentMarker; detail?: string };

/** Whether a queued body is a message this version writes. */
export function isWriteMessage(m: unknown): m is WriteMessage {
  if (typeof m !== "object" || m === null) return false;
  const r = m as Record<string, unknown>;
  if (r.v !== 1 || typeof r.at !== "number" || !Number.isSafeInteger(r.at) || r.kind !== "incident") return false;
  return (INCIDENT_MARKERS as readonly unknown[]).includes(r.marker) && (r.detail === undefined || (typeof r.detail === "string" && r.detail.length <= INCIDENT_DETAIL_MAX));
}

export { KEY_COUNT_BLOBS, keyCountBlobs, type KeyCountBlob } from "./key-counts.ts";
