import { createExecutionContext, env as testEnv } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { b64urlDecode, FEATURES, verifyKey } from "../../../packages/signing/src/index.ts";
import worker, { type Env } from "../src/index.ts";

const NONCE = "acme-nonce-0123456789abcdef";
let calls: { url: string; auth: string | null }[];
let points: { blobs?: string[] }[];
let repo: () => Response;

const roots = JSON.parse((testEnv as unknown as { DEV_ROOTS: string }).DEV_ROOTS) as string[];
const env = () => ({ ...(testEnv as unknown as Env), KEY_COUNTS: { writeDataPoint: (p: { blobs?: string[] }) => void points.push(p) } as unknown as AnalyticsEngineDataset });
const ask = (body: unknown, token: string | null = "ghu_acme") =>
  worker.fetch(
    new Request("https://license.claudinite.com/v1/public/session-key", { method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body) }),
    env(),
    createExecutionContext(),
  );
const body = (over: Record<string, unknown> = {}) => ({ repo: "acme-user/acme-repo", nonce: NONCE, engine_version: "1.1.0", ...over });
const githubRepo = (over: Record<string, unknown> = {}) => ({ id: 1001, name: "acme-repo", full_name: "acme-user/acme-repo", private: false, owner: { id: 2002, login: "acme-user", type: "User" }, permissions: { push: true }, ...over });

beforeEach(() => {
  calls = [];
  points = [];
  repo = () => Response.json(githubRepo());
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    calls.push({ url: req.url, auth: req.headers.get("Authorization") });
    if (req.url === "https://github-api.test/user") return Response.json({ id: 3003, login: "acme-dev", type: "User" });
    if (req.url === "https://github-api.test/repos/acme-user/acme-repo") return repo();
    return new Response("unexpected", { status: 599 });
  });
});

afterEach(() => vi.restoreAllMocks());

describe("POST /v1/public/session-key", () => {
  it("signs a Public session key with the license-public certificate for a public repo, bound to GitHub's user and the nonce", async () => {
    const res = await ask(body());
    expect(res.status).toBe(200);
    const out = (await res.json()) as { key: string; plan: string; state: string };
    expect(out).toMatchObject({ plan: "public", state: "ok" });
    const v = await verifyKey(out.key, { roots, now: new Date() });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.payload).toMatchObject({ typ: "session", plan: "public", user_id: 3003, nonce: NONCE, repo_id: 1001, owner_id: 2002 });
    expect(v.payload.exp - v.payload.iat).toBe(7 * 86400);
    expect(v.payload.notice).toBeNull();
    expect([...v.payload.features].sort()).toEqual(FEATURES.filter((f) => f !== "fleet").sort());
    const cert = JSON.parse(new TextDecoder().decode(b64urlDecode(JSON.parse(out.key).certificate.payload)));
    expect(cert.use).toBe("license-public");
    expect(calls.map((c) => `${c.url} ${c.auth}`)).toEqual(["https://github-api.test/user Bearer ghu_acme", "https://github-api.test/repos/acme-user/acme-repo Bearer ghu_acme"]);
    expect(points.map((p) => p.blobs)).toEqual([["public", "issued", "User", "1.1.0", "desktop"]]);
  });

  it("refuses a private repo with 403 refused-private", async () => {
    repo = () => Response.json(githubRepo({ private: true }));
    const res = await ask(body());
    expect([res.status, await res.json()]).toEqual([403, { refused: "refused-private" }]);
    expect(points.map((p) => p.blobs?.[1])).toEqual(["refused-private"]);
  });

  it("refuses what the paid Worker refuses before deciding a plan", async () => {
    repo = () => Response.json({ message: "Not Found" }, { status: 404 });
    expect(await (await ask(body())).json()).toEqual({ refused: "repo-not-visible" });
    repo = () => Response.json(githubRepo({ permissions: { push: false } }));
    expect(await (await ask(body())).json()).toEqual({ refused: "no-push-access" });
  });

  it("refuses a malformed nonce with 400 and a missing token with 401, before any GitHub call", async () => {
    expect((await ask(body({ nonce: "short" }))).status).toBe(400);
    expect((await ask(body(), null)).status).toBe(401);
    expect(calls).toHaveLength(0);
  });
});
