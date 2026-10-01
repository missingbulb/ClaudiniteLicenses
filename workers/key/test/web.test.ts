import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FEATURES } from "../../../packages/signing/src/index.ts";
import { call, certKeyId, certUse, env, freshDatabase, HEAD, NONCE, resetWorld, seedRepo, verified, world } from "./helpers.ts";

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
    expect(run.output.summary).toMatch(/^public key for @acme-dev \(sender type User\), issued \d{4}-/);
    const p = await verified(run.output.text!);
    expect(p).toMatchObject({ typ: "session", plan: "public", state: "ok", kid: certKeyId(), user_id: 3003, nonce: NONCE, repo_id: 1001, owner_id: 2002, owner_type: "User", owner_login: "acme-user" });
    expect(certUse(run.output.text!)).toBe("license");
    expect(p.exp - p.iat).toBe(7 * 86400);
    expect([...p.features].sort()).toEqual(FEATURES.filter((f) => f !== "fleet").sort());
    expect(world.points).toEqual([{ indexes: ["1001"], blobs: ["public", "issued", "User", "1.1.0", "web"], doubles: [1] }]);
  });

  it("answers a private repo's dispatch with a refusal check run naming no-plan and carrying no key", async () => {
    await seedRepo({ visibility: "private" });
    const res = await post(dispatch({ repository: { ...dispatch().repository, private: true } }));
    expect(res.status).toBe(201);
    const run = checkRun();
    expect(run.output.title).toBe("Claudinite key refused");
    expect(run.output.summary).toBe("no-plan: this private repo has no plan yet; the Public plan covers public repos only");
    expect(run.output).not.toHaveProperty("text");
    expect(world.points.map((p) => p.blobs)).toEqual([["none", "refused-no-plan", "User", "1.1.0", "web"]]);
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
    expect([...p.features].sort()).toEqual([...FEATURES].sort());
    expect(run.output.summary).toMatch(/unverified/);
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
