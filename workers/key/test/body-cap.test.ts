import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BODY_MAX_JSON } from "../../../packages/http/src/index.ts";
import { resetJwksCache } from "../src/oidc.ts";
import { actionsClaims, call, env, freshDatabase, oidcIssuer, resetWorld, seedRepo, world } from "./helpers.ts";

const ROUTES = ["/v1/actions-key"];
const e = () => env();
let issuer: Awaited<ReturnType<typeof oidcIssuer>>;

/** A JSON body exactly `n` bytes long that each route would act on. */
function bodyOf(path: string, n: number): string {
  const fields: Record<string, unknown> = { "/v1/actions-key": { engine_version: "1.1.0" } };
  const shell = JSON.stringify({ ...(fields[path] as object), pad: "" });
  return JSON.stringify({ ...(fields[path] as object), pad: "a".repeat(n - shell.length) });
}

const post = (path: string, body: string, headers: Record<string, string> = {}) =>
  call(path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer ghu_acme", ...headers }, body }, e());

beforeEach(async () => {
  await freshDatabase();
  await seedRepo();
  resetWorld();
  resetJwksCache();
  issuer = await oidcIssuer();
  world.jwks = () => Response.json({ keys: [issuer.jwk] });
});
afterEach(() => vi.restoreAllMocks());

describe("the key Worker's body cap", () => {
  for (const path of ROUTES) {
    it(`refuses a 16 KiB + 1 body on ${path} with 413 before any call`, async () => {
      expect(bodyOf(path, BODY_MAX_JSON + 1)).toHaveLength(BODY_MAX_JSON + 1);
      const res = await post(path, bodyOf(path, BODY_MAX_JSON + 1));
      expect([res.status, await res.json()]).toEqual([413, { refused: "body-too-large" }]);
      expect({ calls: world.calls.length, db: world.dbCalls, points: world.points.length }).toEqual({ calls: 0, db: 0, points: 0 });
    });

    it(`refuses a Content-Length over 16 KiB on ${path} with 413, whatever the body`, async () => {
      const res = await post(path, "{}", { "Content-Length": String(BODY_MAX_JSON + 1) });
      expect(res.status).toBe(413);
      expect(world.calls).toHaveLength(0);
    });
  }

  it("reads a body of exactly 16 KiB", async () => {
    const res = await post("/v1/actions-key", bodyOf("/v1/actions-key", BODY_MAX_JSON), { Authorization: `Bearer ${await issuer.sign(actionsClaims())}` });
    expect(res.status).toBe(200);
    expect(world.calls.length).toBeGreaterThan(0);
  });
});

describe("what a usage point records", () => {
  it("cuts a 65-character engine version to 64 in the point", async () => {
    const res = await post("/v1/actions-key", JSON.stringify({ engine_version: "v".repeat(65) }), { Authorization: `Bearer ${await issuer.sign(actionsClaims())}` });
    expect(res.status).toBe(200);
    expect(world.points.map((p) => p.blobs?.[3])).toEqual(["v".repeat(64)]);
  });

  it("writes no point for a token that does not verify or a missing one, and one for a refusal that spent a real token", async () => {
    expect((await post("/v1/actions-key", "{}", { Authorization: "Bearer not.a.jwt" })).status).toBe(401);
    expect((await call("/v1/actions-key", { method: "POST", body: "{}" }, e())).status).toBe(401);
    expect(world.points).toEqual([]);
    expect((await post("/v1/actions-key", "{}", { Authorization: `Bearer ${await issuer.sign(actionsClaims({ event_name: "pull_request" }))}` })).status).toBe(403);
    expect(world.points.map((p) => p.blobs?.[1])).toEqual(["refused-pull-request-trigger"]);
  });
});
