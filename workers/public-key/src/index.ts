// The public key Worker: answers a public repo's `claudinite-key-public` dispatch, forwarded by the
// router, with a signed Public session key in a `Claudinite key` check run. No database; one
// Analytics Engine data point per answered request is its whole record.
import { b64urlDecode, type Certificate } from "../../../packages/signing/src/index.ts";
import { createKeyCheckRun, GitHubError } from "../../../packages/github-app/src/index.ts";
import { mintPublicSessionKey } from "./key.ts";

export interface Env {
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  ISSUING_KEY_PRIVATE: string;
  ISSUING_KEY_CERT: string;
  GITHUB_API_BASE?: string;
  KEY_COUNTS?: AnalyticsEngineDataset;
}

type Outcome = "issued" | "refused-private" | "refused-sender" | "github-error";

interface Dispatch {
  repository?: { id?: unknown; name?: unknown; full_name?: unknown; private?: unknown; owner?: { id?: unknown; login?: unknown; type?: unknown } };
  installation?: { id?: unknown };
  sender?: { id?: unknown; login?: unknown; type?: unknown };
  client_payload?: { nonce?: unknown; engine_version?: unknown; head?: unknown };
}

const NONCE = /^[A-Za-z0-9_-]{16,64}$/;
const HEAD = /^[0-9a-f]{40}$/;

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
  let d: Dispatch;
  try {
    d = (await req.json()) as Dispatch;
  } catch {
    return refuse(400, "malformed-payload", delivery);
  }
  const repo = d.repository;
  const owner = repo?.owner;
  const engineVersion = typeof d.client_payload?.engine_version === "string" ? d.client_payload.engine_version : "unknown";
  const point = (outcome: Outcome) =>
    env.KEY_COUNTS?.writeDataPoint({
      indexes: [String(repo?.id ?? "unknown")],
      blobs: ["public", outcome, typeof owner?.type === "string" ? owner.type : "unknown", engineVersion],
      doubles: [1],
    });

  if (d.sender?.type !== "User") {
    point("refused-sender");
    return refuse(403, "sender-not-user", delivery);
  }
  const nonce = d.client_payload?.nonce;
  const head = d.client_payload?.head;
  const installationId = d.installation?.id;
  if (typeof nonce !== "string" || !NONCE.test(nonce)) return refuse(400, "bad-nonce", delivery);
  if (typeof head !== "string" || !HEAD.test(head)) return refuse(400, "bad-head", delivery);
  if (typeof installationId !== "number") return refuse(400, "no-installation", delivery);
  if (
    typeof repo?.id !== "number" ||
    typeof repo.name !== "string" ||
    typeof repo.full_name !== "string" ||
    typeof owner?.id !== "number" ||
    typeof owner.login !== "string" ||
    (owner.type !== "User" && owner.type !== "Organization") ||
    typeof d.sender.id !== "number" ||
    typeof d.sender.login !== "string"
  ) {
    return refuse(400, "malformed-payload", delivery);
  }

  const nowS = Math.floor(Date.now() / 1000);
  const issued = new Date(nowS * 1000).toISOString();
  let outcome: Outcome;
  let output: { title: string; summary: string; text?: string };
  if (repo.private === true) {
    outcome = "refused-private";
    output = { title: "Claudinite key refused", summary: "this repo is private; the Public plan covers public repos only" };
  } else {
    outcome = "issued";
    const key = await mintPublicSessionKey(
      env.ISSUING_KEY_PRIVATE,
      JSON.parse(env.ISSUING_KEY_CERT) as Certificate,
      { repoId: repo.id, ownerId: owner.id, ownerType: owner.type, ownerLogin: owner.login, userId: d.sender.id, nonce },
      nowS,
    );
    output = { title: "Claudinite key", summary: `public key for @${d.sender.login} (sender type ${d.sender.type}), issued ${issued}`, text: key };
  }

  try {
    await createKeyCheckRun(
      { base: env.GITHUB_API_BASE ?? "https://api.github.com", userAgent: "claudinite-public-key", appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY },
      { installationId, repoName: repo.name, fullName: repo.full_name, head, nonce },
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

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/webhook") return webhook(req, env);
    if (req.method === "GET" && url.pathname === "/v1/public/health") {
      const body = certBody(env);
      return Response.json({ ok: true, kid: body.keyId, cert_exp: body.notAfter });
    }
    return new Response("not found", { status: 404 });
  },
};
