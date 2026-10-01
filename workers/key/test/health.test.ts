import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { b64urlDecode } from "../../../packages/signing/src/index.ts";
import { base, call, env, freshDatabase, resetWorld, world } from "./helpers.ts";

beforeEach(async () => {
  await freshDatabase();
  resetWorld();
});

afterEach(() => vi.restoreAllMocks());

describe("GET /v1/key/health", () => {
  const cert = () => JSON.parse(new TextDecoder().decode(b64urlDecode((JSON.parse(base.ISSUING_KEY_CERT) as { payload: string }).payload)));

  it("names the issuing key, its certificate's expiry and days left, that D1 answers and the roots parse, calling no one", async () => {
    const res = await call("/v1/key/health");
    expect(res.status).toBe(200);
    const days = Math.floor((Date.parse(cert().notAfter) - Date.now()) / 86_400_000);
    expect(await res.json()).toEqual({ ok: true, kid: cert().keyId, cert_exp: cert().notAfter, cert_days_left: days, d1: "ok", queue: "bound", polar: "configured", trust_roots: "ok", alerts: [] });
    expect(world.calls).toHaveLength(0);
  });

  /** Health read at `days` (fractional) before the certificate's expiry. */
  async function healthAt(days: number, e = env()) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(cert().notAfter) - days * 86_400_000);
    try {
      const res = await call("/v1/key/health", {}, e);
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    } finally {
      vi.useRealTimers();
    }
  }

  it("answers 503 cert-expiring with 13 days left on the certificate, and 200 with 15", async () => {
    expect(await healthAt(13.5)).toEqual({ status: 503, body: expect.objectContaining({ ok: false, cert_days_left: 13, alerts: ["cert-expiring"] }) });
    expect(await healthAt(15.5)).toEqual({ status: 200, body: expect.objectContaining({ ok: true, cert_days_left: 15, alerts: [] }) });
  });

  it("answers 503 cert-expired once the certificate has expired", async () => {
    expect(await healthAt(-1)).toEqual({ status: 503, body: expect.objectContaining({ ok: false, alerts: ["cert-expired"] }) });
  });

  it("answers 503 trust-roots-invalid when TRUST_ROOTS does not parse", async () => {
    const res = await call("/v1/key/health", {}, env({ TRUST_ROOTS: "nope" }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, trust_roots: "invalid", alerts: ["trust-roots-invalid"] });
  });

  it("says when the queue is unbound or Polar is unconfigured, which the probe judges", async () => {
    const res = await call("/v1/key/health", {}, env({ WRITES: undefined, POLAR_ACCESS_TOKEN: undefined }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ queue: "unbound", polar: "unconfigured" });
  });

  it("answers 503 d1-unreadable when D1 throws", async () => {
    const res = await call("/v1/key/health", {}, env({ brokenDb: true }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, d1: "unreadable", alerts: ["d1-unreadable"] });
  });
});

it("answers 404 off its routes", async () => {
  expect((await call("/v1/key/other")).status).toBe(404);
  expect((await call("/webhook")).status).toBe(404);
  expect((await call("/v1/item-grant")).status).toBe(404);
});
