import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reader } from "../src/db.ts";
import { resetJwksCache } from "../src/oidc.ts";
import { actionsClaims, base, call, countingDb, env, freshDatabase, oidcIssuer, resetWorld, seedRepo, sentIncidents, world } from "./helpers.ts";

beforeEach(async () => {
  await freshDatabase();
  resetWorld();
  resetJwksCache();
});

afterEach(() => vi.restoreAllMocks());

/** A key request down each route that reads D1, on a private repo. */
const routes: Record<string, (e: ReturnType<typeof env>) => Promise<Response>> = {
  actions: async (e) => {
    const issuer = await oidcIssuer();
    world.jwks = () => Response.json({ keys: [issuer.jwk] });
    const token = await issuer.sign(actionsClaims({ repository_visibility: "private" }));
    return call("/v1/actions-key", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ engine_version: "1.1.0" }) }, e);
  },
  health: (e) => call("/v1/key/health", {}, e),
};

const STATUS: Record<string, number> = { actions: 200, health: 200 };

describe("reader", () => {
  it("opens one unconstrained session on the binding", () => {
    const e = env();
    const session = reader(e);
    expect(world.sessions).toEqual(["first-unconstrained"]);
    expect(typeof session.prepare).toBe("function");
    expect(typeof session.batch).toBe("function");
  });

  for (const [name, request] of Object.entries(routes)) {
    it(`opens exactly one unconstrained session for a ${name} request`, async () => {
      await seedRepo({ visibility: "private" });
      const res = await request(env());
      expect(res.status, await res.clone().text()).toBe(STATUS[name]);
      expect(world.sessions).toEqual(["first-unconstrained"]);
      expect(world.dbCalls).toBeGreaterThan(0);
    });

    it(`reads nothing outside the session on a ${name} request`, async () => {
      await seedRepo({ visibility: "private" });
      // Failing closed, a read that bypassed the session would answer server-error rather than a key.
      const res = await request(env({ DB: countingDb(base.DB, { sessionOnly: true }) }));
      const text = await res.clone().text();
      expect(res.status, text).toBe(STATUS[name]);
      expect(text).not.toMatch(/server-error|unreadable/);
      expect(sentIncidents()).toEqual([]);
    });
  }

});
