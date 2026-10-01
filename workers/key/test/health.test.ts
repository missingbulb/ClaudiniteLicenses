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

  it("names the issuing key, its certificate's expiry and that D1 answers, calling no one", async () => {
    const res = await call("/v1/key/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, kid: cert().keyId, cert_exp: cert().notAfter, d1: "ok" });
    expect(world.calls).toHaveLength(0);
  });

  it("says d1 unreadable when D1 throws", async () => {
    const res = await call("/v1/key/health", {}, env({ brokenDb: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, d1: "unreadable" });
  });
});

it("answers 404 off its routes", async () => {
  expect((await call("/v1/key/other")).status).toBe(404);
  expect((await call("/webhook")).status).toBe(404);
});
