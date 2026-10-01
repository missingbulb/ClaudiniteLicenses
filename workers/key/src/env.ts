// What every path of the key Worker reads from its environment: the bindings, the issuing key,
// the App's GitHub client, and the one usage point each answered request writes.
import type { GitHubClient } from "../../../packages/github-app/src/index.ts";
import { b64urlDecode, type Certificate } from "../../../packages/signing/src/index.ts";

export interface Env {
  DB: D1Database;
  KEY_COUNTS?: AnalyticsEngineDataset;
  OWNER_LIMIT: RateLimit;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_APP_CLIENT_ID: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  ISSUING_KEY_PRIVATE: string;
  ISSUING_KEY_CERT: string;
  OIDC_ISSUER: string;
  GITHUB_API_BASE?: string;
  GITHUB_WEB_BASE?: string;
  FAIL_OPEN?: string;
}

export function githubClient(env: Env): GitHubClient {
  return { base: env.GITHUB_API_BASE ?? "https://api.github.com", userAgent: "claudinite-key", appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY };
}

export function issuingKey(env: Env): { seed: string; cert: Certificate } {
  return { seed: env.ISSUING_KEY_PRIVATE, cert: JSON.parse(env.ISSUING_KEY_CERT) as Certificate };
}

export function certBody(env: Env): { keyId: string; notAfter: string } {
  return JSON.parse(new TextDecoder().decode(b64urlDecode(issuingKey(env).cert.payload)));
}

export type Path = "web" | "desktop" | "actions";

/** One Analytics Engine point per answered request: index the repo id, blobs plan, outcome, owner type, engine version and path. */
export function countPoint(env: Env, p: { repoId: string; plan: string; outcome: string; ownerType: string; engineVersion: string; path: Path }): void {
  env.KEY_COUNTS?.writeDataPoint({ indexes: [p.repoId], blobs: [p.plan, p.outcome, p.ownerType, p.engineVersion, p.path], doubles: [1] });
}

export function refusal(status: number, reason: string): Response {
  console.log(JSON.stringify({ refused: reason, status }));
  return Response.json({ refused: reason }, { status });
}

/** The per-owner rate limit, keyed by the owner's login in lower case so the desktop path can check it before any GitHub call. */
export async function withinOwnerLimit(env: Env, ownerLogin: string): Promise<boolean> {
  const { success } = await env.OWNER_LIMIT.limit({ key: `owner:${ownerLogin.toLowerCase()}` });
  return success;
}
