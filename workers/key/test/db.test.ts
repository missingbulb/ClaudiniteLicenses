import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issuingKey } from "../src/env.ts";
import { mintKey } from "../src/key.ts";
import { reader } from "../src/db.ts";
import { resetJwksCache } from "../src/oidc.ts";
import { actionsClaims, base, call, countingDb, env, freshDatabase, githubRepo, HEAD, NONCE, oidcIssuer, resetWorld, seedRepo, sentIncidents, world } from "./helpers.ts";

beforeEach(async () => {
  await freshDatabase();
  resetWorld();
  resetJwksCache();
});

afterEach(() => vi.restoreAllMocks());

/** A key request down each route that reads D1, on a private repo so the seat reads run too. */
const routes: Record<string, (e: ReturnType<typeof env>) => Promise<Response>> = {
  web: (e) =>
    call(
      "/webhook",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-GitHub-Event": "repository_dispatch", "X-GitHub-Delivery": "acme-delivery" },
        body: JSON.stringify({
          action: "claudinite-key",
          repository: { id: 1001, name: "acme-repo", full_name: "acme-user/acme-repo", private: true, owner: { id: 2002, login: "acme-user", type: "User" } },
          installation: { id: 5005 },
          sender: { id: 3003, login: "acme-dev", type: "User" },
          client_payload: { nonce: NONCE, engine_version: "1.1.0", head: HEAD },
        }),
      },
      e,
    ),
  desktop: (e) => {
    world.repo = () => Response.json(githubRepo({ private: true, visibility: "private" }));
    return call("/v1/session-key", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer ghu_acme" }, body: JSON.stringify({ repo: "acme-user/acme-repo", nonce: NONCE, engine_version: "1.1.0" }) }, e);
  },
  actions: async (e) => {
    const issuer = await oidcIssuer();
    world.jwks = () => Response.json({ keys: [issuer.jwk] });
    const token = await issuer.sign(actionsClaims({ repository_visibility: "private" }));
    return call("/v1/actions-key", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ engine_version: "1.1.0" }) }, e);
  },
  health: (e) => call("/v1/key/health", {}, e),
};

const STATUS: Record<string, number> = { web: 201, desktop: 200, actions: 200, health: 200 };

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
      const res = await request(env({ DB: countingDb(base.DB, { sessionOnly: true }), FAIL_OPEN: "false" }));
      const text = await res.clone().text();
      expect(res.status, text).toBe(STATUS[name]);
      expect(text).not.toMatch(/server-error|unreadable/);
      expect(sentIncidents()).toEqual([]);
    });
  }

  it("opens no session for an item grant, which reads no D1", async () => {
    const { seed, cert } = issuingKey(env());
    const key = await mintKey(
      seed,
      cert,
      { typ: "actions", repoId: 1001, ownerId: 2002, ownerType: "User", ownerLogin: "acme-user", plan: "public", state: "ok", graceUntil: null, features: [], seats: null, checkoutUrl: null, portalUrl: null, notice: null },
      Math.floor(Date.now() / 1000),
    );
    const res = await call("/v1/item-grant", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify({ issue: 7 }) }, env({ DB: countingDb(base.DB, { sessionOnly: true }) }));
    expect(res.status, await res.clone().text()).toBe(200);
    expect(world.sessions).toEqual([]);
    expect(world.dbCalls).toBe(0);
  });
});
