// The writes queue's consumer: the seat, usage and overuse records and the incidents the key Worker
// queues, written in message order as one D1 batch per delivery. Every seat statement is idempotent,
// so a redelivered message changes nothing there; a redelivered incident is one more row, which only
// errs toward an alert. A batch from the dead-letter queue is logged, stamped and counted as
// incidents, never written, so a lost seat record is seen rather than silent. Every batch stamps the
// version that consumed it beside its time, so health names the consumer's version. A committed
// batch also answers which reconciles it requested, each by its latest request.
import { GRACE_SPENT_S, isWriteMessage, licenseeOf, RECONCILE_MARKERS, SEAT_WINDOW_S, type ReconcileMarker, type WriteMessage } from "../../../packages/licensing/src/index.ts";
import { insertIncident } from "./incidents.ts";
import { stamp } from "./repos.ts";
import { versionOf, type VersionEnv } from "../../../packages/version/src/index.ts";

export const WRITES_QUEUE = "claudinite-licenses-writes";
export const DEAD_LETTER_QUEUE = "claudinite-licenses-writes-dlq";

export interface WritesEnv extends VersionEnv {
  DB: D1Database;
}

function statementsFor(db: D1Database, m: WriteMessage): D1PreparedStatement[] {
  if (m.kind === "usage") {
    return [
      db.prepare("INSERT OR IGNORE INTO usage (repo_id, user_id, day) VALUES (?, ?, ?)").bind(m.repo_id, m.user_id, m.day),
      // SQLite evaluates every SET expression against the row as it was before the update.
      db
        .prepare(
          `INSERT INTO seats (licensee_id, user_id, first_key_at, last_key_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (licensee_id, user_id) DO UPDATE SET
             first_key_at = CASE WHEN seats.last_key_at < excluded.last_key_at - ${SEAT_WINDOW_S} THEN excluded.first_key_at ELSE seats.first_key_at END,
             last_key_at = MAX(seats.last_key_at, excluded.last_key_at)`,
        )
        .bind(licenseeOf(m.plan, m.owner_id, m.repo_id), m.user_id, m.at, m.at),
    ];
  }
  if (m.kind === "grace-start") {
    return [
      db
        .prepare(
          `INSERT INTO overuse (licensee_id, grace_started_at, grace_spent_until) VALUES (?, ?, ?)
           ON CONFLICT (licensee_id) DO UPDATE SET
             grace_started_at = COALESCE(overuse.grace_started_at, excluded.grace_started_at),
             grace_spent_until = MAX(COALESCE(overuse.grace_spent_until, 0), excluded.grace_spent_until)`,
        )
        .bind(m.owner_id, m.at, m.at + GRACE_SPENT_S),
    ];
  }
  if (m.kind === "incident") return [insertIncident(db, m.marker, m.at, m.detail)];
  // Delivery order is best-effort: a reset older than the stored start leaves that start alone.
  return [db.prepare("UPDATE overuse SET grace_started_at = NULL WHERE licensee_id = ? AND grace_started_at <= ?").bind(m.owner_id, m.at)];
}

/** Each reconcile a batch requested, by the time of its latest request. */
export type ReconcileRequests = Partial<Record<ReconcileMarker, number>>;

export async function consumeWrites(batch: MessageBatch, env: WritesEnv, nowS: number): Promise<ReconcileRequests> {
  const db = env.DB;
  if (batch.queue === DEAD_LETTER_QUEUE) {
    const writes: D1PreparedStatement[] = [];
    for (const msg of batch.messages) {
      const body = msg.body as { kind?: unknown; at?: unknown } | null;
      console.log(JSON.stringify({ marker: "write-dead-lettered", kind: body?.kind ?? null, at: body?.at ?? null }));
      writes.push(insertIncident(db, "write-dead-lettered", nowS, typeof body?.kind === "string" ? body.kind : null));
    }
    await db.batch([...writes, stamp(db, "last_dead_letter_at", nowS), stamp(db, "last_queue_version", nowS, versionOf(env))]);
    batch.ackAll();
    return {};
  }

  const writes: D1PreparedStatement[] = [];
  const requested: ReconcileRequests = {};
  let oldest = nowS;
  for (const msg of batch.messages) {
    if (!isWriteMessage(msg.body)) {
      // A message this version cannot read would fail every retry the same way.
      console.log(JSON.stringify({ marker: "write-malformed", id: msg.id, body: msg.body }));
      continue;
    }
    writes.push(...statementsFor(db, msg.body));
    oldest = Math.min(oldest, msg.body.at);
    const m = msg.body;
    if (m.kind === "incident" && (RECONCILE_MARKERS as readonly string[]).includes(m.marker)) {
      const marker = m.marker as ReconcileMarker;
      requested[marker] = Math.max(requested[marker] ?? m.at, m.at);
    }
  }
  writes.push(stamp(db, "last_queue_at", nowS), stamp(db, "last_queue_version", nowS, versionOf(env)), stamp(db, "queue_lag_s", nowS, String(Math.max(0, nowS - oldest))));
  try {
    await db.batch(writes);
  } catch (err) {
    console.error(JSON.stringify({ marker: "write-retried", messages: batch.messages.length, error: String(err) }));
    batch.retryAll();
    return {};
  }
  batch.ackAll();
  return requested;
}
