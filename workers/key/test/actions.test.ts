import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FEATURES } from "../../../packages/signing/src/index.ts";
import { resetJwksCache } from "../src/oidc.ts";
import { actionsClaims, call, certUse, CHECKOUT_URL, env, freshDatabase, lastCheckout, oidcIssuer, polarCalls, PORTAL_URL, resetWorld, seedRepo, seedSubscription, verified, world } from "./helpers.ts";

let issuer: Awaited<ReturnType<typeof oidcIssuer>>;
const jwksCalls = () => world.calls.filter((c) => c.url === "https://oidc.test/.well-known/jwks").length;

const ask = (token: string | null, e = env()) =>
  call("/v1/actions-key", { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ engine_version: "1.1.0" }) }, e);

async function refusedWith(token: string, status: number, reason: string, e = env()) {
  const res = await ask(token, e);
  expect([res.status, await res.json()], reason).toEqual([status, { refused: reason }]);
}

beforeEach(async () => {
  await freshDatabase();
  resetWorld();
  resetJwksCache();
  issuer = await oidcIssuer();
  world.jwks = () => Response.json({ keys: [issuer.jwk] });
});

afterEach(() => vi.restoreAllMocks());

describe("POST /v1/actions-key", () => {
  it("exchanges a good token from the scheduler on the default branch for a 6-hour Actions key, Public with the Personal fleet's checkout for a User with no fleet", async () => {
    await seedRepo();
    const res = await ask(await issuer.sign(actionsClaims()));
    expect(res.status).toBe(200);
    const out = (await res.json()) as { key: string; plan: string; state: string };
    expect(out).toEqual({ key: out.key, plan: "public", state: "ok", notice: null, checkout_url: CHECKOUT_URL, portal_url: null });
    const p = await verified(out.key);
    expect(p).toMatchObject({ typ: "actions", plan: "public", repo_id: 1001, owner_id: 2002, owner_type: "User", owner_login: "acme-user", seats: null, checkout_url: CHECKOUT_URL, portal_url: null });
    expect(p).not.toHaveProperty("user_id");
    expect(p).not.toHaveProperty("nonce");
    expect(p.exp - p.iat).toBe(6 * 3600);
    expect(p.notice).toBeNull();
    expect([...p.features].sort()).toEqual(FEATURES.filter((f) => f !== "fleet").sort());
    expect(certUse(out.key)).toBe("license");
    expect(world.points).toEqual([{ indexes: ["1001"], blobs: ["public", "issued-ok", "User", "1.1.0", "actions"], doubles: [1] }]);
    expect(world.sent).toEqual([]);
    expect(lastCheckout()).toEqual({
      products: ["prod_personal_month", "prod_personal_year"],
      external_customer_id: "2002",
      metadata: { claudinite_plan: "personal", github_owner_id: "2002", github_owner_login: "acme-user", github_owner_type: "User" },
    });
    expect(polarCalls().map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(["GET /v1/products/", "POST /v1/checkouts/"]);
  });

  it("answers a private repo of an owner with no fleet Public too: one repo is free whatever its visibility", async () => {
    await seedRepo({ visibility: "private" });
    const out = (await (await ask(await issuer.sign(actionsClaims({ repository_visibility: "private" })))).json()) as Record<string, unknown>;
    expect(out).toMatchObject({ plan: "public", state: "ok", checkout_url: CHECKOUT_URL });
  });

  it("offers an Organization with no fleet the Organization fleet's checkout, and its portal once it has any subscription", async () => {
    await seedRepo({ owner_id: 8008, owner_type: "Organization", owner_login: "acme-org", full_name: "acme-org/acme-repo" });
    await seedSubscription({ owner_id: 8008, owner_type: "Organization", plan: "personal" });
    const claims = actionsClaims({ repository_owner_id: "8008", repository: "acme-org/acme-repo", repository_owner: "acme-org", job_workflow_ref: "acme-org/acme-repo/.github/workflows/claudinite-scheduler.yml@refs/heads/main" });
    const out = (await (await ask(await issuer.sign(claims))).json()) as Record<string, unknown>;
    expect(out).toMatchObject({ plan: "public", state: "ok", checkout_url: CHECKOUT_URL, portal_url: PORTAL_URL });
    expect(lastCheckout()).toMatchObject({ products: ["prod_organization_month", "prod_organization_year"], external_customer_id: "8008", metadata: { claudinite_plan: "organization", github_owner_type: "Organization" } });
  });

  it("gives a User paying for the Personal fleet a Personal key with every feature, asking Polar nothing", async () => {
    await seedRepo({ visibility: "private" });
    await seedSubscription({ plan: "personal" });
    const out = (await (await ask(await issuer.sign(actionsClaims()))).json()) as Record<string, unknown>;
    expect(out).toEqual({ key: out.key, plan: "personal", state: "ok", notice: null, checkout_url: null, portal_url: null });
    expect(await verified(out.key as string)).toMatchObject({ plan: "personal", seats: null, features: [...FEATURES] });
    expect(polarCalls()).toEqual([]);
    expect(world.points.at(-1)!.blobs).toEqual(["personal", "issued-ok", "User", "1.1.0", "actions"]);
  });

  it("accepts the executor and the update workflows, and any trigger but a pull request's", async () => {
    await seedRepo();
    for (const name of ["claudinite-executor", "claudinite-update"]) {
      for (const event_name of ["workflow_dispatch", "issues", "push"]) {
        const res = await ask(await issuer.sign(actionsClaims({ event_name, job_workflow_ref: `acme-user/acme-repo/.github/workflows/${name}.yml@refs/heads/main` })));
        expect(res.status, `${name} ${event_name}`).toBe(200);
      }
    }
  });

  it("refuses a pull request trigger", async () => {
    await seedRepo();
    for (const event_name of ["pull_request", "pull_request_target"]) {
      await refusedWith(await issuer.sign(actionsClaims({ event_name })), 403, "pull-request-trigger");
    }
  });

  it("refuses a workflow that is not one of the three on the default branch", async () => {
    await seedRepo();
    for (const job_workflow_ref of [
      "acme-user/acme-repo/.github/workflows/deploy.yml@refs/heads/main",
      "acme-user/acme-repo/.github/workflows/claudinite-scheduler.yml@refs/heads/feature",
      "acme-user/acme-repo/.github/workflows/claudinite-scheduler.yml@refs/tags/v1",
      "acme-fork/acme-repo/.github/workflows/claudinite-scheduler.yml@refs/heads/main",
      "acme-user/acme-repo/.github/workflows/claudinite-scheduler.yaml@refs/heads/main",
    ]) {
      await refusedWith(await issuer.sign(actionsClaims({ job_workflow_ref })), 403, "workflow-not-pinned");
    }
  });

  // claudinite-ci is not pinned: it runs on pull_request and on a dispatch against the update PR's
  // branch, which the trigger and default-branch halves refuse whatever the name.
  it("refuses claudinite-ci on the default branch beside a pinned name that passes", async () => {
    await seedRepo();
    const ref = (name: string) => `acme-user/acme-repo/.github/workflows/${name}.yml@refs/heads/main`;
    expect((await ask(await issuer.sign(actionsClaims({ event_name: "workflow_dispatch", job_workflow_ref: ref("claudinite-update") })))).status).toBe(200);
    await refusedWith(await issuer.sign(actionsClaims({ event_name: "workflow_dispatch", job_workflow_ref: ref("claudinite-ci") })), 403, "workflow-not-pinned");
  });

  it("refuses a repo whose default branch the sync Worker has not read yet, rather than guessing", async () => {
    await seedRepo({ default_branch: null });
    await refusedWith(await issuer.sign(actionsClaims()), 403, "repo-not-synced");
  });

  it("refuses a repo the App is not installed on", async () => {
    await refusedWith(await issuer.sign(actionsClaims()), 403, "app-not-installed");
  });

  it("gives a repo of an Organization paying for the Organization fleet an ok Organization key, whatever its seat count, and a Personal row on an Organization no fleet", async () => {
    await seedRepo({ owner_id: 8008, owner_type: "Organization", owner_login: "acme-org", full_name: "acme-org/acme-repo" });
    await seedSubscription({ owner_id: 8008, owner_type: "Organization", plan: "organization", seats: 1 });
    const claims = actionsClaims({ repository_owner_id: "8008", repository: "acme-org/acme-repo", repository_owner: "acme-org", job_workflow_ref: "acme-org/acme-repo/.github/workflows/claudinite-scheduler.yml@refs/heads/main" });
    const out = (await (await ask(await issuer.sign(claims))).json()) as Record<string, unknown>;
    expect(out).toMatchObject({ plan: "organization", state: "ok", checkout_url: null, portal_url: null });
    expect((await verified(out.key as string)).features).toEqual([...FEATURES]);
    expect(polarCalls()).toEqual([]);
  });

  it("refuses a token whose audience, issuer, lifetime or signature is wrong, naming each", async () => {
    await seedRepo();
    const now = Math.floor(Date.now() / 1000);
    await refusedWith(await issuer.sign(actionsClaims({ aud: "sts.amazonaws.com" })), 401, "token-audience");
    await refusedWith(await issuer.sign(actionsClaims({ iss: "https://elsewhere.test" })), 401, "token-issuer");
    await refusedWith(await issuer.sign(actionsClaims({ exp: now - 301, iat: now - 900, nbf: now - 900 })), 401, "token-expired");
    await refusedWith(await issuer.sign(actionsClaims({ nbf: now + 600, iat: now + 600 })), 401, "token-not-yet-valid");
    const stranger = await oidcIssuer("acme-kid-stranger");
    await refusedWith(await stranger.sign(actionsClaims()), 401, "token-unknown-key");
    const good = await issuer.sign(actionsClaims());
    const [h, , s] = good.split(".");
    const tampered = `${h}.${btoa(JSON.stringify(actionsClaims({ repository_id: "4040" }))).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")}.${s}`;
    await refusedWith(tampered, 401, "token-signature");
    await refusedWith("not.a.jwt", 401, "token-malformed");
    await refusedWith(await issuer.sign(actionsClaims({ repository_id: undefined })), 401, "token-claims");
    const res = await ask(null);
    expect([res.status, await res.json()]).toEqual([401, { refused: "token-missing" }]);
  });

  it("accepts a token within the five-minute skew", async () => {
    await seedRepo();
    const now = Math.floor(Date.now() / 1000);
    expect((await ask(await issuer.sign(actionsClaims({ exp: now - 200, iat: now - 900, nbf: now - 900 })))).status).toBe(200);
    expect((await ask(await issuer.sign(actionsClaims({ nbf: now + 200, iat: now + 200 })))).status).toBe(200);
  });

  it("caches the JWKS and refetches it exactly once on an unknown kid", async () => {
    await seedRepo();
    await ask(await issuer.sign(actionsClaims()));
    await ask(await issuer.sign(actionsClaims()));
    expect(jwksCalls()).toBe(1);
    const rotated = await oidcIssuer("acme-kid-2");
    world.jwks = () => Response.json({ keys: [issuer.jwk, rotated.jwk] });
    expect((await ask(await rotated.sign(actionsClaims()))).status).toBe(200);
    expect(jwksCalls()).toBe(2);
  });

  it("refetches the JWKS for an unknown kid at most once every 30 seconds", async () => {
    await seedRepo();
    const unknown = await oidcIssuer("acme-kid-3");
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(start);
      await ask(await issuer.sign(actionsClaims()));
      expect(jwksCalls()).toBe(1);
      for (let i = 0; i < 20; i++) await refusedWith(await unknown.sign(actionsClaims()), 401, "token-unknown-key");
      expect(jwksCalls()).toBe(2);
      vi.setSystemTime(start + 29_000);
      await refusedWith(await unknown.sign(actionsClaims()), 401, "token-unknown-key");
      expect(jwksCalls()).toBe(2);
      vi.setSystemTime(start + 31_000);
      await refusedWith(await unknown.sign(actionsClaims()), 401, "token-unknown-key");
      expect(jwksCalls()).toBe(3);
      expect((await ask(await issuer.sign(actionsClaims()))).status).toBe(200);
      expect(jwksCalls()).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers 503 server-error when D1 cannot be read, since the pin needs the repo's default branch", async () => {
    await refusedWith(await issuer.sign(actionsClaims()), 503, "server-error", env({ brokenDb: true }));
    expect(world.logs.some((l) => l.includes("d1-unreadable"))).toBe(true);
  });

  it("answers the 601st request for one owner with 429 and no D1 or GitHub call, while another owner still answers", async () => {
    await seedRepo();
    await seedRepo({ repo_id: 1002, owner_id: 2003, owner_login: "acme-other", full_name: "acme-other/acme-repo" });
    const e = env();
    await ask(await issuer.sign(actionsClaims()), e);
    world.limited["owner:acme-user"] = 600;
    const before = { calls: world.calls.length, db: world.dbCalls };
    await refusedWith(await issuer.sign(actionsClaims()), 429, "rate-limited", e);
    expect({ calls: world.calls.length, db: world.dbCalls }).toEqual(before);
    const other = actionsClaims({ repository_id: "1002", repository_owner_id: "2003", repository: "acme-other/acme-repo", repository_owner: "acme-other", job_workflow_ref: "acme-other/acme-repo/.github/workflows/claudinite-scheduler.yml@refs/heads/main" });
    expect((await ask(await issuer.sign(other), e)).status).toBe(200);
  });
});
