// Generates vectors/keys.json, the license-key cases the cn binary replays. Every input is fixed
// (seeds, times) and Ed25519 is deterministic, so a fresh generation equals the committed file.
// Regenerate with: node packages/signing/scripts/gen-vectors.ts
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  b64urlDecode,
  b64urlEncode,
  CERT_DOMAIN,
  FEATURES,
  issueCertificate,
  keyId,
  LICENSE_DOMAIN,
  publicKeyOf,
  signKey,
  type Certificate,
  type KeyPayload,
} from "../src/index.ts";

export const VECTORS_PATH = resolve(import.meta.dirname, "../vectors/keys.json");

const seed = (byte: number) => b64urlEncode(new Uint8Array(32).fill(byte));

export async function generateVectors(): Promise<string> {
  const seeds = { root: seed(0x55), standby: seed(0x66), other: seed(0x77), licensePublic: seed(0x88), license: seed(0x99) };
  const pub = async (s: string) => {
    const publicKey = await publicKeyOf(s);
    return { seed: s, publicKey, keyId: await keyId(b64urlDecode(publicKey)) };
  };
  const roots = { root: await pub(seeds.root), standby: await pub(seeds.standby), other: await pub(seeds.other) };
  const subjects = { "license-public": await pub(seeds.licensePublic), license: await pub(seeds.license) };

  const nb = new Date("2026-01-01T00:00:00Z");
  const na = new Date("2026-04-01T00:00:00Z");
  const now = "2026-01-31T00:00:00Z";
  const iat = Date.parse(now) / 1000 - 3600;
  const certify = (by: string, use: "license" | "license-public", from = nb, to = na): Promise<Certificate> =>
    issueCertificate(by, subjects[use].publicKey, use, from, to);
  const certificates = {
    "license-public": await certify(seeds.root, "license-public"),
    license: await certify(seeds.standby, "license"),
  };

  const release = { held: [], revoked: [], security_fixes: [], pack_index_serial: 0, pack_keys: [] };
  const base: KeyPayload = {
    v: 1,
    typ: "session",
    kid: "",
    repo_id: 1001,
    owner_id: 2002,
    owner_type: "User",
    owner_login: "acme-user",
    plan: "public",
    user_id: 3003,
    nonce: "acme-nonce-0123456789abcdef",
    iat,
    exp: iat + 7 * 86400,
    state: "ok",
    grace_until: null,
    features: FEATURES.filter((f) => f !== "fleet"),
    release,
  };
  const sessionPersonal: KeyPayload = { ...base, plan: "personal", features: [...FEATURES] };
  const actions: KeyPayload = {
    v: 1,
    typ: "actions",
    kid: "",
    repo_id: 1001,
    owner_id: 4004,
    owner_type: "Organization",
    owner_login: "acme-org",
    plan: "organization",
    iat,
    exp: iat + 6 * 3600,
    state: "ok",
    grace_until: null,
    features: [...FEATURES],
    release,
  };

  const grant: KeyPayload = { ...actions, typ: "grant", issue: 42 };
  const graceSession: KeyPayload = {
    ...base,
    plan: "private-repo",
    state: "grace",
    grace_until: iat + 7 * 86400,
    seats: { paid: 5, counted: 7, headroom: 1 },
    checkout_url: "https://sandbox.polar.sh/checkout/acme-checkout",
    portal_url: null,
  };

  const pubKey = await signKey(seeds.licensePublic, certificates["license-public"], base);
  // Flips the low bit of one byte: in the payload, the second digit of repo_id, so the JSON still parses.
  const flip = (key: string, field: "payload" | "signature") => {
    const env = JSON.parse(key);
    const bytes = b64urlDecode(env[field]);
    const at = field === "payload" ? new TextDecoder().decode(bytes).indexOf('"repo_id":') + 11 : 0;
    bytes[at] = bytes[at]! ^ 1;
    return JSON.stringify({ ...env, [field]: b64urlEncode(bytes) });
  };

  const keyCases = [
    { name: "session key, public plan", key: pubKey, valid: true },
    { name: "session key, personal plan, standby-certified", key: await signKey(seeds.license, certificates.license, sessionPersonal), valid: true },
    { name: "actions key, organization plan", key: await signKey(seeds.license, certificates.license, actions), valid: true },
    { name: "certificate from an untrusted root", key: await signKey(seeds.licensePublic, await certify(seeds.other, "license-public"), base), valid: false, reason: "untrusted-root" },
    { name: "license certificate on a public plan key", key: await signKey(seeds.license, certificates.license, base), valid: true },
    { name: "license-public certificate on a personal plan key", key: await signKey(seeds.licensePublic, certificates["license-public"], sessionPersonal), valid: false, reason: "purpose" },
    { name: "expired key", key: await signKey(seeds.licensePublic, certificates["license-public"], { ...base, iat: iat - 8 * 86400, exp: iat - 86400 }), valid: false, reason: "key-expired" },
    { name: "expired certificate", key: await signKey(seeds.licensePublic, await certify(seeds.root, "license-public", new Date("2025-10-01T00:00:00Z"), new Date("2025-12-01T00:00:00Z")), base), valid: false, reason: "cert-expired" },
    { name: "iat five minutes ahead of now", key: await signKey(seeds.licensePublic, certificates["license-public"], { ...base, iat: Date.parse(now) / 1000 + 300, exp: Date.parse(now) / 1000 + 300 + 7 * 86400 }), valid: true },
    { name: "iat past the five-minute leeway", key: await signKey(seeds.licensePublic, certificates["license-public"], { ...base, iat: Date.parse(now) / 1000 + 301, exp: Date.parse(now) / 1000 + 301 + 7 * 86400 }), valid: false, reason: "key-not-yet-valid" },
    { name: "unknown feature name", key: await signKey(seeds.licensePublic, certificates["license-public"], { ...base, features: [...base.features, "acme-feature"] }), valid: true },
    { name: "release carries a field the verifier does not know", key: await signKey(seeds.licensePublic, certificates["license-public"], { ...base, release: { ...release, acme_field: [1] } } as KeyPayload), valid: true },
    { name: "payload carries a field the verifier does not know", key: await signKey(seeds.licensePublic, certificates["license-public"], { ...base, acme_field: { any: "thing" } } as KeyPayload), valid: true },
    { name: "pack_keys entry is not a key id", key: await signKey(seeds.licensePublic, certificates["license-public"], { ...base, release: { ...release, pack_keys: ["acme"] } }), valid: false, reason: "shape" },
    { name: "item grant carrying its issue", key: await signKey(seeds.license, certificates.license, grant), valid: true },
    { name: "grace session key carrying seats and a checkout link", key: await signKey(seeds.license, certificates.license, graceSession), valid: true },
    { name: "seats holding a negative count", key: await signKey(seeds.license, certificates.license, { ...graceSession, seats: { paid: -1, counted: 7, headroom: 1 } }), valid: false, reason: "shape" },
    { name: "checkout link that is not https", key: await signKey(seeds.license, certificates.license, { ...graceSession, checkout_url: "http://sandbox.polar.sh/checkout/acme-checkout" }), valid: false, reason: "shape" },
    { name: "kid is not the certificate's key id", key: await signKey(seeds.licensePublic, certificates["license-public"], base, { kid: "0000000000000000" }), valid: false, reason: "kid-mismatch" },
    { name: "flipped payload byte", key: flip(pubKey, "payload"), valid: false, reason: "bad-signature" },
    { name: "flipped signature byte", key: flip(pubKey, "signature"), valid: false, reason: "bad-signature" },
  ];

  const doc = {
    _comment: [
      "License key vectors: ClaudiniteLicenses (packages/signing) and the cn binary must both pass every case.",
      "Generated by packages/signing/scripts/gen-vectors.ts; regenerate with: node packages/signing/scripts/gen-vectors.ts",
      "The certificate encoding is ClaudiniteEngine's (shared/sign/testdata/vectors.json); the key envelope is specified in packages/signing/README.md.",
      "Verify every case against roots [root, standby] at `now`; an invalid case names the first check that refuses it.",
      "A key is valid from 300 seconds before its iat, to absorb clock skew.",
      "A license certificate signs a key of any plan; a license-public certificate signs only a public plan key.",
      "An unknown feature name, release field or payload field is ignored, so the server can add one without an engine release.",
      "seats, checkout_url, portal_url and issue are optional: absent or null says nothing; when present, seats holds three non-negative integers, a link is an https URL and issue a positive integer.",
      "Seeds here are test keys only and sign nothing anyone trusts.",
    ],
    domains: { certificate: CERT_DOMAIN, license: LICENSE_DOMAIN },
    now,
    roots,
    subjects,
    certificates,
    keyCases,
  };
  return JSON.stringify(doc, null, 2) + "\n";
}

if (import.meta.filename === process.argv[1]) {
  writeFileSync(VECTORS_PATH, await generateVectors());
  console.log(`wrote ${VECTORS_PATH}`);
}
