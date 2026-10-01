import { describe, expect, it } from "vitest";
import { b64urlDecode, b64urlEncode, issueCertificate, keyId, signKey, verifyCertificate, verifyKey } from "../src/index.ts";
import { DAY, devChain, NOW, NOW_S, payload } from "./chain.ts";

describe("key ids", () => {
  it("are the first 16 hex chars of SHA-256 over the raw public key", async () => {
    const id = await keyId(new Uint8Array(32));
    expect(id).toBe("66687aadf862bd77");
  });
});

describe("certificates", () => {
  it("refuse to issue for an unknown use or past the use's cap", async () => {
    const c = await devChain();
    await expect(issueCertificate(c.root.seed, c.issuing.publicKey, "release" as never, c.nb, c.na)).rejects.toThrow(/use/);
    const long = new Date(c.nb.getTime() + 91 * DAY * 1000);
    await expect(issueCertificate(c.root.seed, c.issuing.publicKey, "license", c.nb, long)).rejects.toThrow(/90 days/);
  });

  it("verify against their root and not another", async () => {
    const c = await devChain();
    const cert = await c.certify(c.root, "license");
    expect((await verifyCertificate(cert, [c.root.publicKey], "license", NOW)).ok).toBe(true);
    expect(await verifyCertificate(cert, [c.stranger.publicKey], "license", NOW)).toEqual({ ok: false, reason: "untrusted-root" });
  });
});

describe("verifyKey", () => {
  it("round-trips a key signed by a certified issuing key", async () => {
    const c = await devChain();
    const cert = await c.certify(c.root, "license-public");
    const key = await signKey(c.issuing.seed, cert, payload());
    const res = await verifyKey(key, { roots: [c.root.publicKey], now: NOW });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.payload.user_id).toBe(303);
      expect(res.payload.kid).toBe(await keyId(b64urlDecode(c.issuing.publicKey)));
    }
  });

  it("refuses a certificate signed by an unknown root", async () => {
    const c = await devChain();
    const key = await signKey(c.issuing.seed, await c.certify(c.stranger, "license-public"), payload());
    expect(await verifyKey(key, { roots: [c.root.publicKey], now: NOW })).toEqual({ ok: false, reason: "untrusted-root" });
  });

  it("accepts a certificate signed by the standby root", async () => {
    const c = await devChain();
    const key = await signKey(c.issuing.seed, await c.certify(c.standby, "license-public"), payload());
    expect((await verifyKey(key, { roots: [c.root.publicKey, c.standby.publicKey], now: NOW })).ok).toBe(true);
  });

  it("matches the certificate's use to the key's plan", async () => {
    const c = await devChain();
    const roots = { roots: [c.root.publicKey], now: NOW };
    const lic = await c.certify(c.root, "license");
    const pub = await c.certify(c.root, "license-public");
    const packs = await c.certify(c.root, "packs");
    expect(await verifyKey(await signKey(c.issuing.seed, lic, payload({ plan: "public" })), roots)).toEqual({ ok: false, reason: "purpose" });
    expect(await verifyKey(await signKey(c.issuing.seed, pub, payload({ plan: "personal" })), roots)).toEqual({ ok: false, reason: "purpose" });
    expect(await verifyKey(await signKey(c.issuing.seed, packs, payload({ plan: "public" })), roots)).toEqual({ ok: false, reason: "purpose" });
    expect(await verifyKey(await signKey(c.issuing.seed, packs, payload({ plan: "personal" })), roots)).toEqual({ ok: false, reason: "purpose" });
    expect((await verifyKey(await signKey(c.issuing.seed, lic, payload({ plan: "personal" })), roots)).ok).toBe(true);
  });

  it("names each window and tamper failure", async () => {
    const c = await devChain();
    const roots = [c.root.publicKey];
    const cert = await c.certify(c.root, "license-public");
    const good = await signKey(c.issuing.seed, cert, payload());

    const expiredCert = await c.certify(c.root, "license-public", new Date("2026-01-01T00:00:00Z"), new Date("2026-03-01T00:00:00Z"));
    expect(await verifyKey(await signKey(c.issuing.seed, expiredCert, payload()), { roots, now: NOW })).toEqual({ ok: false, reason: "cert-expired" });
    expect(await verifyKey(good, { roots, now: new Date("2026-05-01T00:00:00Z") })).toEqual({ ok: false, reason: "cert-not-yet-valid" });
    expect(await verifyKey(await signKey(c.issuing.seed, cert, payload({ exp: NOW_S - 1 })), { roots, now: NOW })).toEqual({ ok: false, reason: "key-expired" });
    expect(await verifyKey(await signKey(c.issuing.seed, cert, payload({ iat: NOW_S + 60 })), { roots, now: NOW })).toEqual({ ok: false, reason: "key-not-yet-valid" });

    const env = JSON.parse(good);
    const body = b64urlDecode(env.payload);
    body[10] = body[10]! ^ 1;
    expect(await verifyKey(JSON.stringify({ ...env, payload: b64urlEncode(body) }), { roots, now: NOW })).toEqual({ ok: false, reason: "bad-signature" });
    const sig = b64urlDecode(env.signature);
    sig[0] = sig[0]! ^ 1;
    expect(await verifyKey(JSON.stringify({ ...env, signature: b64urlEncode(sig) }), { roots, now: NOW })).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("refuses a key whose kid is not its certificate's key id", async () => {
    const c = await devChain();
    const key = await signKey(c.issuing.seed, await c.certify(c.root, "license-public"), payload(), { kid: "0000000000000000" });
    expect(await verifyKey(key, { roots: [c.root.publicKey], now: NOW })).toEqual({ ok: false, reason: "kid-mismatch" });
  });

  it("refuses what is not a key", async () => {
    const c = await devChain();
    for (const junk of ["", "cnk1.a.b", "{}", JSON.stringify({ certificate: {}, payload: "x", signature: "y" })]) {
      expect(await verifyKey(junk, { roots: [c.root.publicKey], now: NOW })).toEqual({ ok: false, reason: "shape" });
    }
  });
});
