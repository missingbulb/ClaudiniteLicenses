// The Polar reconcile: lists every subscription through Polar's API and upserts each row that is
// missing or differs, overwriting whatever a lost webhook or a bug of ours left. Nothing is
// deleted: a subscription Polar no longer lists is one it never had. A failure stamps its status
// and writes nothing else; the next success clears it.
import { listSubscriptions, polarClient, PolarError } from "../../../packages/polar/src/index.ts";
import { stamp } from "./repos.ts";
import { COMPARED, subscriptionRow, upsertSubscription, type SubscriptionRow } from "./subscriptions.ts";

export interface PolarReconcileEnv {
  DB: D1Database;
  POLAR_ACCESS_TOKEN?: string;
  POLAR_API_BASE?: string;
}

/** How long a Polar reconcile success stays good before the hourly cron runs another. */
export const POLAR_RECONCILE_EVERY_S = 24 * 3600;

export async function reconcilePolar(env: PolarReconcileEnv, nowS: number): Promise<{ subscriptions: number; corrections: number }> {
  let listed;
  try {
    if (!env.POLAR_ACCESS_TOKEN || !env.POLAR_API_BASE) throw new PolarError("polar reconcile", null, "unconfigured");
    listed = await listSubscriptions(polarClient({ base: env.POLAR_API_BASE, token: env.POLAR_ACCESS_TOKEN, timeoutMs: 20_000, userAgent: "claudinite-sync" }));
  } catch (err) {
    const status = err instanceof PolarError ? String(err.status ?? err.body) : "error";
    await stamp(env.DB, "last_polar_reconcile_error", nowS, status).run();
    throw err;
  }
  const { results: held } = await env.DB.prepare(`SELECT polar_subscription_id, ${COMPARED.join(", ")} FROM subscriptions`).all<SubscriptionRow>();
  const heldById = new Map(held.map((r) => [r.polar_subscription_id, r]));
  const writes: D1PreparedStatement[] = [];
  let subscriptions = 0;
  for (const sub of listed) {
    const mapped = subscriptionRow(sub);
    if ("skip" in mapped) {
      console.log(JSON.stringify({ marker: mapped.skip, id: sub?.id ?? null, reconcile: "polar" }));
      continue;
    }
    subscriptions++;
    const have = heldById.get(mapped.row.polar_subscription_id);
    if (!have || COMPARED.some((c) => have[c] !== mapped.row[c])) writes.push(upsertSubscription(env.DB, mapped.row, { force: true }));
  }
  const corrections = writes.length;
  writes.push(
    stamp(env.DB, "last_polar_reconcile_corrections", nowS, String(corrections)),
    stamp(env.DB, "last_polar_reconcile_at", nowS),
    env.DB.prepare("DELETE FROM sync_state WHERE name = 'last_polar_reconcile_error'"),
  );
  await env.DB.batch(writes);
  return { subscriptions, corrections };
}

/** Whether the hourly cron runs the reconcile: never succeeded, the last attempt failed, or the last success is a day old. */
export async function polarReconcileDue(db: D1Database, nowS: number): Promise<boolean> {
  const { results } = await db.prepare("SELECT name, at FROM sync_state WHERE name IN ('last_polar_reconcile_at', 'last_polar_reconcile_error')").all<{ name: string; at: number }>();
  const at = (name: string) => results.find((r) => r.name === name)?.at ?? null;
  const success = at("last_polar_reconcile_at");
  return at("last_polar_reconcile_error") !== null || success === null || nowS - success >= POLAR_RECONCILE_EVERY_S;
}
