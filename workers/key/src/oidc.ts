// Verifies a GitHub Actions OIDC token: RS256 against the key the issuer's JWKS names by kid, then
// the issuer, the audience, the times with the signing spec's skew, and the claims the license
// design pins. The JWKS is cached in the isolate for an hour and refetched on an unknown kid, at
// most once every 30 seconds, so tokens naming made-up kids cannot turn into a fetch each.
import { b64urlDecode, IAT_LEEWAY_S } from "../../../packages/signing/src/index.ts";

export const AUDIENCE = "claudinite";
const JWKS_TTL_S = 3600;
const REFETCH_EVERY_S = 30;

export type TokenRefusal =
  | "token-malformed"
  | "token-unknown-key"
  | "token-signature"
  | "token-issuer"
  | "token-audience"
  | "token-expired"
  | "token-not-yet-valid"
  | "token-claims"
  | "jwks-unavailable";

export interface ActionsClaims {
  repositoryId: number;
  repositoryOwnerId: number;
  repository: string;
  repositoryOwner: string;
  repositoryVisibility: string;
  eventName: string;
  jobWorkflowRef: string;
}

let cache: { issuer: string; at: number; keys: Map<string, JsonWebKey> } | null = null;
let lastRefetchS = -Infinity;

export function resetJwksCache(): void {
  cache = null;
  lastRefetchS = -Infinity;
}

async function fetchJwks(issuer: string, nowS: number): Promise<Map<string, JsonWebKey>> {
  const res = await fetch(`${issuer}/.well-known/jwks`, { headers: { Accept: "application/json", "User-Agent": "claudinite-key" } });
  if (!res.ok) throw new Error(`JWKS answered ${res.status}`);
  const body = (await res.json()) as { keys?: (JsonWebKey & { kid?: unknown })[] };
  const keys = new Map<string, JsonWebKey>();
  for (const k of body.keys ?? []) if (typeof k.kid === "string" && k.kty === "RSA") keys.set(k.kid, k);
  cache = { issuer, at: nowS, keys };
  return keys;
}

async function keyFor(issuer: string, kid: string, nowS: number): Promise<JsonWebKey | undefined> {
  const fresh = cache && cache.issuer === issuer && nowS - cache.at < JWKS_TTL_S;
  if (fresh && cache!.keys.has(kid)) return cache!.keys.get(kid);
  if (fresh) {
    if (nowS - lastRefetchS < REFETCH_EVERY_S) return undefined;
    lastRefetchS = nowS;
  }
  return (await fetchJwks(issuer, nowS)).get(kid);
}

function decodePart(part: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(b64urlDecode(part)));
    return typeof v === "object" && v !== null && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

const DIGITS = /^[1-9][0-9]{0,15}$/;

export async function verifyActionsToken(jwt: string, opts: { issuer: string; nowS: number }): Promise<{ ok: true; claims: ActionsClaims } | { ok: false; reason: TokenRefusal }> {
  const parts = jwt.split(".");
  if (parts.length !== 3) return { ok: false, reason: "token-malformed" };
  const header = decodePart(parts[0]!);
  const c = decodePart(parts[1]!);
  let sig: Uint8Array<ArrayBuffer>;
  try {
    sig = b64urlDecode(parts[2]!);
  } catch {
    return { ok: false, reason: "token-malformed" };
  }
  if (!header || !c || header.alg !== "RS256" || typeof header.kid !== "string") return { ok: false, reason: "token-malformed" };

  let jwk: JsonWebKey | undefined;
  try {
    jwk = await keyFor(opts.issuer, header.kid, opts.nowS);
  } catch (err) {
    console.error(JSON.stringify({ jwksError: String(err) }));
    return { ok: false, reason: "jwks-unavailable" };
  }
  if (!jwk) return { ok: false, reason: "token-unknown-key" };
  const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, signed))) return { ok: false, reason: "token-signature" };

  if (c.iss !== opts.issuer) return { ok: false, reason: "token-issuer" };
  const aud = c.aud;
  if (!(aud === AUDIENCE || (Array.isArray(aud) && aud.includes(AUDIENCE)))) return { ok: false, reason: "token-audience" };
  if (typeof c.exp !== "number" || typeof c.iat !== "number") return { ok: false, reason: "token-claims" };
  if (opts.nowS >= c.exp + IAT_LEEWAY_S) return { ok: false, reason: "token-expired" };
  if (opts.nowS < c.iat - IAT_LEEWAY_S || (typeof c.nbf === "number" && opts.nowS < c.nbf - IAT_LEEWAY_S)) return { ok: false, reason: "token-not-yet-valid" };

  const strings = ["repository_id", "repository_owner_id", "repository", "repository_owner", "repository_visibility", "event_name", "job_workflow_ref"] as const;
  if (strings.some((k) => typeof c[k] !== "string" || (c[k] as string).length === 0)) return { ok: false, reason: "token-claims" };
  const s = c as Record<(typeof strings)[number], string>;
  if (!DIGITS.test(s.repository_id) || !DIGITS.test(s.repository_owner_id)) return { ok: false, reason: "token-claims" };
  return {
    ok: true,
    claims: {
      repositoryId: Number(s.repository_id),
      repositoryOwnerId: Number(s.repository_owner_id),
      repository: s.repository,
      repositoryOwner: s.repository_owner,
      repositoryVisibility: s.repository_visibility,
      eventName: s.event_name,
      jobWorkflowRef: s.job_workflow_ref,
    },
  };
}
