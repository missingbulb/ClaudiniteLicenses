import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refusalSummary } from "../../../packages/github-app/src/index.ts";
import { FEATURES } from "../../../packages/signing/src/index.ts";
import { REFUSAL_TEXT } from "../src/plan.ts";
import webSource from "../src/web.ts?raw";
import { call, certKeyId, certUse, CHECKOUT_URL, DAY, env, freshDatabase, HEAD, NONCE, nowS, POLAR, resetWorld, seedRepo, sentMessages, verified, world } from "./helpers.ts";

function dispatch(over: Record<string, unknown> = {}) {
  return {
    action: "claudinite-key",
    repository: { id: 1001, name: "acme-repo", full_name: "acme-user/acme-repo", private: false, owner: { id: 2002, login: "acme-user", type: "User" } },
    installation: { id: 5005 },
    sender: { id: 3003, login: "acme-dev", type: "User" },
    client_payload: { nonce: NONCE, engine_version: "1.1.0", head: HEAD },
    ...over,
  };
}

const post = (payload: unknown, e = env()) =>
  call("/webhook", { method: "POST", headers: { "Content-Type": "application/json", "X-GitHub-Event": "repository_dispatch", "X-GitHub-Delivery": "acme-delivery" }, body: JSON.stringify(payload) }, e);

type Run = { name: string; head_sha: string; external_id: string; status: string; conclusion: string; output: { title: string; summary: string; text?: string } };
const checkRun = () => JSON.parse(world.calls.find((c) => c.url.endsWith("/check-runs"))!.body) as Run;

beforeEach(async () => {
  await freshDatabase();
  resetWorld();
});

afterEach(() => vi.restoreAllMocks());

describe("web path", () => {
  it("answers a public repo's claudinite-key dispatch with one check run carrying a license-signed Public key", async () => {
    await seedRepo();
    const res = await post(dispatch());
    expect(res.status).toBe(201);
    expect(world.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST https://github-api.test/app/installations/5005/access_tokens",
      "POST https://github-api.test/repos/acme-user/acme-repo/check-runs",
    ]);
    const run = checkRun();
    expect(run).toMatchObject({ name: "Claudinite key", head_sha: HEAD, external_id: NONCE, status: "completed", conclusion: "neutral", output: { title: "Claudinite key" } });
    expect(run.output.summary).toMatch(/^public key for @acme-dev \(sender type User\), state ok, issued \d{4}-/);
    const p = await verified(run.output.text!);
    expect(p).toMatchObject({ typ: "session", plan: "public", state: "ok", kid: certKeyId(), user_id: 3003, nonce: NONCE, repo_id: 1001, owner_id: 2002, owner_type: "User", owner_login: "acme-user" });
    expect(certUse(run.output.text!)).toBe("license");
    expect(p.exp - p.iat).toBe(7 * 86400);
    expect([...p.features].sort()).toEqual(FEATURES.filter((f) => f !== "fleet").sort());
    expect(world.points).toEqual([{ indexes: ["1001"], blobs: ["public", "issued-ok", "User", "1.1.0", "web"], doubles: [1] }]);
    expect(p).toMatchObject({ seats: null, checkout_url: null, portal_url: null, notice: null });
    expect(world.calls.filter((c) => c.url.startsWith(POLAR))).toEqual([]);
    expect(world.sent).toEqual([]);
  });

  const privateDispatch = () => dispatch({ repository: { ...dispatch().repository, private: true } });

  it("answers a private repo with no plan with a grace key carrying seats and the checkout link, and names overused", async () => {
    await seedRepo({ visibility: "private" });
    const res = await post(privateDispatch());
    expect(res.status).toBe(201);
    const run = checkRun();
    expect(run.output.title).toBe("Claudinite key");
    expect(run.output.summary).toMatch(/^private-repo key for @acme-dev \(sender type User\), state grace, overused, issued \d{4}-/);
    const p = await verified(run.output.text!);
    expect(p).toMatchObject({ plan: "private-repo", state: "grace", seats: { paid: 0, counted: 1, headroom: 0 }, checkout_url: CHECKOUT_URL, portal_url: null, notice: "overused" });
    expect(run.output.summary).toContain(`, ${p.notice},`);
    expect(p.grace_until! - nowS()).toBeGreaterThan(7 * DAY - 10);
    const checkout = JSON.parse(world.calls.find((c) => c.url === `${POLAR}/v1/checkouts/`)!.body);
    expect(checkout).toMatchObject({ external_customer_id: "2002", metadata: { claudinite_plan: "private-repo", github_repo_id: "1001", github_repo_full_name: "acme-user/acme-repo" } });
    expect(world.points.map((x) => x.blobs?.[1])).toEqual(["issued-grace"]);
    expect(sentMessages().map((m) => m.kind)).toEqual(["usage", "grace-start"]);
  });

  it("issues the key with a null checkout link and logs polar-unreachable when Polar answers 500", async () => {
    await seedRepo({ visibility: "private" });
    world.polarCheckout = () => Response.json({ detail: "boom" }, { status: 500 });
    await post(privateDispatch());
    const p = await verified(checkRun().output.text!);
    expect(p).toMatchObject({ state: "grace", checkout_url: null });
    expect(world.logs.some((l) => l.includes('"marker":"polar-unreachable"'))).toBe(true);
  });

  it("issues the key with a null checkout link when Polar takes longer than 3 seconds", async () => {
    await seedRepo({ visibility: "private" });
    const realSetTimeout = globalThis.setTimeout;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      world.polarCheckout = () => new Promise<Response>(() => {});
      let done = false;
      const answered = post(privateDispatch()).finally(() => (done = true));
      for (let i = 0; i < 200 && !done; i++) {
        await vi.advanceTimersByTimeAsync(250);
        await new Promise((ok) => realSetTimeout(ok, 5));
      }
      expect((await answered).status).toBe(201);
    } finally {
      vi.useRealTimers();
    }
    const p = await verified(checkRun().output.text!);
    expect(p).toMatchObject({ state: "grace", checkout_url: null });
    expect(world.logs.some((l) => l.includes('"marker":"polar-unreachable"'))).toBe(true);
  });

  it("issues for a public repo whose row the sync Worker has not written yet: the webhook proves the installation", async () => {
    const res = await post(dispatch());
    expect(res.status).toBe(201);
    expect((await verified(checkRun().output.text!)).plan).toBe("public");
  });

  it("issues an unverified key with every feature when D1 cannot be read", async () => {
    const res = await post(dispatch(), env({ brokenDb: true }));
    expect(res.status).toBe(201);
    const run = checkRun();
    const p = await verified(run.output.text!);
    expect(p).toMatchObject({ state: "unverified", plan: "public" });
    expect(world.calls.filter((c) => c.url.startsWith(POLAR))).toEqual([]);
    expect([...p.features].sort()).toEqual([...FEATURES].sort());
    expect(run.output.summary).toMatch(/unverified/);
  });

  it("writes a refusal summary the binary cuts at its first colon, through the one shared spelling", async () => {
    const res = await post(dispatch(), env({ brokenDb: true, FAIL_OPEN: "false" }));
    expect(res.status).toBe(201);
    const run = checkRun();
    expect(run.output.title).toBe("Claudinite key refused");
    expect(run.output.summary).toBe(`server-error: ${REFUSAL_TEXT["server-error"]}`);
    expect(run.output.summary).toMatch(/^server-error: [^:]+$/);
    // app-not-installed cannot reach the web path, whose webhook proves the installation; it still composes.
    for (const [reason, text] of Object.entries(REFUSAL_TEXT)) expect(refusalSummary(reason, text)).toMatch(new RegExp(`^${reason}: [^:]+$`));
    expect(webSource).toMatch(/import \{[^}]*\brefusalSummary\b[^}]*\} from "..\/..\/..\/packages\/github-app\/src\/index\.ts"/);
    expect(webSource).not.toMatch(/`\$\{plan\.refused\}: /);
  });

  it("refuses a Bot sender with 403 and no GitHub call", async () => {
    const res = await post(dispatch({ sender: { id: 9, login: "acme-bot[bot]", type: "Bot" } }));
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("sender-not-user");
    expect(world.calls).toHaveLength(0);
    expect(world.points.map((p) => p.blobs?.[1])).toEqual(["refused-sender"]);
  });

  it("refuses a malformed nonce with 400 and no GitHub call", async () => {
    const res = await post({ ...dispatch(), client_payload: { nonce: "short", head: HEAD } });
    expect(res.status).toBe(400);
    expect(world.calls).toHaveLength(0);
  });
});
