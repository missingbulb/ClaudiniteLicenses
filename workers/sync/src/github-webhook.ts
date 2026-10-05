// The Claudinite App's one webhook address, `POST /github-webhook`: GitHub's HMAC over the body with
// the App's webhook secret is its gate, after the 1 MiB body cap. `ping` is answered here; the
// installation and repository events write repos; every other event, a key dispatch included, is
// acknowledged with no write. GitHub's few delivery addresses meet no per-address cap.
import { BODY_MAX_WEBHOOK, readCapped } from "../../../packages/http/src/index.ts";
import type { GitHubClient } from "../../../packages/github-app/src/index.ts";
import { applyWebhook, type WebhookEnv } from "./repos.ts";

export interface GitHubWebhookEnv extends WebhookEnv {
  GITHUB_APP_WEBHOOK_SECRET?: string;
}

const REPO_EVENTS = ["installation", "installation_repositories", "repository"];

async function signatureMatches(secret: string, body: Uint8Array<ArrayBuffer>, header: string | null): Promise<boolean> {
  if (!header || !/^sha256=[0-9a-f]{64}$/.test(header)) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const given = Uint8Array.from(header.slice(7).match(/../g)!, (h) => parseInt(h, 16));
  // HMAC verify compares in constant time.
  return crypto.subtle.verify("HMAC", key, given, body);
}

export async function githubWebhook(req: Request, env: GitHubWebhookEnv, gh: GitHubClient, nowS: number): Promise<Response> {
  const body = await readCapped(req, BODY_MAX_WEBHOOK);
  if (body === null) return new Response("payload-too-large", { status: 413 });
  const delivery = req.headers.get("X-GitHub-Delivery");
  if (!env.GITHUB_APP_WEBHOOK_SECRET) {
    console.log(JSON.stringify({ refused: "secret-unset", delivery }));
    return new Response("secret-unset", { status: 401 });
  }
  if (!(await signatureMatches(env.GITHUB_APP_WEBHOOK_SECRET, body, req.headers.get("X-Hub-Signature-256")))) {
    console.log(JSON.stringify({ refused: "bad-signature", delivery }));
    return new Response("bad-signature", { status: 401 });
  }
  const event = req.headers.get("X-GitHub-Event") ?? "";
  if (event === "ping") return new Response("pong", { status: 200 });
  if (!REPO_EVENTS.includes(event)) return new Response(null, { status: 204 });
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return new Response("malformed-payload", { status: 400 });
  }
  return applyWebhook(env, gh, event, payload as never, nowS, delivery);
}
