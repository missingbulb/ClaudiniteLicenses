import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { call, certKeyId, certUse, env, freshDatabase, githubRepo, NONCE, resetWorld, seedRepo, verified, world } from "./helpers.ts";

const ask = (body: unknown, e = env(), token: string | null = "ghu_acme") =>
  call("/v1/session-key", { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }, e);
const body = (over: Record<string, unknown> = {}) => ({ repo: "acme-user/acme-repo", nonce: NONCE, engine_version: "1.1.0", ...over });

beforeEach(async () => {
  await freshDatabase();
  resetWorld();
});

afterEach(() => vi.restoreAllMocks());

describe("POST /v1/session-key", () => {
  it("issues a verifying Public session key bound to GitHub's user and the body's nonce", async () => {
    await seedRepo();
    const res = await ask(body());
    expect(res.status).toBe(200);
    const out = (await res.json()) as { key: string; plan: string; state: string };
    expect(out).toMatchObject({ plan: "public", state: "ok" });
    const p = await verified(out.key);
    expect(p).toMatchObject({ typ: "session", plan: "public", user_id: 3003, nonce: NONCE, repo_id: 1001, owner_id: 2002, owner_type: "User", owner_login: "acme-user", kid: certKeyId() });
    expect(p.exp - p.iat).toBe(7 * 86400);
    expect(certUse(out.key)).toBe("license");
    expect(world.points).toEqual([{ indexes: ["1001"], blobs: ["public", "issued", "User", "1.1.0", "desktop"], doubles: [1] }]);
  });

  it("calls GitHub twice, as the caller", async () => {
    await seedRepo();
    await ask(body());
    expect(world.calls.map((c) => `${c.method} ${c.url} ${c.headers.get("Authorization")}`)).toEqual([
      "GET https://github-api.test/user Bearer ghu_acme",
      "GET https://github-api.test/repos/acme-user/acme-repo Bearer ghu_acme",
    ]);
  });

  it("names each refusal GitHub's answers lead to", async () => {
    await seedRepo();
    world.user = () => Response.json({ id: 1, login: "acme-org", type: "Organization" });
    expect([(await ask(body())).status, await (await ask(body())).json()]).toEqual([403, { refused: "sender-not-user" }]);
    world.user = () => Response.json({ message: "Bad credentials" }, { status: 401 });
    expect(await (await ask(body())).json()).toEqual({ refused: "token-invalid" });
    world.user = () => Response.json({ id: 3003, login: "acme-dev", type: "User" });
    world.repo = () => Response.json({ message: "Not Found" }, { status: 404 });
    const notVisible = await ask(body());
    expect([notVisible.status, await notVisible.json()]).toEqual([403, { refused: "repo-not-visible" }]);
    world.repo = () => Response.json(githubRepo({ permissions: { push: false } }));
    expect(await (await ask(body())).json()).toEqual({ refused: "no-push-access" });
  });

  it("refuses a private repo with no-plan and a repo without a row with app-not-installed", async () => {
    await seedRepo({ visibility: "public" });
    world.repo = () => Response.json(githubRepo({ private: true, visibility: "private" }));
    const priv = await ask(body());
    expect([priv.status, await priv.json()]).toEqual([403, { refused: "no-plan" }]);
    world.repo = () => Response.json(githubRepo({ id: 4040 }));
    expect(await (await ask(body())).json()).toEqual({ refused: "app-not-installed" });
  });

  it("refuses a malformed nonce or repo with 400 and a missing token with 401, before any GitHub call", async () => {
    expect((await ask(body({ nonce: "short" }))).status).toBe(400);
    expect((await ask(body({ repo: "acme-user" }))).status).toBe(400);
    expect((await ask(body(), env(), null)).status).toBe(401);
    expect(world.calls).toHaveLength(0);
  });

  it("issues an unverified key when D1 cannot be read", async () => {
    const res = await ask(body(), env({ brokenDb: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ plan: "public", state: "unverified" });
  });
});

describe("the per-owner rate limit", () => {
  it("never spends an owner's bucket on requests GitHub has not authenticated", async () => {
    await seedRepo();
    const e = env();
    for (let i = 0; i < 700; i++) expect((await ask(body(), e, null)).status).toBe(401);
    world.user = () => Response.json({ message: "Bad credentials" }, { status: 401 });
    for (let i = 0; i < 700; i++) expect((await ask(body(), e, "ghu_forged")).status).toBe(401);
    world.user = () => Response.json({ id: 3003, login: "acme-dev", type: "User" });
    world.repo = () => Response.json({ message: "Not Found" }, { status: 404 });
    for (let i = 0; i < 50; i++) expect((await ask(body(), e)).status).toBe(403);
    expect(world.limited).toEqual({});
    world.repo = () => Response.json(githubRepo());
    expect((await ask(body(), e)).status).toBe(200);
    expect(world.limited).toEqual({ "owner:acme-user": 1 });
  });

  it("keys the bucket on GitHub's owner login in lower case, the bucket the Actions path shares, and refuses the 601st with 429 and no D1 read", async () => {
    await seedRepo();
    const e = env();
    world.repo = () => Response.json(githubRepo({ owner: { id: 2002, login: "Acme-User", type: "User" } }));
    world.limited["owner:acme-user"] = 600;
    const dbCalls = world.dbCalls;
    const res = await ask(body({ repo: "someone-else/acme-repo" }), e);
    expect([res.status, await res.json()]).toEqual([429, { refused: "rate-limited" }]);
    expect(world.dbCalls - dbCalls).toBe(0);
    expect(world.limited["owner:someone-else"]).toBeUndefined();
    world.repo = () => Response.json(githubRepo({ owner: { id: 2003, login: "acme-other", type: "User" } }));
    expect((await ask(body(), e)).status).toBe(200);
  });
});
