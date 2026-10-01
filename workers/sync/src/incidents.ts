// The incidents table: one row per occurrence of a marker the alerts count in a window. The key
// Worker's arrive as queued messages; the sync Worker writes its own beside the log line. Rows older
// than any alert window are pruned nightly, since the record's job is the alert, not history.
import { INCIDENT_DETAIL_MAX, type IncidentMarker } from "../../../packages/licensing/src/index.ts";

/** How long an incident is kept: longer than the longest alert window, a day. */
export const INCIDENT_KEEP_S = 7 * 86_400;

export function insertIncident(db: D1Database, marker: IncidentMarker, at: number, detail?: string | null): D1PreparedStatement {
  return db.prepare("INSERT INTO incidents (marker, at, detail) VALUES (?, ?, ?)").bind(marker, at, detail == null ? null : detail.slice(0, INCIDENT_DETAIL_MAX));
}

export async function pruneIncidents(db: D1Database, nowS: number): Promise<number> {
  const res = await db.prepare("DELETE FROM incidents WHERE at < ?").bind(nowS - INCIDENT_KEEP_S).run();
  return res.meta.changes;
}
