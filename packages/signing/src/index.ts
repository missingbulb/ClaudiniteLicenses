// The license key and certificate format every Worker and the cn binary share. The certificate
// encoding is ClaudiniteEngine's (shared/sign); the key envelope is specified in this package's
// README.md. Only WebCrypto is used, so the same code runs in Workers and in Node 22.

export const CERT_DOMAIN = "claudinite-cert-v1\n";
export const LICENSE_DOMAIN = "claudinite-license-v1\n";

const DAY_MS = 86_400_000;
/** How far ahead of the verifier's clock a key's `iat` may be, in seconds. */
export const IAT_LEEWAY_S = 300;
const ABSOLUTE_MAX_VALIDITY_MS = 400 * DAY_MS;

export type Use = "manifest" | "packs" | "license" | "license-public";

const MAX_VALIDITY_DAYS: Record<Use, number> = { manifest: 365, packs: 90, license: 90, "license-public": 90 };

export const PLANS = ["public", "private-repo", "personal", "organization", "internal"] as const;
export type Plan = (typeof PLANS)[number];

export const FEATURES = ["work-checks", "forced-skill-loading", "in-session-growth", "claudinite-tasks", "updates", "fleet"] as const;
export type Feature = (typeof FEATURES)[number];

export interface Certificate {
  payload: string;
  signature: string;
}

export interface CertificateBody {
  v: 1;
  keyId: string;
  publicKey: string;
  use: Use;
  issuer: string;
  notBefore: string;
  notAfter: string;
}

export interface ReleaseStates {
  held: string[];
  revoked: string[];
  security_fixes: string[];
  pack_index_serial: number;
  pack_keys: string[];
}

export interface KeyPayload {
  v: 1;
  typ: "session" | "actions" | "grant";
  kid: string;
  repo_id: number;
  owner_id: number;
  owner_type: "User" | "Organization";
  owner_login: string;
  plan: Plan;
  user_id?: number;
  nonce?: string;
  iat: number;
  exp: number;
  state: "ok" | "grace" | "degraded" | "unverified";
  grace_until: number | null;
  features: string[];
  release: ReleaseStates;
}

export interface LicenseKey {
  certificate: Certificate;
  payload: string;
  signature: string;
}

export type Reason =
  | "shape"
  | "untrusted-root"
  | "cert-key-id"
  | "cert-validity"
  | "cert-not-yet-valid"
  | "cert-expired"
  | "kid-mismatch"
  | "bad-signature"
  | "key-not-yet-valid"
  | "key-expired"
  | "purpose";

export type Verdict<T> = { ok: true; payload: T } | { ok: false; reason: Reason };

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Bytes {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("not base64url");
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Bytes backed by a plain ArrayBuffer, which is what WebCrypto accepts. */
export type Bytes = Uint8Array<ArrayBuffer>;

const utf8 = new TextEncoder();

function concat(a: Uint8Array, b: Uint8Array): Bytes {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export async function keyId(publicKey: Bytes): Promise<string> {
  const sum = new Uint8Array(await crypto.subtle.digest("SHA-256", publicKey));
  return Array.from(sum.subarray(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

// An Ed25519 PKCS#8 document is this fixed prefix followed by the 32-byte seed.
const PKCS8_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

/** Imports a private key in the engine's key-file form: the base64url 32-byte seed. */
export async function importPrivateKey(seed: string): Promise<CryptoKey> {
  const raw = b64urlDecode(seed.trim());
  if (raw.length !== 32) throw new Error("not an Ed25519 private key (want a 32-byte base64url seed)");
  return crypto.subtle.importKey("pkcs8", concat(PKCS8_PREFIX, raw), { name: "Ed25519" }, true, ["sign"]);
}

export async function publicKeyOf(seed: string): Promise<string> {
  const jwk = (await crypto.subtle.exportKey("jwk", await importPrivateKey(seed))) as JsonWebKey;
  if (typeof jwk.x !== "string") throw new Error("Ed25519 key export carried no public half");
  return jwk.x;
}

export async function generateKeyPair(): Promise<{ seed: string; publicKey: string }> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  const pub = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  return { seed: b64urlEncode(pkcs8.subarray(PKCS8_PREFIX.length)), publicKey: b64urlEncode(pub) };
}

async function sign(seed: string, message: Bytes): Promise<string> {
  return b64urlEncode(new Uint8Array(await crypto.subtle.sign("Ed25519", await importPrivateKey(seed), message)));
}

async function verifySig(publicKey: Bytes, message: Bytes, signature: Bytes): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, signature, message);
  } catch {
    return false;
  }
}

function rfc3339(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function isUse(u: unknown): u is Use {
  return typeof u === "string" && Object.hasOwn(MAX_VALIDITY_DAYS, u);
}

export async function issueCertificate(rootSeed: string, subject: string, use: Use, notBefore: Date, notAfter: Date): Promise<Certificate> {
  if (!isUse(use)) throw new Error(`unknown certificate use ${JSON.stringify(use)} (want manifest, packs, license or license-public)`);
  if (notAfter <= notBefore) throw new Error("notAfter must be after notBefore");
  const cap = MAX_VALIDITY_DAYS[use];
  if (notAfter.getTime() - notBefore.getTime() > cap * DAY_MS) throw new Error(`use ${use} is capped at ${cap} days`);
  const subjectBytes = b64urlDecode(subject);
  const body: CertificateBody = {
    v: 1,
    keyId: await keyId(subjectBytes),
    publicKey: b64urlEncode(subjectBytes),
    use,
    issuer: await keyId(b64urlDecode(await publicKeyOf(rootSeed))),
    notBefore: rfc3339(notBefore),
    notAfter: rfc3339(notAfter),
  };
  const bytes = utf8.encode(JSON.stringify(body));
  return { payload: b64urlEncode(bytes), signature: await sign(rootSeed, concat(utf8.encode(CERT_DOMAIN), bytes)) };
}

const CERT_BODY_KEYS = ["issuer", "keyId", "notAfter", "notBefore", "publicKey", "use", "v"];
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function decodeJson(b64: unknown): { bytes: Bytes; value: unknown } | null {
  if (typeof b64 !== "string") return null;
  try {
    const bytes = b64urlDecode(b64);
    return { bytes, value: JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)) };
  } catch {
    return null;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Checks a certificate in the engine's order: signed by one of `roots` (base64url raw public keys),
 * version 1, keyId matching publicKey, validity at most 400 days and covering `now`. With `use`,
 * the certificate's use must equal it (reason `purpose`); without, any of the four uses passes.
 */
export async function verifyCertificate(cert: unknown, roots: string[], use: Use | null, now: Date): Promise<Verdict<CertificateBody>> {
  if (!isObject(cert) || typeof cert.signature !== "string") return { ok: false, reason: "shape" };
  const decoded = decodeJson(cert.payload);
  if (!decoded || !isObject(decoded.value)) return { ok: false, reason: "shape" };
  const b = decoded.value;
  if (Object.keys(b).sort().join() !== CERT_BODY_KEYS.join()) return { ok: false, reason: "shape" };
  let sig: Bytes;
  try {
    sig = b64urlDecode(cert.signature);
  } catch {
    return { ok: false, reason: "shape" };
  }
  let signer: Bytes | undefined;
  for (const r of roots) {
    const raw = b64urlDecode(r);
    if ((await keyId(raw)) === b.issuer) signer = raw;
  }
  if (!signer || !(await verifySig(signer, concat(utf8.encode(CERT_DOMAIN), decoded.bytes), sig))) return { ok: false, reason: "untrusted-root" };
  if (b.v !== 1 || !isUse(b.use) || typeof b.publicKey !== "string") return { ok: false, reason: "shape" };
  if (use !== null && b.use !== use) return { ok: false, reason: "purpose" };
  let subject: Bytes;
  try {
    subject = b64urlDecode(b.publicKey);
  } catch {
    return { ok: false, reason: "shape" };
  }
  if (subject.length !== 32 || (await keyId(subject)) !== b.keyId) return { ok: false, reason: "cert-key-id" };
  if (typeof b.notBefore !== "string" || typeof b.notAfter !== "string" || !RFC3339_UTC.test(b.notBefore) || !RFC3339_UTC.test(b.notAfter)) {
    return { ok: false, reason: "shape" };
  }
  const nb = Date.parse(b.notBefore);
  const na = Date.parse(b.notAfter);
  if (!(na > nb) || na - nb > ABSOLUTE_MAX_VALIDITY_MS) return { ok: false, reason: "cert-validity" };
  if (now.getTime() < nb) return { ok: false, reason: "cert-not-yet-valid" };
  if (now.getTime() > na) return { ok: false, reason: "cert-expired" };
  return { ok: true, payload: b as unknown as CertificateBody };
}

/**
 * Signs a key payload with the issuing key's seed and returns the key's wire form, the JSON of
 * `{certificate, payload, signature}`. `kid` is filled from the certificate unless overridden.
 */
export async function signKey(issuingSeed: string, certificate: Certificate, payload: KeyPayload, override: { kid?: string } = {}): Promise<string> {
  const body = decodeJson(certificate.payload);
  if (!body || !isObject(body.value) || typeof body.value.keyId !== "string") throw new Error("certificate payload is malformed");
  const full: KeyPayload = { ...payload, kid: override.kid ?? body.value.keyId };
  const bytes = utf8.encode(JSON.stringify(full));
  const key: LicenseKey = {
    certificate: { payload: certificate.payload, signature: certificate.signature },
    payload: b64urlEncode(bytes),
    signature: await sign(issuingSeed, concat(utf8.encode(LICENSE_DOMAIN), bytes)),
  };
  return JSON.stringify(key);
}

function useForPlan(plan: Plan): Use {
  return plan === "public" ? "license-public" : "license";
}

/**
 * Verifies a key's wire form, checking in order: shape, the certificate against `roots` and its
 * window, `kid` against the certificate, the key signature, the key's iat (less IAT_LEEWAY_S) and exp, and the purpose
 * (a `public` plan needs a `license-public` certificate, every other plan `license`).
 */
export async function verifyKey(key: string, opts: { roots: string[]; now: Date }): Promise<Verdict<KeyPayload>> {
  let env: unknown;
  try {
    env = JSON.parse(key);
  } catch {
    return { ok: false, reason: "shape" };
  }
  if (!isObject(env) || !isObject(env.certificate) || typeof env.signature !== "string") return { ok: false, reason: "shape" };
  const decoded = decodeJson(env.payload);
  if (!decoded || !isObject(decoded.value)) return { ok: false, reason: "shape" };
  const p = decoded.value;
  if (p.v !== 1 || typeof p.kid !== "string" || typeof p.iat !== "number" || typeof p.exp !== "number" || !PLANS.includes(p.plan as Plan)) {
    return { ok: false, reason: "shape" };
  }
  let sig: Bytes;
  try {
    sig = b64urlDecode(env.signature);
  } catch {
    return { ok: false, reason: "shape" };
  }
  const cert = await verifyCertificate(env.certificate, opts.roots, null, opts.now);
  if (!cert.ok) return cert;
  if (p.kid !== cert.payload.keyId) return { ok: false, reason: "kid-mismatch" };
  if (!(await verifySig(b64urlDecode(cert.payload.publicKey), concat(utf8.encode(LICENSE_DOMAIN), decoded.bytes), sig))) {
    return { ok: false, reason: "bad-signature" };
  }
  const nowS = opts.now.getTime() / 1000;
  if (nowS < p.iat - IAT_LEEWAY_S) return { ok: false, reason: "key-not-yet-valid" };
  if (nowS >= p.exp) return { ok: false, reason: "key-expired" };
  if (cert.payload.use !== useForPlan(p.plan as Plan)) return { ok: false, reason: "purpose" };
  return { ok: true, payload: p as unknown as KeyPayload };
}
