// The paid key Worker: answers key requests from all three places a key is asked for, a web
// session's dispatch through the router, a desktop's App user token and an Actions run's OIDC
// token, deciding from D1 reads alone. It writes nothing; the sync Worker is D1's only writer.
import { certBody, refusal, type Env } from "./env.ts";
import { sessionKey } from "./desktop.ts";
import { webhook } from "./web.ts";
import { actionsKey } from "./actions.ts";

export type { Env } from "./env.ts";

function loginConfig(env: Env): Response {
  const web = env.GITHUB_WEB_BASE ?? "https://github.com";
  return Response.json({ client_id: env.GITHUB_APP_CLIENT_ID, device_code_url: `${web}/login/device/code`, token_url: `${web}/login/oauth/access_token` });
}

// GitHub's refresh grant needs the App's client secret, which a binary cannot hold.
async function loginRefresh(req: Request, env: Env): Promise<Response> {
  if (!env.GITHUB_APP_CLIENT_SECRET) return refusal(503, "refresh-not-configured");
  let body: { refresh_token?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return refusal(400, "malformed-body");
  }
  if (typeof body?.refresh_token !== "string" || body.refresh_token.length === 0) return refusal(400, "no-refresh-token");
  const form = new URLSearchParams({ client_id: env.GITHUB_APP_CLIENT_ID, client_secret: env.GITHUB_APP_CLIENT_SECRET, grant_type: "refresh_token", refresh_token: body.refresh_token });
  const res = await fetch(`${env.GITHUB_WEB_BASE ?? "https://github.com"}/login/oauth/access_token`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "claudinite-key" },
    body: form,
  });
  return new Response(res.body, { status: res.status, headers: { "Content-Type": res.headers.get("Content-Type") ?? "application/json" } });
}

async function health(env: Env): Promise<Response> {
  const body = certBody(env);
  let d1: "ok" | "unreadable" = "ok";
  try {
    await env.DB.prepare("SELECT 1").first();
  } catch {
    d1 = "unreadable";
  }
  return Response.json({ ok: true, kid: body.keyId, cert_exp: body.notAfter, d1 });
}

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const route = `${req.method} ${url.pathname}`;
    switch (route) {
      case "POST /webhook":
        return webhook(req, env);
      case "POST /v1/session-key":
        return sessionKey(req, env);
      case "POST /v1/actions-key":
        return actionsKey(req, env);
      case "GET /v1/login/config":
        return loginConfig(env);
      case "POST /v1/login/refresh":
        return loginRefresh(req, env);
      case "GET /v1/key/health":
        return health(env);
      default:
        return new Response("not found", { status: 404 });
    }
  },
};
