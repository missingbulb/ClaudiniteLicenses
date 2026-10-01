import { signKey, type Certificate, type KeyPayload, type Plan, type ReleaseStates } from "../../../packages/signing/src/index.ts";
import releaseStates from "../release-states.json";

const SESSION_SECONDS = 7 * 86400;
const ACTIONS_SECONDS = 6 * 3600;

interface Subject {
  repoId: number;
  ownerId: number;
  ownerType: "User" | "Organization";
  ownerLogin: string;
  plan: Plan;
  state: KeyPayload["state"];
  features: string[];
}

export type KeySubject = (Subject & { typ: "session"; userId: number; nonce: string }) | (Subject & { typ: "actions" });

/** Signs a session key (7 days, bound to its user and nonce) or an Actions key (6 hours) with the license issuing key. */
export async function mintKey(issuingSeed: string, cert: Certificate, s: KeySubject, nowS: number): Promise<string> {
  const payload: KeyPayload = {
    v: 1,
    typ: s.typ,
    kid: "",
    repo_id: s.repoId,
    owner_id: s.ownerId,
    owner_type: s.ownerType,
    owner_login: s.ownerLogin,
    plan: s.plan,
    ...(s.typ === "session" ? { user_id: s.userId, nonce: s.nonce } : {}),
    iat: nowS,
    exp: nowS + (s.typ === "session" ? SESSION_SECONDS : ACTIONS_SECONDS),
    state: s.state,
    grace_until: null,
    features: s.features,
    release: releaseStates as ReleaseStates,
  };
  return signKey(issuingSeed, cert, payload);
}
