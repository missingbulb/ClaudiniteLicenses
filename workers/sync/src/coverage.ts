// The coverage audit: every paying subscription row needs the App on what it pays for, a Private
// repo row on each repo it names and an owner-wide row on at least one of the owner's repos. The
// count goes to sync_state.paying_uncovered, which the alerts read; the accounts are named only in
// this Worker's log, since health and alerts are unauthenticated.
import { stamp } from "./repos.ts";

interface PayingRow {
  owner_id: number;
  plan: string;
  repo_ids: string | null;
}

function repoIdsOf(text: string | null): number[] {
  try {
    const parsed: unknown = JSON.parse(text ?? "[]");
    return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isSafeInteger) : [];
  } catch {
    return [];
  }
}

/** Audits every paying row, stamps the number of uncovered accounts and returns it. */
export async function auditCoverage(db: D1Database, nowS: number): Promise<number> {
  const [paying, repos] = await db.batch([
    db.prepare("SELECT owner_id, plan, repo_ids FROM subscriptions WHERE status IN ('active', 'trialing', 'past_due') AND ended_at IS NULL ORDER BY owner_id, plan, polar_subscription_id"),
    db.prepare("SELECT repo_id, owner_id FROM repos"),
  ]);
  const rows = (paying?.results ?? []) as unknown as PayingRow[];
  const held = (repos?.results ?? []) as unknown as { repo_id: number; owner_id: number }[];
  const repoIds = new Set(held.map((r) => r.repo_id));
  const owners = new Set(held.map((r) => r.owner_id));

  // One account is one owner under one plan; a Private repo account gathers every repo its rows name.
  const uncovered = new Map<string, { owner_id: number; plan: string; repo_ids: number[] }>();
  for (const row of rows) {
    const key = `${row.owner_id}:${row.plan}`;
    const missing = row.plan === "private-repo" ? repoIdsOf(row.repo_ids).filter((id) => !repoIds.has(id)) : [];
    const lost = row.plan === "private-repo" ? missing.length > 0 : !owners.has(row.owner_id);
    if (!lost) continue;
    const account = uncovered.get(key) ?? { owner_id: row.owner_id, plan: row.plan, repo_ids: [] };
    for (const id of missing) if (!account.repo_ids.includes(id)) account.repo_ids.push(id);
    uncovered.set(key, account);
  }
  for (const account of uncovered.values()) console.log(JSON.stringify({ marker: "paying-uncovered", ...account }));
  await stamp(db, "paying_uncovered", nowS, String(uncovered.size)).run();
  return uncovered.size;
}
