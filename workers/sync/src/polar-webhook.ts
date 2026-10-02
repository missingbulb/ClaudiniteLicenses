// Polar's signed webhooks: subscription events upsert the subscriptions table; every other event,
// checkout.created included, is acknowledged with no write. A verified delivery stamps
// last_polar_webhook_at; a refused one stamps nothing and records a polar-webhook-refused incident,
// so a secret that stops matching shows as a stale stamp and, repeated, as an alert. A refusal meets
// the caller's per-address cap before that write; a verified delivery is Polar's and never does.
import { SUBSCRIPTION_EVENTS, verifyWebhook, type PolarSubscription } from "../../../packages/polar/src/index.ts";
import { BODY_MAX_WEBHOOK, ipLimited, readCapped } from "../../../packages/http/src/index.ts";
import { insertCappedIncident } from "./incidents.ts";
import { stamp } from "./repos.ts";
import { subscriptionRow, upsertSubscription } from "./subscriptions.ts";

export interface PolarWebhookEnv {
  DB: D1Database;
  POLAR_WEBHOOK_SECRET?: string;
}

async function refuse(db: D1Database, reason: string, nowS: number, withinCap: () => Promise<boolean>): Promise<Response> {
  if (!(await withinCap())) return ipLimited();
  console.log(JSON.stringify({ marker: "polar-webhook-refused", reason }));
  try {
    // Anyone can post here unsigned, so the record is capped per hour.
    await insertCappedIncident(db, "polar-webhook-refused", nowS, reason).run();
  } catch (err) {
    console.error(JSON.stringify({ marker: "incident-unwritten", error: String(err) }));
  }
  return new Response(reason, { status: 401 });
}

/** `withinCap` is the caller's per-address cap, asked only on the way to a refusal. */
export async function polarWebhook(req: Request, env: PolarWebhookEnv, nowS: number, withinCap: () => Promise<boolean>): Promise<Response> {
  const bytes = await readCapped(req, BODY_MAX_WEBHOOK);
  if (bytes === null) return new Response("payload-too-large", { status: 413 });
  const body = new TextDecoder().decode(bytes);
  if (!env.POLAR_WEBHOOK_SECRET) return refuse(env.DB, "secret-unset", nowS, withinCap);
  const verdict = await verifyWebhook(req.headers, body, env.POLAR_WEBHOOK_SECRET, nowS);
  if (!verdict.ok) return refuse(env.DB, verdict.reason, nowS, withinCap);
  const { type, data } = verdict.event;
  const seen = stamp(env.DB, "last_polar_webhook_at", nowS);
  if (!(SUBSCRIPTION_EVENTS as readonly string[]).includes(type)) {
    await seen.run();
    return new Response(null, { status: 204 });
  }
  const mapped = subscriptionRow(data as PolarSubscription);
  if ("skip" in mapped) {
    console.log(JSON.stringify({ marker: mapped.skip, id: (data as { id?: unknown })?.id ?? null, type, delivery: verdict.id }));
    await seen.run();
    return new Response(`skipped: ${mapped.skip}`, { status: 200 });
  }
  const [write] = await env.DB.batch([upsertSubscription(env.DB, mapped.row), seen]);
  return new Response(write!.meta.changes > 0 ? `${type}: written` : `${type}: older than the stored row`, { status: 200 });
}
