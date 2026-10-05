// The coverage audit: every paying subscription row needs the App on at least one of its owner's
// repos, since a fleet covers every repo the owner has. The count of uncovered accounts, one per
// owner and plan, goes to sync_state.paying_uncovered, which the alerts read; the accounts are named
// only in this Worker's log, since health and alerts are unauthenticated.
import { stamp } from "./repos.ts";

interface PayingRow {
  owner_id: number;
  plan: string;
}

/** Audits every paying row, stamps the number of uncovered accounts and returns it. */
export async function auditCoverage(db: D1Database, nowS: number): Promise<number> {
  const [paying, owners] = await db.batch([
    db.prepare("SELECT DISTINCT owner_id, plan FROM subscriptions WHERE status IN ('active', 'trialing', 'past_due') AND ended_at IS NULL ORDER BY owner_id, plan"),
    db.prepare("SELECT DISTINCT owner_id FROM repos"),
  ]);
  const held = new Set(((owners?.results ?? []) as unknown as { owner_id: number }[]).map((r) => r.owner_id));
  const uncovered = ((paying?.results ?? []) as unknown as PayingRow[]).filter((row) => !held.has(row.owner_id));
  for (const account of uncovered) console.log(JSON.stringify({ marker: "paying-uncovered", owner_id: account.owner_id, plan: account.plan }));
  await stamp(db, "paying_uncovered", nowS, String(uncovered.length)).run();
  return uncovered.length;
}
