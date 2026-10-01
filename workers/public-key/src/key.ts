import { FEATURES, signKey, type Certificate, type KeyPayload, type ReleaseStates } from "../../../packages/signing/src/index.ts";
import releaseStates from "../release-states.json";

export const PUBLIC_FEATURES = FEATURES.filter((f) => f !== "fleet");
const SESSION_SECONDS = 7 * 86400;

export interface SessionSubject {
  repoId: number;
  ownerId: number;
  ownerType: "User" | "Organization";
  ownerLogin: string;
  userId: number;
  nonce: string;
}

export async function mintPublicSessionKey(issuingSeed: string, cert: Certificate, s: SessionSubject, nowS: number): Promise<string> {
  const payload: KeyPayload = {
    v: 1,
    typ: "session",
    kid: "",
    repo_id: s.repoId,
    owner_id: s.ownerId,
    owner_type: s.ownerType,
    owner_login: s.ownerLogin,
    plan: "public",
    user_id: s.userId,
    nonce: s.nonce,
    iat: nowS,
    exp: nowS + SESSION_SECONDS,
    state: "ok",
    grace_until: null,
    features: [...PUBLIC_FEATURES],
    release: releaseStates as ReleaseStates,
  };
  return signKey(issuingSeed, cert, payload);
}
