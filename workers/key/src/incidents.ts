// The markers the alerts count, sent to D1 as incident messages on the writes queue, so the key
// Worker still writes nothing itself. The log line stays as it was; the message is queued inside
// waitUntil, so an answer never waits on it. Without a queue binding or a request context only the
// line is left.
import { INCIDENT_DETAIL_MAX, type IncidentMarker } from "../../../packages/licensing/src/index.ts";
import { enqueueWrites } from "./writes.ts";

export interface IncidentEnv {
  WRITES?: Queue;
}

/** Queues one incident, logging nothing beyond what the caller already logged. */
export function queueIncident(env: IncidentEnv, ctx: ExecutionContext | undefined, marker: IncidentMarker, detail?: string): void {
  if (!env.WRITES || !ctx) return;
  const at = Math.floor(Date.now() / 1000);
  enqueueWrites(env, ctx, [{ v: 1, kind: "incident", at, marker, ...(detail === undefined ? {} : { detail: detail.slice(0, INCIDENT_DETAIL_MAX) }) }]);
}

/** Logs `{ marker, ...line }` and queues the incident. */
export function incident(env: IncidentEnv, ctx: ExecutionContext | undefined, marker: IncidentMarker, detail: string | undefined, line: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ marker, ...line }));
  queueIncident(env, ctx, marker, detail);
}
