// What the key Worker reads from its environment: the bindings, the issuing key, Polar's, and the
// one usage point each answered request writes.
import { b64urlDecode, type Certificate } from "../../../packages/signing/src/index.ts";
import { capEngineVersion, type IpLimitEnv } from "../../../packages/http/src/index.ts";
import type { VersionEnv } from "../../../packages/version/src/index.ts";
import { keyCountBlobs } from "../../../packages/licensing/src/index.ts";

export interface Env extends VersionEnv, IpLimitEnv {
  DB: D1Database;
  KEY_COUNTS?: AnalyticsEngineDataset;
  OWNER_LIMIT: RateLimit;
  ISSUING_KEY_PRIVATE: string;
  ISSUING_KEY_CERT: string;
  OIDC_ISSUER: string;
  /** The writes queue; the sync Worker consumes it as D1's only writer. */
  WRITES?: Queue;
  POLAR_API_BASE?: string;
  POLAR_ACCESS_TOKEN?: string;
}

export function issuingKey(env: Env): { seed: string; cert: Certificate } {
  return { seed: env.ISSUING_KEY_PRIVATE, cert: JSON.parse(env.ISSUING_KEY_CERT) as Certificate };
}

export function certBody(env: Env): { keyId: string; notAfter: string } {
  return JSON.parse(new TextDecoder().decode(b64urlDecode(issuingKey(env).cert.payload)));
}

export type Path = "actions";

/** One Analytics Engine point per request from a caller something authenticated: index the repo id, blobs in KEY_COUNT_BLOBS order. */
export function countPoint(env: Env, p: { repoId: string; plan: string; outcome: string; ownerType: string; engineVersion: string; path: Path }): void {
  env.KEY_COUNTS?.writeDataPoint({ indexes: [p.repoId], blobs: keyCountBlobs({ ...p, engineVersion: capEngineVersion(p.engineVersion) }), doubles: [1] });
}

export function refusal(status: number, reason: string): Response {
  console.log(JSON.stringify({ refused: reason, status }));
  return Response.json({ refused: reason }, { status });
}

/** The per-owner rate limit, one bucket per owner login in lower case, checked once the OIDC token has authenticated the caller. */
export async function withinOwnerLimit(env: Env, ownerLogin: string): Promise<boolean> {
  const { success } = await env.OWNER_LIMIT.limit({ key: `owner:${ownerLogin.toLowerCase()}` });
  return success;
}
