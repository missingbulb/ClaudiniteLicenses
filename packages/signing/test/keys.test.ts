import { describe, expect, it } from "vitest";
import { b64urlDecode, b64urlEncode, CERT_RENEW_DAYS, certStanding, issueCertificate, keyId, knownFeatures, PLANS, signKey, verifyCertificate, verifyKey, type KeyPayload } from "../src/index.ts";
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

describe("knownFeatures", () => {
  it("keeps the names from the Keys table, in the key's order, and drops the rest", () => {
    expect(knownFeatures(payload({ features: ["fleet", "acme-feature", "updates", "work-checks"] }))).toEqual(["fleet", "updates", "work-checks"]);
    expect(knownFeatures(payload({ features: ["acme-feature"] }))).toEqual([]);
    expect(knownFeatures(payload({ features: [] }))).toEqual([]);
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

  it("lets a license certificate sign any plan and a license-public certificate only the public plan", async () => {
    const c = await devChain();
    const roots = { roots: [c.root.publicKey], now: NOW };
    const lic = await c.certify(c.root, "license");
    const pub = await c.certify(c.root, "license-public");
    const packs = await c.certify(c.root, "packs");
    const manifest = await issueCertificate(c.root.seed, c.issuing.publicKey, "manifest", c.nb, c.na);
    for (const plan of PLANS) {
      expect((await verifyKey(await signKey(c.issuing.seed, lic, payload({ plan })), roots)).ok, plan).toBe(true);
      const byPublic = await verifyKey(await signKey(c.issuing.seed, pub, payload({ plan })), roots);
      expect(byPublic.ok ? "ok" : byPublic.reason, plan).toBe(plan === "public" ? "ok" : "purpose");
      for (const other of [packs, manifest]) {
        expect(await verifyKey(await signKey(c.issuing.seed, other, payload({ plan })), roots), plan).toEqual({ ok: false, reason: "purpose" });
      }
    }
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
    expect(await verifyKey(await signKey(c.issuing.seed, cert, payload({ iat: NOW_S + 301 })), { roots, now: NOW })).toEqual({ ok: false, reason: "key-not-yet-valid" });

    const env = JSON.parse(good);
    const body = b64urlDecode(env.payload);
    // A digit of repo_id, so the payload still parses and passes the shape checks.
    const at = new TextDecoder().decode(body).indexOf('"repo_id":') + 11;
    body[at] = body[at]! ^ 1;
    expect(await verifyKey(JSON.stringify({ ...env, payload: b64urlEncode(body) }), { roots, now: NOW })).toEqual({ ok: false, reason: "bad-signature" });
    const sig = b64urlDecode(env.signature);
    sig[0] = sig[0]! ^ 1;
    expect(await verifyKey(JSON.stringify({ ...env, signature: b64urlEncode(sig) }), { roots, now: NOW })).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("accepts an iat up to five minutes ahead of its clock, and no further", async () => {
    const c = await devChain();
    const cert = await c.certify(c.root, "license-public");
    const at = (iat: number) => signKey(c.issuing.seed, cert, payload({ iat, exp: iat + DAY }));
    expect((await verifyKey(await at(NOW_S + 60), { roots: [c.root.publicKey], now: NOW })).ok).toBe(true);
    expect((await verifyKey(await at(NOW_S + 300), { roots: [c.root.publicKey], now: NOW })).ok).toBe(true);
    expect(await verifyKey(await at(NOW_S + 301), { roots: [c.root.publicKey], now: NOW })).toEqual({ ok: false, reason: "key-not-yet-valid" });
  });

  it("refuses a key whose kid is not its certificate's key id", async () => {
    const c = await devChain();
    const key = await signKey(c.issuing.seed, await c.certify(c.root, "license-public"), payload(), { kid: "0000000000000000" });
    expect(await verifyKey(key, { roots: [c.root.publicKey], now: NOW })).toEqual({ ok: false, reason: "kid-mismatch" });
  });

  it("refuses a payload whose typ, state, features or release is malformed", async () => {
    const c = await devChain();
    const cert = await c.certify(c.root, "license-public");
    const release = payload().release;
    const bad: Record<string, unknown>[] = [
      { typ: "admin" },
      { typ: undefined },
      { state: "fine" },
      { state: 1 },
      { features: "work-checks" },
      { features: ["work-checks", ""] },
      { features: ["work-checks", "work-checks"] },
      { features: [1] },
      { release: null },
      { release: [] },
      { release: { ...release, held: "2.0.0" } },
      { release: { ...release, revoked: [2] } },
      { release: { ...release, security_fixes: [null] } },
      { release: { ...release, pack_index_serial: -1 } },
      { release: { ...release, pack_index_serial: 1.5 } },
      { release: { ...release, pack_index_serial: "3" } },
      { release: { ...release, pack_keys: ["not-a-key-id"] } },
      { release: { held: [], revoked: [], security_fixes: [], pack_index_serial: 0 } },
      { release: { ...release, held: undefined } },
    ];
    for (const over of bad) {
      const key = await signKey(c.issuing.seed, cert, { ...payload(), ...over } as KeyPayload);
      expect(await verifyKey(key, { roots: [c.root.publicKey], now: NOW }), JSON.stringify(over)).toEqual({ ok: false, reason: "shape" });
    }
    const full = payload({
      typ: "grant",
      state: "grace",
      grace_until: NOW_S + DAY,
      features: [],
      release: { held: ["2.1.0"], revoked: ["2.0.0"], security_fixes: ["2.0.1"], pack_index_serial: 7, pack_keys: ["0123456789abcdef"] },
    });
    expect((await verifyKey(await signKey(c.issuing.seed, cert, full), { roots: [c.root.publicKey], now: NOW })).ok).toBe(true);
  });

  it("ignores feature names, release fields and payload fields it does not know", async () => {
    const c = await devChain();
    const cert = await c.certify(c.root, "license-public");
    const release = { ...payload().release, acme_field: [1] };
    const over = { features: ["work-checks", "acme-feature"], release, acme_field: { any: "thing" } };
    const res = await verifyKey(await signKey(c.issuing.seed, cert, { ...payload(), ...over } as KeyPayload), { roots: [c.root.publicKey], now: NOW });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.payload.features).toEqual(["work-checks", "acme-feature"]);
      expect(knownFeatures(res.payload)).toEqual(["work-checks"]);
    }
  });

  it("refuses what is not a key", async () => {
    const c = await devChain();
    for (const junk of ["", "cnk1.a.b", "{}", JSON.stringify({ certificate: {}, payload: "x", signature: "y" })]) {
      expect(await verifyKey(junk, { roots: [c.root.publicKey], now: NOW })).toEqual({ ok: false, reason: "shape" });
    }
  });

  it("verifies a key without seats, checkout_url, portal_url or issue, and one carrying each", async () => {
    const c = await devChain();
    const cert = await c.certify(c.root, "license");
    const roots = { roots: [c.root.publicKey], now: NOW };
    expect((await verifyKey(await signKey(c.issuing.seed, cert, payload()), roots)).ok).toBe(true);
    const nulls = payload({ seats: null, checkout_url: null, portal_url: null });
    expect((await verifyKey(await signKey(c.issuing.seed, cert, nulls), roots)).ok).toBe(true);
    const full = payload({
      plan: "private-repo",
      state: "grace",
      grace_until: NOW_S + 7 * DAY,
      seats: { paid: 0, counted: 1, headroom: 0 },
      checkout_url: "https://sandbox.polar.sh/checkout/acme",
      portal_url: "https://sandbox.polar.sh/portal/acme",
    });
    const res = await verifyKey(await signKey(c.issuing.seed, cert, full), roots);
    expect(res.ok && res.payload.seats).toEqual({ paid: 0, counted: 1, headroom: 0 });
    const grant = payload({ typ: "grant", user_id: undefined, nonce: undefined, issue: 42 });
    const g = await verifyKey(await signKey(c.issuing.seed, cert, grant), roots);
    expect(g.ok && g.payload.issue).toBe(42);
  });

  it("refuses a malformed seats, a link that is not https, or an issue that is not a positive integer", async () => {
    const c = await devChain();
    const cert = await c.certify(c.root, "license");
    const bad: Record<string, unknown>[] = [
      { seats: { paid: -1, counted: 1, headroom: 0 } },
      { seats: { paid: 1, counted: 1 } },
      { seats: { paid: 1.5, counted: 1, headroom: 0 } },
      { seats: { paid: "1", counted: 1, headroom: 0 } },
      { seats: [1, 1, 0] },
      { seats: 3 },
      { checkout_url: "http://sandbox.polar.sh/checkout/acme" },
      { checkout_url: "not a url" },
      { checkout_url: 7 },
      { portal_url: "javascript:alert(1)" },
      { typ: "grant", issue: 0 },
      { typ: "grant", issue: -3 },
      { typ: "grant", issue: 4.2 },
      { typ: "grant", issue: "42" },
    ];
    for (const over of bad) {
      const key = await signKey(c.issuing.seed, cert, { ...payload(), ...over } as KeyPayload);
      expect(await verifyKey(key, { roots: [c.root.publicKey], now: NOW }), JSON.stringify(over)).toEqual({ ok: false, reason: "shape" });
    }
  });
});


describe("certStanding", () => {
  const notAfter = "2026-12-30T17:49:26Z";
  const at = (days: number) => new Date(Date.parse(notAfter) - days * DAY * 1000);

  it("counts whole days left and asks for renewal inside the two weeks of overlap", () => {
    expect(CERT_RENEW_DAYS).toBe(14);
    expect(certStanding(notAfter, at(15.5))).toEqual({ daysLeft: 15, alert: null });
    expect(certStanding(notAfter, at(14))).toEqual({ daysLeft: 14, alert: null });
    expect(certStanding(notAfter, at(13.9))).toEqual({ daysLeft: 13, alert: "cert-expiring" });
    expect(certStanding(notAfter, at(0.5))).toEqual({ daysLeft: 0, alert: "cert-expiring" });
  });

  it("names an expired certificate, and an unreadable expiry as expired", () => {
    expect(certStanding(notAfter, at(0))).toEqual({ daysLeft: 0, alert: "cert-expired" });
    expect(certStanding(notAfter, at(-2))).toEqual({ daysLeft: -2, alert: "cert-expired" });
    expect(certStanding("not a time", at(1))).toEqual({ daysLeft: null, alert: "cert-expired" });
  });
});
