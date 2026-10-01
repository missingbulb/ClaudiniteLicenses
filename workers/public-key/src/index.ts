// The public key Worker: answers a public repo's `claudinite-key-public` dispatch, forwarded by the
// router, with a signed Public session key in a `Claudinite key` check run, and a desktop's
// request with one in the answer. No database; one Analytics Engine data point per answered
// request is its whole record.
import { b64urlDecode, certStanding, type Certificate } from "../../../packages/signing/src/index.ts";
import { createKeyCheckRun, GitHubError, parseKeyDispatch, refusalSummary } from "../../../packages/github-app/src/index.ts";
import { versionOf, withVersion, type VersionEnv } from "../../../packages/version/src/index.ts";
import { publicSessionKey } from "./desktop.ts";
import { mintPublicSessionKey } from "./key.ts";

export interface Env extends VersionEnv {
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  ISSUING_KEY_PRIVATE: string;
  ISSUING_KEY_CERT: string;
  GITHUB_API_BASE?: string;
  KEY_COUNTS?: AnalyticsEngineDataset;
}

type Outcome = "issued" | "refused-private" | "refused-sender" | "github-error";

function refuse(status: number, reason: string, delivery: string | null): Response {
  console.log(JSON.stringify({ refused: reason, delivery }));
  return new Response(reason, { status });
}

function certBody(env: Env): { keyId: string; notAfter: string } {
  const cert = JSON.parse(env.ISSUING_KEY_CERT) as Certificate;
  return JSON.parse(new TextDecoder().decode(b64urlDecode(cert.payload)));
}

async function webhook(req: Request, env: Env): Promise<Response> {
  const delivery = req.headers.get("X-GitHub-Delivery");
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return refuse(400, "malformed-payload", delivery);
  }
  const parsed = parseKeyDispatch(payload);
  const seen = parsed.ok
    ? { repoId: String(parsed.dispatch.repo.id), ownerType: parsed.dispatch.owner.type, engineVersion: parsed.dispatch.engineVersion }
    : parsed.seen;
  const point = (outcome: Outcome) =>
    env.KEY_COUNTS?.writeDataPoint({ indexes: [seen.repoId], blobs: ["public", outcome, seen.ownerType, seen.engineVersion, "web"], doubles: [1] });
  if (!parsed.ok) {
    if (parsed.reason === "sender-not-user") point("refused-sender");
    return refuse(parsed.status, parsed.reason, delivery);
  }
  const { repo, owner, installationId, sender, nonce, head } = parsed.dispatch;

  const nowS = Math.floor(Date.now() / 1000);
  const issued = new Date(nowS * 1000).toISOString();
  let outcome: Outcome;
  let output: { title: string; summary: string; text?: string };
  if (repo.private) {
    outcome = "refused-private";
    output = { title: "Claudinite key refused", summary: refusalSummary("refused-private", "this repo is private; the Public plan covers public repos only") };
  } else {
    outcome = "issued";
    const key = await mintPublicSessionKey(
      env.ISSUING_KEY_PRIVATE,
      JSON.parse(env.ISSUING_KEY_CERT) as Certificate,
      { repoId: repo.id, ownerId: owner.id, ownerType: owner.type, ownerLogin: owner.login, userId: sender.id, nonce },
      nowS,
    );
    output = { title: "Claudinite key", summary: `public key for @${sender.login} (sender type User), issued ${issued}`, text: key };
  }

  try {
    await createKeyCheckRun(
      { base: env.GITHUB_API_BASE ?? "https://api.github.com", userAgent: "claudinite-public-key", appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY },
      { installationId, repoName: repo.name, fullName: repo.fullName, head, nonce },
      output,
      nowS,
    );
  } catch (err) {
    if (!(err instanceof GitHubError)) throw err;
    console.error(JSON.stringify({ githubError: err.call, status: err.status, body: err.body, marker: err.secondaryRateLimit ? "secondary-rate-limit" : undefined, delivery }));
    point("github-error");
    return new Response(`github-error: ${err.call} ${err.status}`, { status: 502 });
  }
  point(outcome);
  return new Response(outcome, { status: 201 });
}

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "POST" && url.pathname === "/webhook") return webhook(req, env);
  if (req.method === "POST" && url.pathname === "/v1/public/session-key") return publicSessionKey(req, env);
  if (req.method === "GET" && url.pathname === "/v1/public/health") {
    // Judges its own certificate, so a status-only monitor pages on it without reading the body.
    const body = certBody(env);
    const cert = certStanding(body.notAfter, new Date());
    const alerts = cert.alert ? [cert.alert] : [];
    return Response.json(
      { ok: alerts.length === 0, kid: body.keyId, cert_exp: body.notAfter, cert_days_left: cert.daysLeft, version: versionOf(env), alerts },
      { status: alerts.length === 0 ? 200 : 503 },
    );
  }
  return new Response("not found", { status: 404 });
}

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    return withVersion(await route(req, env), versionOf(env));
  },
};
