import { generateKeyPair, issueCertificate, type Certificate, type KeyPayload, type Use } from "../src/index.ts";

export const DAY = 86400;
export const NOW = new Date("2026-06-01T00:00:00Z");
export const NOW_S = Math.floor(NOW.getTime() / 1000);

export async function devChain() {
  const root = await generateKeyPair();
  const standby = await generateKeyPair();
  const stranger = await generateKeyPair();
  const issuing = await generateKeyPair();
  const nb = new Date("2026-05-15T00:00:00Z");
  const na = new Date("2026-08-01T00:00:00Z");
  const certify = (by: { seed: string }, use: Use, notBefore = nb, notAfter = na): Promise<Certificate> =>
    issueCertificate(by.seed, issuing.publicKey, use, notBefore, notAfter);
  return { root, standby, stranger, issuing, certify, nb, na };
}

export function payload(over: Partial<KeyPayload> = {}): KeyPayload {
  return {
    v: 1,
    typ: "session",
    kid: "",
    repo_id: 101,
    owner_id: 202,
    owner_type: "User",
    owner_login: "octo",
    plan: "public",
    user_id: 303,
    nonce: "n0nce-n0nce-n0nce",
    iat: NOW_S - 60,
    exp: NOW_S - 60 + 7 * DAY,
    state: "ok",
    grace_until: null,
    features: ["work-checks"],
    release: { held: [], revoked: [], security_fixes: [], pack_index_serial: 0, pack_keys: [] },
    ...over,
  };
}
