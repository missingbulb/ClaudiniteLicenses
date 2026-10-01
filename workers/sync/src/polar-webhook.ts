// Polar's signed webhooks: subscription events upsert the subscriptions table; every other event,
// checkout.created included, is acknowledged with no write. A verified delivery stamps
// last_polar_webhook_at; a refused one stamps nothing, so a secret that stops matching shows as a
// stale stamp.
import { SUBSCRIPTION_EVENTS, verifyWebhook, type PolarSubscription } from "../../../packages/polar/src/index.ts";
import { stamp } from "./repos.ts";
import { subscriptionRow, upsertSubscription } from "./subscriptions.ts";

export interface PolarWebhookEnv {
  DB: D1Database;
  POLAR_WEBHOOK_SECRET?: string;
}

function refuse(reason: string): Response {
  console.log(JSON.stringify({ marker: "polar-webhook-refused", reason }));
  return new Response(reason, { status: 401 });
}

export async function polarWebhook(req: Request, env: PolarWebhookEnv, nowS: number): Promise<Response> {
  const body = await req.text();
  if (!env.POLAR_WEBHOOK_SECRET) return refuse("secret-unset");
  const verdict = await verifyWebhook(req.headers, body, env.POLAR_WEBHOOK_SECRET, nowS);
  if (!verdict.ok) return refuse(verdict.reason);
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
