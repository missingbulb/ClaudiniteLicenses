import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { publicKeyOf, signKey, verifyCertificate, verifyKey, type Certificate, type CertificateBody, type KeyPayload } from "../../packages/signing/src/index.ts";

// The license-public issuing key deploy.yml falls back to until ClaudiniteEngine#5, certified by
// the Engine's development root, of which keys/dev/roots/root.pub is a copy.
const DEV = resolve(import.meta.dirname, "../../keys/dev");
const read = (name: string) => readFileSync(join(DEV, name), "utf8");
const root = read("roots/root.pub").trim();
const seed = read("license-public.key");
const cert = JSON.parse(read("license-public.cert.json")) as Certificate;
const body = JSON.parse(Buffer.from(cert.payload, "base64url").toString("utf8")) as CertificateBody;
const RENEW_WITHIN_DAYS = 14;

// Verification runs at a moment inside the certificate's window, so an expired dev certificate
// warns through the renewal test below rather than failing CI.
const during = new Date(Date.parse(body.notBefore) + 60_000);

describe("keys/dev license-public issuing key", () => {
  it("is certified for license-public by the Engine's development root", async () => {
    const res = await verifyCertificate(cert, [root], "license-public", during);
    expect(res).toMatchObject({ ok: true, payload: { use: "license-public" } });
    expect(body.publicKey).toBe(read("license-public.pub").trim());
    expect(body.publicKey).toBe(await publicKeyOf(seed));
    expect((await verifyCertificate(cert, [root], "license", during)).ok).toBe(false);
  });

  it("signs a Public key that verifies against the development root alone", async () => {
    const iat = Math.floor(during.getTime() / 1000);
    const payload = { v: 1, typ: "session", kid: "", repo_id: 1, owner_id: 2, owner_type: "User", owner_login: "acme-user", plan: "public", user_id: 3, nonce: "acme-nonce-0123456789", iat, exp: iat + 3600, state: "ok", grace_until: null, features: [], release: { held: [], revoked: [], security_fixes: [], pack_index_serial: 0, pack_keys: [] } } satisfies KeyPayload;
    const key = await signKey(seed, cert, payload);
    expect((await verifyKey(key, { roots: [root], now: during })).ok).toBe(true);
  });

  it(`has more than ${RENEW_WITHIN_DAYS} days left before it must be renewed`, (ctx) => {
    const daysLeft = (Date.parse(body.notAfter) - Date.now()) / 86_400_000;
    if (daysLeft < RENEW_WITHIN_DAYS) {
      const msg = `keys/dev/license-public.cert.json expires ${body.notAfter} (${Math.floor(daysLeft)} days); renew it as keys/dev/README.md says`;
      // Straight to stderr: the default reporter drops a skipped test's console output, and Actions
      // turns this line into an annotation.
      process.stderr.write(`::warning::${msg}\n`);
      ctx.skip(msg);
    }
    expect(daysLeft).toBeGreaterThanOrEqual(RENEW_WITHIN_DAYS);
  });
});
