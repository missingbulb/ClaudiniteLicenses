import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BODY_MAX_JSON } from "../../../packages/http/src/index.ts";
import { call, env, freshDatabase, githubRepo, NONCE, resetWorld, seedRepo, world } from "./helpers.ts";

const ROUTES = ["/v1/session-key", "/v1/actions-key", "/v1/item-grant", "/v1/login/refresh"];
const e = () => env({ GITHUB_APP_CLIENT_SECRET: "acme-client-secret" });

/** A JSON body exactly `n` bytes long that each route would act on. */
function bodyOf(path: string, n: number): string {
  const fields: Record<string, unknown> = {
    "/v1/session-key": { repo: "acme-user/acme-repo", nonce: NONCE, engine_version: "1.1.0" },
    "/v1/actions-key": { engine_version: "1.1.0" },
    "/v1/item-grant": { issue: 7 },
    "/v1/login/refresh": { refresh_token: "ghr_acme" },
  };
  const shell = JSON.stringify({ ...(fields[path] as object), pad: "" });
  return JSON.stringify({ ...(fields[path] as object), pad: "a".repeat(n - shell.length) });
}

const post = (path: string, body: string, headers: Record<string, string> = {}) =>
  call(path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer ghu_acme", ...headers }, body }, e());

beforeEach(async () => {
  await freshDatabase();
  await seedRepo();
  resetWorld();
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
    const res = await post("/v1/session-key", bodyOf("/v1/session-key", BODY_MAX_JSON));
    expect(res.status).toBe(200);
    expect(world.calls.length).toBeGreaterThan(0);
  });
});

describe("what a usage point records", () => {
  it("cuts a 65-character engine version to 64 in the point", async () => {
    const res = await post("/v1/session-key", JSON.stringify({ repo: "acme-user/acme-repo", nonce: NONCE, engine_version: "v".repeat(65) }));
    expect(res.status).toBe(200);
    expect(world.points.map((p) => p.blobs?.[3])).toEqual(["v".repeat(64)]);
  });

  it("writes no point for a token GitHub refuses, a missing token or a malformed body, and one for a refusal that spent a real token", async () => {
    world.user = () => Response.json({ message: "Bad credentials" }, { status: 401 });
    expect((await post("/v1/session-key", bodyOf("/v1/session-key", 200))).status).toBe(401);
    expect((await call("/v1/session-key", { method: "POST", body: "{}" }, e())).status).toBe(401);
    expect((await post("/v1/session-key", "not json")).status).toBe(400);
    expect((await post("/v1/session-key", JSON.stringify({ repo: "nope", nonce: NONCE }))).status).toBe(400);
    expect(world.points).toEqual([]);
    world.user = () => Response.json({ id: 3003, login: "acme-dev", type: "User" });
    world.repo = () => Response.json(githubRepo({ permissions: { push: false } }));
    expect((await post("/v1/session-key", bodyOf("/v1/session-key", 200))).status).toBe(403);
    expect(world.points.map((p) => p.blobs?.[1])).toEqual(["refused-no-push-access"]);
  });
});
