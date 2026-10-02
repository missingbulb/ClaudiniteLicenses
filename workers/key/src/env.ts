// What every path of the key Worker reads from its environment: the bindings, the issuing key,
// the App's GitHub client, Polar's, and the one usage point each answered request writes.
import type { GitHubClient } from "../../../packages/github-app/src/index.ts";
import { b64urlDecode, type Certificate } from "../../../packages/signing/src/index.ts";
import { capEngineVersion, type IpLimitEnv } from "../../../packages/http/src/index.ts";
import type { VersionEnv } from "../../../packages/version/src/index.ts";
import { keyCountBlobs } from "../../../packages/licensing/src/index.ts";

export interface Env extends VersionEnv, IpLimitEnv {
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
  /** "true" lets a session key fail open while D1 is unreadable; deploy.yml can override the committed value with KEY_FAIL_OPEN. */
  FAIL_OPEN?: string;
  /** The writes queue; the sync Worker consumes it as D1's only writer. */
  WRITES?: Queue;
  POLAR_API_BASE?: string;
  POLAR_ACCESS_TOKEN?: string;
  /** A JSON array of the root public keys an Actions key must chain to before it buys a grant. */
  TRUST_ROOTS: string;
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

export type Path = "web" | "desktop" | "actions" | "grant";

export type TrustRoots = { roots: string[] } | { invalid: string };

let rootsParsed: { raw: string; value: TrustRoots } | null = null;

/** TRUST_ROOTS parsed once per isolate: a JSON array of non-empty strings, or why it is not one. */
export function trustRoots(env: { TRUST_ROOTS?: string }): TrustRoots {
  const raw = env.TRUST_ROOTS ?? "";
  if (rootsParsed?.raw === raw) return rootsParsed.value;
  let value: TrustRoots;
  try {
    const parsed: unknown = JSON.parse(raw);
    value =
      Array.isArray(parsed) && parsed.length > 0 && parsed.every((r) => typeof r === "string" && r.length > 0)
        ? { roots: parsed as string[] }
        : { invalid: "not a non-empty JSON array of non-empty strings" };
  } catch {
    value = { invalid: "not JSON" };
  }
  rootsParsed = { raw, value };
  return value;
}

/** Whether a session key is issued while D1 is unreadable: only the exact string "true" turns it on. */
export function failOpenEnabled(env: { FAIL_OPEN?: string }): boolean {
  return env.FAIL_OPEN === "true";
}

/** One Analytics Engine point per request from a caller something authenticated: index the repo id, blobs in KEY_COUNT_BLOBS order. */
export function countPoint(env: Env, p: { repoId: string; plan: string; outcome: string; ownerType: string; engineVersion: string; path: Path }): void {
  env.KEY_COUNTS?.writeDataPoint({ indexes: [p.repoId], blobs: keyCountBlobs({ ...p, engineVersion: capEngineVersion(p.engineVersion) }), doubles: [1] });
}

export function refusal(status: number, reason: string): Response {
  console.log(JSON.stringify({ refused: reason, status }));
  return Response.json({ refused: reason }, { status });
}

/** The per-owner rate limit, one bucket per owner login in lower case, checked once the caller is authenticated: by GitHub on the desktop path, by the OIDC token on the Actions path. */
export async function withinOwnerLimit(env: Env, ownerLogin: string): Promise<boolean> {
  const { success } = await env.OWNER_LIMIT.limit({ key: `owner:${ownerLogin.toLowerCase()}` });
  return success;
}
