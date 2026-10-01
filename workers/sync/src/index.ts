// The sync Worker, the only writer of D1: the Claudinite App's installation and repository
// webhooks, forwarded by the router, keep the repos table current, and the nightly reconcile
// repairs whatever a lost or reordered webhook left. It holds no signing key.
import { GitHubError } from "../../../packages/github-app/src/index.ts";
import { githubClient, reconcileInstallations } from "./reconcile.ts";
import { applyWebhook } from "./repos.ts";

export interface Env {
  DB: D1Database;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  SYNC_ADMIN_TOKEN?: string;
  GITHUB_API_BASE?: string;
}

const nowS = () => Math.floor(Date.now() / 1000);

async function bearerMatches(req: Request, secret: string | undefined): Promise<boolean> {
  const given = /^Bearer (.+)$/.exec(req.headers.get("Authorization") ?? "")?.[1];
  if (!secret || !given) return false;
  // Compares digests, so the comparison takes the same time whatever the token.
  const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([digest(given), digest(secret)]);
  return a.every((x, i) => x === b[i]);
}

async function stampAt(db: D1Database, name: string): Promise<{ at: number; detail: string | null } | null> {
  return db.prepare("SELECT at, detail FROM sync_state WHERE name = ?").bind(name).first<{ at: number; detail: string | null }>();
}

async function health(env: Env): Promise<Response> {
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM repos").first<{ n: number }>();
  const webhook = await stampAt(env.DB, "last_webhook_at");
  const reconcile = await stampAt(env.DB, "last_reconcile_at");
  const corrections = await stampAt(env.DB, "last_reconcile_corrections");
  return Response.json({
    ok: true,
    repos: count?.n ?? 0,
    last_webhook_at: webhook?.at ?? null,
    last_reconcile_at: reconcile?.at ?? null,
    last_reconcile_corrections: corrections?.detail == null ? null : Number(corrections.detail),
  });
}

async function reconcileNow(env: Env): Promise<Response> {
  try {
    const out = await reconcileInstallations(env, nowS());
    console.log(JSON.stringify({ reconcile: "ok", ...out }));
    return Response.json({ ok: true, ...out });
  } catch (err) {
    if (!(err instanceof GitHubError)) throw err;
    console.error(JSON.stringify({ reconcile: "failed", githubError: err.call, status: err.status }));
    return Response.json({ ok: false, error: `${err.call} answered ${err.status}` }, { status: 502 });
  }
}

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/webhook") {
      let payload: unknown;
      try {
        payload = await req.json();
      } catch {
        return new Response("malformed-payload", { status: 400 });
      }
      return applyWebhook(env, githubClient(env), req.headers.get("X-GitHub-Event") ?? "", payload as never, nowS(), req.headers.get("X-GitHub-Delivery"));
    }
    if (req.method === "GET" && url.pathname === "/v1/sync/health") return health(env);
    if (req.method === "POST" && url.pathname === "/v1/sync/reconcile") {
      if (!(await bearerMatches(req, env.SYNC_ADMIN_TOKEN))) return new Response("unauthorized", { status: 401 });
      return reconcileNow(env);
    }
    return new Response("not found", { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(reconcileInstallations(env, Math.floor(controller.scheduledTime / 1000)).then((out) => console.log(JSON.stringify({ reconcile: "ok", cron: controller.cron, ...out }))));
  },
};
