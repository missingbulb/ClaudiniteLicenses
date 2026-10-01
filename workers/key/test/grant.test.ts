import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FEATURES, generateKeyPair, issueCertificate, signKey, type KeyPayload } from "../../../packages/signing/src/index.ts";
import { issuingKey } from "../src/env.ts";
import { mintKey } from "../src/key.ts";
import { call, CHECKOUT_URL, env, freshDatabase, resetWorld, verified, world } from "./helpers.ts";

beforeEach(async () => {
  await freshDatabase();
  resetWorld();
});

afterEach(() => vi.restoreAllMocks());

const allButFleet = FEATURES.filter((f) => f !== "fleet");
const subject = {
  repoId: 1001,
  ownerId: 2002,
  ownerType: "User" as const,
  ownerLogin: "acme-user",
  plan: "private-repo" as const,
  state: "grace" as KeyPayload["state"],
  graceUntil: 1_900_000_000,
  features: allButFleet as string[],
  seats: { paid: 0, counted: 1, headroom: 0 },
  checkoutUrl: CHECKOUT_URL,
  portalUrl: null as string | null,
};

async function actionsKey(over: Partial<typeof subject> = {}, at = Math.floor(Date.now() / 1000)) {
  const { seed, cert } = issuingKey(env());
  return mintKey(seed, cert, { typ: "actions", ...subject, ...over }, at);
}

const ask = (key: string | null, body: unknown) =>
  call("/v1/item-grant", { method: "POST", headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) });

describe("POST /v1/item-grant", () => {
  it("exchanges a valid Actions key and an issue for a grant carrying the issue, the key's plan, state, seats and links, capped at the key's exp", async () => {
    const at = Math.floor(Date.now() / 1000) - 3600;
    const key = await actionsKey({}, at);
    const res = await ask(key, { issue: 42 });
    expect(res.status).toBe(200);
    const { grant } = (await res.json()) as { grant: string };
    const g = await verified(grant);
    const a = await verified(key);
    expect(g).toMatchObject({ typ: "grant", issue: 42, repo_id: 1001, owner_id: 2002, owner_login: "acme-user", plan: "private-repo", state: "grace", grace_until: 1_900_000_000, seats: subject.seats, checkout_url: CHECKOUT_URL, portal_url: null });
    expect(g.features).toEqual(allButFleet);
    expect(g.exp).toBe(a.exp);
    expect(g.exp - g.iat).toBeLessThan(6 * 3600);
    expect(g).not.toHaveProperty("user_id");
    expect(g).not.toHaveProperty("nonce");
    expect(world.limited).toEqual({ "owner:acme-user": 1 });
  });

  it("lives at most 6 hours from now", async () => {
    const g = await verified(((await (await ask(await actionsKey(), { issue: 7 })).json()) as { grant: string }).grant);
    expect(g.exp - g.iat).toBe(6 * 3600);
  });

  it("issues a degraded grant under a degraded Actions key", async () => {
    const res = await ask(await actionsKey({ state: "degraded", features: [] }), { issue: 42 });
    const g = await verified(((await res.json()) as { grant: string }).grant);
    expect(g).toMatchObject({ typ: "grant", state: "degraded", features: [] });
  });

  it("refuses a session key with 403 key-not-actions", async () => {
    const { seed, cert } = issuingKey(env());
    const session = await mintKey(seed, cert, { typ: "session", userId: 3003, nonce: "acme-nonce-0123456789abcdef", ...subject }, Math.floor(Date.now() / 1000));
    const res = await ask(session, { issue: 42 });
    expect([res.status, await res.json()]).toEqual([403, { refused: "key-not-actions" }]);
  });

  it("refuses a key from an untrusted root, an expired key and no key with 401 key-invalid naming the reason", async () => {
    const root = await generateKeyPair();
    const issuing = await generateKeyPair();
    const now = new Date();
    const cert = await issueCertificate(root.seed, issuing.publicKey, "license", new Date(now.getTime() - 86_400_000), new Date(now.getTime() + 86_400_000));
    const at = Math.floor(now.getTime() / 1000);
    const foreign = await signKey(issuing.seed, cert, { ...(JSON.parse(atob((JSON.parse(await actionsKey()) as { payload: string }).payload.replace(/-/g, "+").replace(/_/g, "/"))) as KeyPayload), iat: at, exp: at + 3600 });
    const untrusted = await ask(foreign, { issue: 42 });
    expect([untrusted.status, await untrusted.json()]).toEqual([401, { refused: "key-invalid", reason: "untrusted-root" }]);
    const expired = await ask(await actionsKey({}, at - 7 * 3600), { issue: 42 });
    expect([expired.status, await expired.json()]).toEqual([401, { refused: "key-invalid", reason: "key-expired" }]);
    const none = await ask(null, { issue: 42 });
    expect([none.status, await none.json()]).toEqual([401, { refused: "key-invalid", reason: "shape" }]);
  });

  it("refuses an issue that is not a positive integer with 400 issue-invalid", async () => {
    const key = await actionsKey();
    for (const issue of ["42", 0, -1, 1.5, null]) {
      const res = await ask(key, { issue });
      expect([res.status, await res.json()], String(issue)).toEqual([400, { refused: "issue-invalid" }]);
    }
  });
});
