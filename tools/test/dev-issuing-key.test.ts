import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { publicKeyOf, signKey, verifyCertificate, verifyKey, type Certificate, type CertificateBody, type KeyPayload, type Plan, type Use } from "../../packages/signing/src/index.ts";

// The issuing keys deploy.yml falls back to until ClaudiniteEngine#5, certified by the Engine's
// development root, of which keys/dev/roots/root.pub is a copy: license-public for the public key
// Worker, license for the paid one.
const DEV = resolve(import.meta.dirname, "../../keys/dev");
const read = (name: string) => readFileSync(join(DEV, name), "utf8");
const root = read("roots/root.pub").trim();
const RENEW_WITHIN_DAYS = 14;

const keys: { use: Use; other: Use; plans: Plan[] }[] = [
  { use: "license-public", other: "license", plans: ["public"] },
  { use: "license", other: "license-public", plans: ["public", "personal", "organization"] },
];

for (const { use, other, plans } of keys) {
  const seed = read(`${use}.key`);
  const cert = JSON.parse(read(`${use}.cert.json`)) as Certificate;
  const body = JSON.parse(Buffer.from(cert.payload, "base64url").toString("utf8")) as CertificateBody;
  // Verification runs at a moment inside the certificate's window, so an expired dev certificate
  // warns through the renewal test below rather than failing CI.
  const during = new Date(Date.parse(body.notBefore) + 60_000);

  describe(`keys/dev ${use} issuing key`, () => {
    it(`is certified for ${use} by the Engine's development root`, async () => {
      const res = await verifyCertificate(cert, [root], use, during);
      expect(res).toMatchObject({ ok: true, payload: { use } });
      expect(body.publicKey).toBe(read(`${use}.pub`).trim());
      expect(body.publicKey).toBe(await publicKeyOf(seed));
      expect((await verifyCertificate(cert, [root], other, during)).ok).toBe(false);
    });

    it(`signs ${plans.join(", ")} keys that verify against the development root alone`, async () => {
      const iat = Math.floor(during.getTime() / 1000);
      for (const plan of plans) {
        const payload = { v: 1, typ: "session", kid: "", repo_id: 1, owner_id: 2, owner_type: "User", owner_login: "acme-user", plan, user_id: 3, nonce: "acme-nonce-0123456789", iat, exp: iat + 3600, state: "ok", grace_until: null, features: [], release: { held: [], revoked: [], security_fixes: [], pack_index_serial: 0, pack_keys: [] } } satisfies KeyPayload;
        expect((await verifyKey(await signKey(seed, cert, payload), { roots: [root], now: during })).ok, plan).toBe(true);
      }
    });

    it(`has more than ${RENEW_WITHIN_DAYS} days left before it must be renewed`, (ctx) => {
      const daysLeft = (Date.parse(body.notAfter) - Date.now()) / 86_400_000;
      if (daysLeft < RENEW_WITHIN_DAYS) {
        const msg = `keys/dev/${use}.cert.json expires ${body.notAfter} (${Math.floor(daysLeft)} days); renew it as keys/dev/README.md says`;
        // Straight to stderr: the default reporter drops a skipped test's console output, and Actions
        // turns this line into an annotation.
        process.stderr.write(`::warning::${msg}\n`);
        ctx.skip(msg);
      }
      expect(daysLeft).toBeGreaterThanOrEqual(RENEW_WITHIN_DAYS);
    });
  });
}
