// The paid key Worker: answers key requests from all three places a key is asked for, a web
// session's dispatch through the router, a desktop's App user token and an Actions run's OIDC
// token, deciding from D1 reads alone, and exchanges an Actions key for an item grant. It writes
// nothing to D1: each key's records go onto the writes queue the sync Worker consumes.
import { certStanding } from "../../../packages/signing/src/index.ts";
import { BODY_MAX_JSON, ipLimited, readJsonCapped, withinIpLimit } from "../../../packages/http/src/index.ts";
import { certBody, failOpenEnabled, refusal, trustRoots, type Env } from "./env.ts";
import { sessionKey } from "./desktop.ts";
import { webhook } from "./web.ts";
import { actionsKey } from "./actions.ts";
import { itemGrant } from "./grant.ts";
import { versionOf, withVersion } from "../../../packages/version/src/index.ts";

export type { Env } from "./env.ts";

function loginConfig(env: Env): Response {
  const web = env.GITHUB_WEB_BASE ?? "https://github.com";
  return Response.json({ client_id: env.GITHUB_APP_CLIENT_ID, device_code_url: `${web}/login/device/code`, token_url: `${web}/login/oauth/access_token` });
}

// GitHub's refresh grant needs the App's client secret, which a binary cannot hold.
async function loginRefresh(req: Request, env: Env): Promise<Response> {
  const read = await readJsonCapped(req, BODY_MAX_JSON);
  if (!read.ok) return refusal(read.reason === "body-too-large" ? 413 : 400, read.reason);
  const body = read.value as { refresh_token?: unknown } | null;
  // A body with no token is refused the same way configured or not, so the probe can judge the route.
  if (typeof body?.refresh_token !== "string" || body.refresh_token.length === 0) return refusal(400, "no-refresh-token");
  if (!env.GITHUB_APP_CLIENT_SECRET) return refusal(503, "refresh-not-configured");
  const form = new URLSearchParams({ client_id: env.GITHUB_APP_CLIENT_ID, client_secret: env.GITHUB_APP_CLIENT_SECRET, grant_type: "refresh_token", refresh_token: body.refresh_token });
  const res = await fetch(`${env.GITHUB_WEB_BASE ?? "https://github.com"}/login/oauth/access_token`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "claudinite-key" },
    body: form,
  });
  return new Response(res.body, { status: res.status, headers: { "Content-Type": res.headers.get("Content-Type") ?? "application/json" } });
}

/** Judges its own certificate, trust roots and D1, answering 503 while any of them is wrong, and says whether a key fails open. */
async function health(env: Env): Promise<Response> {
  const body = certBody(env);
  let d1: "ok" | "unreadable" = "ok";
  try {
    await env.DB.prepare("SELECT 1").first();
  } catch {
    d1 = "unreadable";
  }
  const cert = certStanding(body.notAfter, new Date());
  const roots = "invalid" in trustRoots(env) ? "invalid" : "ok";
  const alerts = [cert.alert, roots === "invalid" ? "trust-roots-invalid" : null, d1 === "unreadable" ? "d1-unreadable" : null].filter((a) => a !== null);
  return Response.json(
    {
      ok: alerts.length === 0,
      kid: body.keyId,
      cert_exp: body.notAfter,
      cert_days_left: cert.daysLeft,
      d1,
      queue: env.WRITES ? "bound" : "unbound",
      polar: env.POLAR_API_BASE && env.POLAR_ACCESS_TOKEN ? "configured" : "unconfigured",
      trust_roots: roots,
      fail_open: failOpenEnabled(env),
      version: versionOf(env),
      alerts,
    },
    { status: alerts.length === 0 ? 200 : 503 },
  );
}

/** Every route Cloudflare serves to the world: each meets the per-address cap before anything else. */
export const PUBLIC_ROUTES = ["POST /v1/session-key", "POST /v1/actions-key", "POST /v1/item-grant", "GET /v1/login/config", "POST /v1/login/refresh", "GET /v1/key/health"];

async function route(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const at = `${req.method} ${url.pathname}`;
  if (PUBLIC_ROUTES.includes(at) && !(await withinIpLimit(env, req))) return ipLimited();
  switch (at) {
    case "POST /webhook":
      return webhook(req, env, ctx);
    case "POST /v1/session-key":
      return sessionKey(req, env, ctx);
    case "POST /v1/actions-key":
      return actionsKey(req, env, ctx);
    case "POST /v1/item-grant":
      return itemGrant(req, env);
    case "GET /v1/login/config":
      return loginConfig(env);
    case "POST /v1/login/refresh":
      return loginRefresh(req, env);
    case "GET /v1/key/health":
      return health(env);
    default:
      return new Response("not found", { status: 404 });
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return withVersion(await route(req, env, ctx), versionOf(env));
  },
};
