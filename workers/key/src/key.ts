import { signKey, type Certificate, type KeyPayload, type KeySeats, type Plan, type ReleaseStates } from "../../../packages/signing/src/index.ts";
import releaseStates from "../release-states.json";

const SESSION_SECONDS = 7 * 86400;
const ACTIONS_SECONDS = 6 * 3600;
const GRANT_SECONDS = 6 * 3600;

interface Subject {
  repoId: number;
  ownerId: number;
  ownerType: "User" | "Organization";
  ownerLogin: string;
  plan: Plan;
  state: KeyPayload["state"];
  graceUntil: number | null;
  features: string[];
  seats: KeySeats | null;
  checkoutUrl: string | null;
  portalUrl: string | null;
  notice: string | null;
}

export type KeySubject =
  | (Subject & { typ: "session"; userId: number; nonce: string })
  | (Subject & { typ: "actions" })
  /** `notAfter`: the Actions key's exp, which a grant never outlives. */
  | (Subject & { typ: "grant"; issue: number; notAfter: number });

function expiry(s: KeySubject, nowS: number): number {
  if (s.typ === "session") return nowS + SESSION_SECONDS;
  if (s.typ === "actions") return nowS + ACTIONS_SECONDS;
  return Math.min(nowS + GRANT_SECONDS, s.notAfter);
}

/** Signs a session key (7 days, bound to its user and nonce), an Actions key (6 hours) or an item grant (6 hours at most) with the license issuing key. */
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
    exp: expiry(s, nowS),
    state: s.state,
    grace_until: s.graceUntil,
    features: s.features,
    release: releaseStates as ReleaseStates,
    seats: s.seats,
    checkout_url: s.checkoutUrl,
    portal_url: s.portalUrl,
    notice: s.notice,
    ...(s.typ === "grant" ? { issue: s.issue } : {}),
  };
  return signKey(issuingSeed, cert, payload);
}

/** The licence fields of a key, from its resolution and links. */
export function licenceFields(r: { plan: Plan; state: KeyPayload["state"]; grace_until: number | null; features: string[]; seats: KeySeats | null; notice: string | null }, links: { checkout_url: string | null; portal_url: string | null }) {
  return { plan: r.plan, state: r.state, graceUntil: r.grace_until, features: r.features, seats: r.seats, checkoutUrl: links.checkout_url, portalUrl: links.portal_url, notice: r.notice };
}
