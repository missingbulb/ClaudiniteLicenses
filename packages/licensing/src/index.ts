// The fleet rules the key Worker decides from, as pure functions, and the write messages the key
// Worker queues for the sync Worker. Both Workers bundle this package, so the plan a key carries and
// the rows the sync Worker writes follow one definition. No I/O: callers pass the rows.
import { FEATURES, type Plan } from "../../signing/src/index.ts";

export type PaidPlan = Exclude<Plan, "public">;
/** The fleets Polar sells; `internal` is never sold. */
export type FleetPlan = "personal" | "organization";
export type OwnerType = "User" | "Organization";

/** The subscription columns the fleet rule reads. */
export interface SubscriptionRow {
  plan: string;
  status: string | null;
  ended_at: number | null;
}

const PAYING = ["active", "trialing", "past_due"];

const pays = (s: SubscriptionRow, plan: PaidPlan) => s.plan === plan && s.ended_at === null && PAYING.includes(s.status ?? "");

/**
 * The fleet the owner's rows pay for, or null: `internal` first, then `personal` for a User owner
 * and `organization` for an Organization owner. A row pays while its status is active, trialing or
 * past_due and it has not ended; its seat count is never read.
 */
export function fleetPlan(ownerType: OwnerType, subscriptions: SubscriptionRow[]): PaidPlan | null {
  const wanted: PaidPlan[] = ["internal", ownerType === "User" ? "personal" : "organization"];
  return wanted.find((plan) => subscriptions.some((s) => pays(s, plan))) ?? null;
}

/** The fleet an owner of this type can buy. */
export function checkoutPlanFor(ownerType: OwnerType): FleetPlan {
  return ownerType === "User" ? "personal" : "organization";
}

/** The features `ok` keys carry: everything but fleet on Public, everything on a fleet plan. */
export function planFeatures(plan: Plan): string[] {
  return plan === "public" ? FEATURES.filter((f) => f !== "fleet") : [...FEATURES];
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
