// The alerts endpoint: one judgment over the sync stamps and the incidents in each marker's
// window, answering 503 while any alert stands. Every alert clears on its own as its window passes
// or its stamp moves, so a status-only monitor's state follows the server's and nothing needs an
// acknowledgement. queue_lag_s is a reading taken at the last consumed batch, not the queue's live
// depth, so its alert is bounded to a recent batch.
import { INCIDENT_MARKERS, type IncidentMarker } from "../../../packages/licensing/src/index.ts";

const HOUR = 3600;

/** The design's 26 hours: a nightly reconcile and two hours of slack. */
export const POLAR_RECONCILE_STALE_S = 26 * HOUR;
/** How long the Worker must have been running before a reconcile that never succeeded counts as stale. */
export const FIRST_RECONCILE_GRACE_S = 24 * HOUR;
export const GITHUB_RECONCILE_STALE_S = 26 * HOUR;
/** The design's 15 minutes for the oldest write waiting in the queue. */
export const QUEUE_LAG_MAX_S = 900;
/** How recent a consumed batch must be for its lag reading to count. */
export const QUEUE_READING_RECENT_S = 24 * HOUR;
export const DEAD_LETTER_RECENT_S = 24 * HOUR;

/** The alerts counted from incidents: at least `atLeast` of `marker` within `windowS`. */
export const INCIDENT_ALERTS: readonly { id: string; marker: IncidentMarker; atLeast: number; windowS: number }[] = [
  { id: "polar-webhooks-refused", marker: "polar-webhook-refused", atLeast: 3, windowS: HOUR },
  { id: "d1-unreadable", marker: "d1-unreadable", atLeast: 1, windowS: HOUR },
  { id: "polar-unreachable", marker: "polar-unreachable", atLeast: 3, windowS: HOUR },
  { id: "app-not-installed", marker: "app-not-installed", atLeast: 5, windowS: HOUR },
];

export type Stamps = Partial<Record<string, { at: number; detail: string | null }>>;
/** Per marker, how many incidents fell in its alert's window and the earliest of them. */
export type IncidentCounts = Partial<Record<IncidentMarker, { count: number; first: number }>>;

export interface Alert {
  id: string;
  since: number | null;
  detail: string | null;
}

const numberOf = (detail: string | null | undefined): number | null => (detail == null || detail === "" || Number.isNaN(Number(detail)) ? null : Number(detail));

function windowText(windowS: number): string {
  return windowS === HOUR ? "the last hour" : `the last ${windowS} s`;
}

export function evaluateAlerts(stamps: Stamps, incidents: IncidentCounts, now: number): Alert[] {
  const out: Alert[] = [];
  const at = (name: string) => stamps[name]?.at ?? null;

  const polar = at("last_polar_reconcile_at");
  if (polar !== null) {
    if (now - polar > POLAR_RECONCILE_STALE_S) out.push({ id: "polar-reconcile-stale", since: polar + POLAR_RECONCILE_STALE_S, detail: `last reconcile ${polar}` });
  } else {
    const running = [at("last_queue_at"), at("last_webhook_at")].filter((t): t is number => t !== null && now - t > FIRST_RECONCILE_GRACE_S);
    if (running.length > 0) out.push({ id: "polar-reconcile-stale", since: Math.min(...running) + FIRST_RECONCILE_GRACE_S, detail: "no reconcile has succeeded" });
  }
  const error = stamps.last_polar_reconcile_error;
  if (error) out.push({ id: "polar-reconcile-failing", since: error.at, detail: error.detail });
  const corrected = stamps.last_polar_reconcile_corrections;
  const corrections = numberOf(corrected?.detail);
  if (corrected && corrections !== null && corrections > 0) out.push({ id: "polar-reconcile-corrected", since: corrected.at, detail: String(corrections) });

  const github = at("last_reconcile_at");
  if (github !== null && now - github > GITHUB_RECONCILE_STALE_S) out.push({ id: "github-reconcile-stale", since: github + GITHUB_RECONCILE_STALE_S, detail: `last reconcile ${github}` });

  const queueAt = at("last_queue_at");
  const lag = numberOf(stamps.queue_lag_s?.detail);
  if (queueAt !== null && now - queueAt <= QUEUE_READING_RECENT_S && lag !== null && lag > QUEUE_LAG_MAX_S) out.push({ id: "queue-lagging", since: queueAt, detail: `queue_lag_s ${lag}` });

  const dead = at("last_dead_letter_at");
  if (dead !== null && now - dead <= DEAD_LETTER_RECENT_S) out.push({ id: "writes-dead-lettered", since: dead, detail: null });

  for (const rule of INCIDENT_ALERTS) {
    const seen = incidents[rule.marker];
    if (seen && seen.count >= rule.atLeast) out.push({ id: rule.id, since: seen.first, detail: `${seen.count} in ${windowText(rule.windowS)}` });
  }

  const uncovered = stamps.paying_uncovered;
  const count = numberOf(uncovered?.detail);
  if (uncovered && count !== null && count > 0) out.push({ id: "paying-uncovered", since: uncovered.at, detail: String(count) });
  return out;
}

/** The stamps and each counted marker's incidents within its own window, two reads in one batch. */
export async function readAlertInputs(db: D1Database, now: number): Promise<{ stamps: Stamps; incidents: IncidentCounts }> {
  const where = INCIDENT_ALERTS.map(() => "(marker = ? AND at >= ?)").join(" OR ");
  const [state, counts] = await db.batch([
    db.prepare("SELECT name, at, detail FROM sync_state"),
    db.prepare(`SELECT marker, COUNT(*) AS n, MIN(at) AS first FROM incidents WHERE ${where} GROUP BY marker`).bind(...INCIDENT_ALERTS.flatMap((r) => [r.marker, now - r.windowS])),
  ]);
  const stamps: Stamps = {};
  for (const r of (state?.results ?? []) as unknown as { name: string; at: number; detail: string | null }[]) stamps[r.name] = { at: r.at, detail: r.detail };
  const incidents: IncidentCounts = {};
  for (const r of (counts?.results ?? []) as unknown as { marker: string; n: number; first: number }[]) {
    if ((INCIDENT_MARKERS as readonly string[]).includes(r.marker)) incidents[r.marker as IncidentMarker] = { count: r.n, first: r.first };
  }
  return { stamps, incidents };
}

export async function alertsRoute(db: D1Database, now: number): Promise<Response> {
  let alerts: Alert[];
  try {
    const { stamps, incidents } = await readAlertInputs(db, now);
    alerts = evaluateAlerts(stamps, incidents, now);
  } catch (err) {
    console.error(JSON.stringify({ marker: "sync-d1-unreadable", error: String(err) }));
    alerts = [{ id: "sync-d1-unreadable", since: now, detail: String(err).slice(0, 200) }];
  }
  return Response.json({ ok: alerts.length === 0, checked_at: now, alerts }, { status: alerts.length === 0 ? 200 : 503 });
}
