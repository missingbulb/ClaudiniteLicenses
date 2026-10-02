// The reads a private repo's verdict needs beyond its subscriptions: the licensee's seat rows in the
// 30-day window, the owner's overuse row and, for a session key, whether today's usage row exists.
// One D1 batch, so a private repo's key costs two round trips in all.
import type { D1Reads } from "./db.ts";
import { dayOf, resolveSeats, SEAT_WINDOW_S, type OveruseRow, type PaidPlan, type SeatRow, type SeatVerdict } from "../../../packages/licensing/src/index.ts";

export interface LicenseeReads {
  seatRows: SeatRow[];
  overuse: OveruseRow | null;
  /** Null when not read: an Actions key has no user and records no usage. */
  usedToday: boolean | null;
}

export async function readLicensee(db: D1Reads, q: { licensee: number; ownerId: number; repoId: number; userId: number | null; now: number }): Promise<LicenseeReads> {
  const statements = [
    db.prepare("SELECT user_id, first_key_at, last_key_at FROM seats WHERE licensee_id = ? AND last_key_at >= ?").bind(q.licensee, q.now - SEAT_WINDOW_S),
    db.prepare("SELECT grace_started_at, grace_spent_until FROM overuse WHERE licensee_id = ?").bind(q.ownerId),
  ];
  if (q.userId !== null) statements.push(db.prepare("SELECT 1 AS used FROM usage WHERE repo_id = ? AND user_id = ? AND day = ?").bind(q.repoId, q.userId, dayOf(q.now)));
  const [seats, overuse, usage] = await db.batch(statements);
  return {
    seatRows: (seats?.results ?? []) as unknown as SeatRow[],
    overuse: ((overuse?.results ?? [])[0] as OveruseRow | undefined) ?? null,
    usedToday: usage ? usage.results.length > 0 : null,
  };
}

/** The licensee's verdict for the caller, or for no caller on an Actions key. */
export function verdictFor(plan: PaidPlan, paid: number, reads: LicenseeReads, userId: number | null, now: number): SeatVerdict {
  return resolveSeats({ plan, paid, seatRows: reads.seatRows, userId, overuse: reads.overuse, now });
}
