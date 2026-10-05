import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { b64urlDecode } from "../../../packages/signing/src/index.ts";
import { base, call, env, freshDatabase, resetWorld, world } from "./helpers.ts";

/** A binding whose session answers every statement with `meta`, as a remote D1 fills it. */
function sessionAnswering(meta: Record<string, unknown>): D1Database {
  const statement = { bind: () => statement, run: async () => ({ success: true, results: [], meta }), first: async () => null, all: async () => ({ success: true, results: [], meta }) };
  const session = { prepare: () => statement, batch: async () => [], getBookmark: () => null };
  return { withSession: () => session } as unknown as D1Database;
}

beforeEach(async () => {
  await freshDatabase();
  resetWorld();
});

afterEach(() => vi.restoreAllMocks());

describe("GET /v1/key/health", () => {
  const cert = () => JSON.parse(new TextDecoder().decode(b64urlDecode((JSON.parse(base.ISSUING_KEY_CERT) as { payload: string }).payload)));

  it("names the issuing key, its certificate's expiry and days left and that D1 answers, calling no one", async () => {
    const res = await call("/v1/key/health");
    expect(res.status).toBe(200);
    const days = Math.floor((Date.parse(cert().notAfter) - Date.now()) / 86_400_000);
    expect(await res.json()).toEqual({ ok: true, kid: cert().keyId, cert_exp: cert().notAfter, cert_days_left: days, d1: "ok", d1_served_by_primary: null, d1_served_by_region: null, d1_ms: expect.any(Number), queue: "bound", polar: "configured", ip_limit: "counted", version: (base as unknown as { CF_VERSION_METADATA: { id: string } }).CF_VERSION_METADATA.id, alerts: [] });
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

  it("says when the queue is unbound or Polar is unconfigured, which the probe judges", async () => {
    const res = await call("/v1/key/health", {}, env({ WRITES: undefined, POLAR_ACCESS_TOKEN: undefined }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ queue: "unbound", polar: "unconfigured" });
  });

  it("says where and how fast its D1 read was served when the result's meta does", async () => {
    const res = await call("/v1/key/health", {}, env({ DB: sessionAnswering({ served_by_primary: false, served_by_region: "WEUR", duration: 1.2 }) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ d1: "ok", d1_served_by_primary: false, d1_served_by_region: "WEUR", d1_ms: 1.2 });
  });

  it("answers null for each served-by field the meta lacks, never false or 0, and judges D1 the same", async () => {
    const res = await call("/v1/key/health", {}, env({ DB: sessionAnswering({}) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, d1: "ok", d1_served_by_primary: null, d1_served_by_region: null, d1_ms: null, alerts: [] });
    const primary = await call("/v1/key/health", {}, env({ DB: sessionAnswering({ served_by_primary: true, served_by_region: "ENAM" }) }));
    expect(await primary.json()).toMatchObject({ d1_served_by_primary: true, d1_served_by_region: "ENAM", d1_ms: null });
  });

  it("answers 503 d1-unreadable when D1 throws, with each served-by field null", async () => {
    const res = await call("/v1/key/health", {}, env({ brokenDb: true }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ d1: "unreadable", d1_served_by_primary: null, d1_served_by_region: null, d1_ms: null });
  });

  it("answers 503 d1-unreadable when D1 throws", async () => {
    const res = await call("/v1/key/health", {}, env({ brokenDb: true }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, d1: "unreadable", alerts: ["d1-unreadable"] });
  });
});

it("answers 404 off its routes, the retired session, web, grant and login paths among them", async () => {
  expect((await call("/v1/key/other")).status).toBe(404);
  for (const path of ["/webhook", "/v1/session-key", "/v1/item-grant", "/v1/login/refresh"]) {
    expect((await call(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, path).toBe(404);
  }
  expect((await call("/v1/login/config")).status).toBe(404);
});
