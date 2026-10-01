// The subscriptions table, written only here, from Polar's subscription object as its webhooks and
// its listing carry it. A row is filed under the GitHub account the checkout named as the external
// customer id; a subscription with none, or on a product we do not manage, pays for nobody.
import { MANAGED_BY, type PolarSubscription } from "../../../packages/polar/src/index.ts";

export interface SubscriptionRow {
  polar_subscription_id: string;
  owner_id: number;
  owner_type: "User" | "Organization";
  plan: "private-repo" | "personal" | "organization" | "internal";
  seats: number | null;
  repo_ids: string | null;
  source: "polar";
  period_end: number | null;
  cancel_at_period_end: number | null;
  modified_at: number;
  raw: string;
  status: string | null;
  ended_at: number | null;
  product_id: string | null;
  interval: "month" | "year" | null;
}

/** The columns the reconcile compares; `raw` is left out, since Polar's listing and its webhooks may serialize the same object differently. */
export const COMPARED = ["owner_id", "owner_type", "plan", "seats", "repo_ids", "period_end", "cancel_at_period_end", "modified_at", "status", "ended_at", "product_id", "interval"] as const;

const PLANS = ["private-repo", "personal", "organization", "internal"];
const DIGITS = /^[1-9][0-9]{0,15}$/;

const seconds = (t: unknown): number | null => (typeof t === "string" && !Number.isNaN(Date.parse(t)) ? Math.floor(Date.parse(t) / 1000) : null);

export type Skip = "polar-no-external-id" | "polar-not-managed" | "polar-no-owner-type" | "polar-malformed";

/** Maps Polar's object to the row, or names why it is skipped. */
export function subscriptionRow(sub: PolarSubscription): { row: SubscriptionRow } | { skip: Skip } {
  if (typeof sub?.id !== "string" || typeof sub.product !== "object" || sub.product === null) return { skip: "polar-malformed" };
  const externalId = sub.customer?.external_id;
  if (typeof externalId !== "string" || !DIGITS.test(externalId)) return { skip: "polar-no-external-id" };
  const pm = sub.product.metadata ?? {};
  const plan = pm.claudinite_plan;
  if (pm.managed_by !== MANAGED_BY || typeof plan !== "string" || !PLANS.includes(plan)) return { skip: "polar-not-managed" };
  const meta = sub.metadata ?? {};
  const ownerType = meta.github_owner_type;
  if (ownerType !== "User" && ownerType !== "Organization") return { skip: "polar-no-owner-type" };
  const modified = seconds(sub.modified_at) ?? seconds(sub.created_at);
  if (modified === null) return { skip: "polar-malformed" };
  const repoId = typeof meta.github_repo_id === "string" && DIGITS.test(meta.github_repo_id) ? Number(meta.github_repo_id) : null;
  const interval = pm.claudinite_interval === "month" || pm.claudinite_interval === "year" ? pm.claudinite_interval : null;
  return {
    row: {
      polar_subscription_id: sub.id,
      owner_id: Number(externalId),
      owner_type: ownerType,
      plan: plan as SubscriptionRow["plan"],
      seats: typeof sub.seats === "number" ? sub.seats : null,
      repo_ids: plan === "private-repo" && repoId !== null ? JSON.stringify([repoId]) : null,
      source: "polar",
      period_end: seconds(sub.current_period_end),
      cancel_at_period_end: typeof sub.cancel_at_period_end === "boolean" ? Number(sub.cancel_at_period_end) : null,
      modified_at: modified,
      raw: JSON.stringify(sub),
      status: typeof sub.status === "string" ? sub.status : null,
      ended_at: seconds(sub.ended_at),
      product_id: typeof sub.product_id === "string" ? sub.product_id : null,
      interval,
    },
  };
}

const COLUMNS = ["polar_subscription_id", "owner_id", "owner_type", "plan", "seats", "repo_ids", "source", "period_end", "cancel_at_period_end", "modified_at", "raw", "status", "ended_at", "product_id", "interval"] as const;

/**
 * The row's upsert. A webhook's write is skipped when the stored row is newer by Polar's modified
 * time, so a duplicate, retried or reordered delivery never leaves a wrong row; the reconcile
 * passes `force`, since it overwrites whatever still differs from Polar.
 */
export function upsertSubscription(db: D1Database, row: SubscriptionRow, opts: { force?: boolean } = {}): D1PreparedStatement {
  const updates = COLUMNS.filter((c) => c !== "polar_subscription_id").map((c) => `${c} = excluded.${c}`).join(", ");
  return db
    .prepare(
      `INSERT INTO subscriptions (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(() => "?").join(", ")})
       ON CONFLICT (polar_subscription_id) DO UPDATE SET ${updates}${opts.force ? "" : " WHERE excluded.modified_at >= subscriptions.modified_at"}`,
    )
    .bind(...COLUMNS.map((c) => row[c]));
}
