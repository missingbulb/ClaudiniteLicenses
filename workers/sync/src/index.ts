// The sync Worker, the only writer of D1: the Claudinite App's installation and repository
// webhooks, forwarded by the router, keep the repos table current; Polar's signed webhooks and the
// Polar reconcile keep subscriptions current; and the writes queue brings the seat, usage and
// overuse records and the incidents the key Worker produces. The nightly reconciles repair whatever
// a lost or reordered webhook left, and a marker on the writes queue runs either one at once, the coverage audit after them finds paying accounts the App no
// longer covers, and GET /v1/sync/alerts judges it all. It holds no signing key.
import { alertsRoute } from "./alerts.ts";
import { auditCoverage } from "./coverage.ts";
import { pruneIncidents } from "./incidents.ts";
import { polarReconcileDue, reconcilePolar } from "./polar-reconcile.ts";
import { polarWebhook } from "./polar-webhook.ts";
import { githubClient, reconcileInstallations } from "./reconcile.ts";
import { applyWebhook, stamp } from "./repos.ts";
import { consumeWrites, type ReconcileRequests } from "./writes.ts";
import { BODY_MAX_WEBHOOK, ipLimited, ipLimitState, readJsonCapped, withinIpLimit, type IpLimitEnv, type IpLimitState } from "../../../packages/http/src/index.ts";
import { versionOf, withVersion, type VersionEnv } from "../../../packages/version/src/index.ts";

export interface Env extends VersionEnv, IpLimitEnv {
  DB: D1Database;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_API_BASE?: string;
  POLAR_API_BASE?: string;
  POLAR_ACCESS_TOKEN?: string;
  POLAR_WEBHOOK_SECRET?: string;
}

/** The nightly cron runs both reconciles; the hourly one retries the Polar reconcile when it is due. */
const NIGHTLY_CRON = "17 3 * * *";
const HOURLY_CRON = "47 * * * *";

const nowS = () => Math.floor(Date.now() / 1000);

async function health(env: Env, ipLimit: IpLimitState | null): Promise<Response> {
  const nowS = Math.floor(Date.now() / 1000);
  const counts = await env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM repos) AS repos, (SELECT COUNT(*) FROM subscriptions) AS subscriptions, (SELECT COUNT(*) FROM seats WHERE last_key_at >= ?) AS seats",
  )
    .bind(nowS - 30 * 86400)
    .first<{ repos: number; subscriptions: number; seats: number }>();
  const { results } = await env.DB.prepare("SELECT name, at, detail FROM sync_state").all<{ name: string; at: number; detail: string | null }>();
  const row = (name: string) => results.find((r) => r.name === name);
  const at = (name: string) => row(name)?.at ?? null;
  const count = (name: string) => (row(name)?.detail == null ? null : Number(row(name)!.detail));
  return Response.json({
    ok: true,
    repos: counts?.repos ?? 0,
    subscriptions: counts?.subscriptions ?? 0,
    seats: counts?.seats ?? 0,
    last_webhook_at: at("last_webhook_at"),
    last_reconcile_at: at("last_reconcile_at"),
    last_reconcile_corrections: count("last_reconcile_corrections"),
    last_polar_webhook_at: at("last_polar_webhook_at"),
    last_polar_reconcile_at: at("last_polar_reconcile_at"),
    last_polar_reconcile_corrections: count("last_polar_reconcile_corrections"),
    last_polar_reconcile_error: row("last_polar_reconcile_error")?.detail ?? null,
    last_queue_at: at("last_queue_at"),
    last_queue_version: row("last_queue_version")?.detail ?? null,
    queue_lag_s: count("queue_lag_s"),
    last_dead_letter_at: at("last_dead_letter_at"),
    last_cron_at: at("last_cron_at"),
    last_cron: row("last_cron_at")?.detail ?? null,
    last_cron_version: row("last_cron_version")?.detail ?? null,
    paying_uncovered: count("paying_uncovered"),
    polar_webhook_secret: Boolean(env.POLAR_WEBHOOK_SECRET),
    ip_limit: ipLimit,
    version: versionOf(env),
  });
}

/** Re-judges coverage after a write to repos or subscriptions; a failure is logged, never the caller's. */
async function audited(db: D1Database, at: number): Promise<void> {
  try {
    const uncovered = await auditCoverage(db, at);
    console.log(JSON.stringify({ coverage: "audited", paying_uncovered: uncovered }));
  } catch (err) {
    console.error(JSON.stringify({ coverage: "failed", error: String(err) }));
  }
}

/** Logs a reconcile's outcome with what started it; a failure is logged, never thrown. */
function logged(names: { ok: string; failed: string }, trigger: { cron: string } | { requested: string }, work: Promise<unknown>): Promise<void> {
  return work.then(
    (out) => console.log(JSON.stringify({ reconcile: names.ok, ...trigger, ...(out as object) })),
    (err) => console.error(JSON.stringify({ reconcile: names.failed, ...trigger, error: String(err) })),
  );
}

const GITHUB_LOG = { ok: "ok", failed: "failed" };
const POLAR_LOG = { ok: "polar", failed: "polar-failed" };

/**
 * Runs each reconcile a committed batch requested, unless one has succeeded since its latest
 * request, so a redelivered request runs nothing again; coverage is re-judged after any that ran.
 */
async function requestedReconciles(env: Env, requested: ReconcileRequests): Promise<void> {
  const runs = [
    { marker: "reconcile-now", stamp: "last_reconcile_at", names: GITHUB_LOG, run: (at: number) => reconcileInstallations(env, at) },
    { marker: "polar-reconcile-now", stamp: "last_polar_reconcile_at", names: POLAR_LOG, run: (at: number) => reconcilePolar(env, at) },
  ] as const;
  const wanted = runs.filter((r) => requested[r.marker] !== undefined);
  if (wanted.length === 0) return;
  try {
    const { results } = await env.DB.prepare("SELECT name, at FROM sync_state WHERE name IN ('last_reconcile_at', 'last_polar_reconcile_at')").all<{ name: string; at: number }>();
    let ran = false;
    for (const r of wanted) {
      const last = results.find((s) => s.name === r.stamp)?.at ?? null;
      // A reconcile stamps the second it started, so only a later second is sure to follow the request.
      if (last !== null && last > requested[r.marker]!) {
        console.log(JSON.stringify({ reconcile: "already-answered", requested: r.marker, [r.stamp]: last }));
        continue;
      }
      await logged(r.names, { requested: r.marker }, r.run(nowS()));
      ran = true;
    }
    if (ran) await audited(env.DB, nowS());
  } catch (err) {
    console.error(JSON.stringify({ reconcile: "request-failed", requested: wanted.map((r) => r.marker), error: String(err) }));
  }
}

/**
 * Every route Cloudflare serves to the world that meets the per-address cap before anything else.
 * Polar's webhook is public too, and meets the cap only once its signature has failed.
 */
export const CAPPED_ROUTES = ["GET /v1/sync/health", "GET /v1/sync/alerts"];

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const ipLimit = CAPPED_ROUTES.includes(`${req.method} ${url.pathname}`) ? await ipLimitState(env, req) : null;
  if (ipLimit === "refused") return ipLimited();
  if (req.method === "POST" && url.pathname === "/webhook") {
    const read = await readJsonCapped(req, BODY_MAX_WEBHOOK);
    if (!read.ok) return read.reason === "body-too-large" ? new Response("payload-too-large", { status: 413 }) : new Response("malformed-payload", { status: 400 });
    const payload = read.value;
    return applyWebhook(env, githubClient(env), req.headers.get("X-GitHub-Event") ?? "", payload as never, nowS(), req.headers.get("X-GitHub-Delivery"));
  }
  if (req.method === "GET" && url.pathname === "/v1/sync/health") return health(env, ipLimit);
  if (req.method === "GET" && url.pathname === "/v1/sync/alerts") return alertsRoute(env.DB, nowS());
  if (req.method === "POST" && url.pathname === "/v1/sync/polar-webhook") return polarWebhook(req, env, nowS(), () => withinIpLimit(env, req));
  return new Response("not found", { status: 404 });
}

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    return withVersion(await route(req, env), versionOf(env));
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const at = Math.floor(controller.scheduledTime / 1000);
    const cron = controller.cron;
    // Which version a split hands a cron is not documented; last_cron_version answers it from health.
    console.log(JSON.stringify({ invocation: "scheduled", cron, version: versionOf(env) }));
    const run = async () => {
      // Every cron, the hourly one included, stamps before its work, so a stale cron is a stale stamp.
      await env.DB.batch([stamp(env.DB, "last_cron_at", at, cron), stamp(env.DB, "last_cron_version", at, versionOf(env))]).catch((err) =>
        console.error(JSON.stringify({ cron: "stamp-failed", error: String(err) })),
      );
      if (cron === HOURLY_CRON) {
        if (await polarReconcileDue(env.DB, at)) await logged(POLAR_LOG, { cron }, reconcilePolar(env, at));
        return;
      }
      await logged(GITHUB_LOG, { cron }, reconcileInstallations(env, at));
      await logged(POLAR_LOG, { cron }, reconcilePolar(env, at));
      await audited(env.DB, at);
      await pruneIncidents(env.DB, at).then(
        (pruned) => console.log(JSON.stringify({ incidents: "pruned", pruned })),
        (err) => console.error(JSON.stringify({ incidents: "prune-failed", error: String(err) })),
      );
    };
    ctx.waitUntil(run());
  },

  async queue(batch: MessageBatch, env: Env, _ctx: ExecutionContext): Promise<void> {
    console.log(JSON.stringify({ invocation: "queue", messages: batch.messages.length, version: versionOf(env) }));
    await requestedReconciles(env, await consumeWrites(batch, env, nowS()));
  },
};
