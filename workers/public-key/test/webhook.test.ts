import { createExecutionContext, env as testEnv } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { b64urlDecode, verifyKey, FEATURES } from "../../../packages/signing/src/index.ts";
import worker, { type Env } from "../src/index.ts";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const NONCE = "acme-nonce-0123456789abcdef";

interface Point {
  indexes?: string[];
  blobs?: string[];
  doubles?: number[];
}

interface GitHubCall {
  url: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown>;
}

let calls: GitHubCall[];
let points: Point[];
let checkRunAnswer: () => Response;

function dispatch(over: Record<string, unknown> = {}, client: Record<string, unknown> = {}) {
  return {
    action: "claudinite-key-public",
    repository: { id: 1001, name: "acme-repo", full_name: "acme-user/acme-repo", private: false, owner: { id: 2002, login: "acme-user", type: "User" } },
    installation: { id: 5005 },
    sender: { id: 3003, login: "acme-dev", type: "User" },
    client_payload: { nonce: NONCE, engine_version: "1.1.0", head: HEAD, ...client },
    ...over,
  };
}

function env(): Env {
  return { ...(testEnv as unknown as Env), KEY_COUNTS: { writeDataPoint: (p: Point) => void points.push(p) } as unknown as AnalyticsEngineDataset };
}

async function post(payload: unknown): Promise<Response> {
  const req = new Request("https://public-key/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-GitHub-Event": "repository_dispatch", "X-GitHub-Delivery": "acme-delivery" },
    body: JSON.stringify(payload),
  });
  return worker.fetch(req, env(), createExecutionContext());
}

beforeEach(() => {
  calls = [];
  points = [];
  checkRunAnswer = () => Response.json({ id: 77 }, { status: 201 });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const text = await req.text();
    calls.push({ url: req.url, method: req.method, headers: req.headers, body: text ? JSON.parse(text) : {} });
    if (req.url.endsWith("/access_tokens")) return Response.json({ token: "ghs_acme", expires_at: "2099-01-01T00:00:00Z" }, { status: 201 });
    if (req.url.endsWith("/check-runs")) return checkRunAnswer();
    return new Response("unexpected", { status: 599 });
  });
});

afterEach(() => vi.restoreAllMocks());

describe("public key webhook", () => {
  it("answers a public repo's dispatch with one check run carrying a verifying Public key", async () => {
    const res = await post(dispatch());
    expect(res.status).toBe(201);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST https://github-api.test/app/installations/5005/access_tokens",
      "POST https://github-api.test/repos/acme-user/acme-repo/check-runs",
    ]);
    const run = calls[1]!.body as { name: string; head_sha: string; external_id: string; status: string; conclusion: string; output: { title: string; summary: string; text: string } };
    expect(run).toMatchObject({ name: "Claudinite key", head_sha: HEAD, external_id: NONCE, status: "completed", conclusion: "neutral" });
    expect(calls[1]!.headers.get("Authorization")).toBe("Bearer ghs_acme");
    expect(run.output.summary).toMatch(/^public key for @acme-dev \(sender type User\), issued \d{4}-\d\d-\d\dT/);

    const verdict = await verifyKey(run.output.text, { roots: JSON.parse((testEnv as unknown as { DEV_ROOTS: string }).DEV_ROOTS), now: new Date() });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    const p = verdict.payload;
    expect(p).toMatchObject({ typ: "session", plan: "public", state: "ok", user_id: 3003, nonce: NONCE, repo_id: 1001, owner_id: 2002, owner_type: "User", owner_login: "acme-user" });
    expect(p.exp - p.iat).toBe(7 * 86400);
    expect([...p.features].sort()).toEqual(FEATURES.filter((f) => f !== "fleet").sort());
    expect(points).toEqual([{ indexes: ["1001"], blobs: ["public", "issued", "User", "1.1.0"], doubles: [1] }]);
  });

  it("asks for an installation token scoped to the repo with checks: write only", async () => {
    await post(dispatch());
    expect(calls[0]!.body).toEqual({ repositories: ["acme-repo"], permissions: { checks: "write" } });
  });

  it("signs the App JWT with RS256, issued by the App id, living at most 10 minutes", async () => {
    await post(dispatch());
    const auth = calls[0]!.headers.get("Authorization")!;
    expect(auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    const [h, c] = auth.slice(7).split(".");
    const header = JSON.parse(new TextDecoder().decode(b64urlDecode(h!)));
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(c!)));
    expect(header.alg).toBe("RS256");
    expect(claims.iss).toBe((testEnv as unknown as Env).GITHUB_APP_ID);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
  });

  it("refuses a Bot sender with 403 and no GitHub call", async () => {
    const res = await post(dispatch({ sender: { id: 9, login: "acme-bot[bot]", type: "Bot" } }));
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("sender-not-user");
    expect(calls).toHaveLength(0);
    expect(points.map((p) => p.blobs?.[1])).toEqual(["refused-sender"]);
  });

  it("answers a private repo with a refusal check run that carries no key", async () => {
    const res = await post(dispatch({ repository: { ...dispatch().repository, private: true } }));
    expect(res.status).toBe(201);
    const run = calls[1]!.body as { output: Record<string, string> };
    expect(run.output.title).toBe("Claudinite key refused");
    expect(run.output.summary).toMatch(/private/);
    expect(run.output).not.toHaveProperty("text");
    expect(points.map((p) => p.blobs?.[1])).toEqual(["refused-private"]);
  });

  it("refuses a malformed nonce, head or a missing installation with 400 and no GitHub call", async () => {
    for (const payload of [
      dispatch({}, { nonce: "short" }),
      dispatch({}, { nonce: "a".repeat(65) }),
      dispatch({}, { nonce: "has space in it 0123" }),
      dispatch({}, { head: HEAD.toUpperCase() }),
      dispatch({}, { head: "abc" }),
      dispatch({ installation: undefined }),
    ]) {
      expect((await post(payload)).status).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it("answers 502 on a secondary rate limit and logs the marker", async () => {
    checkRunAnswer = () => Response.json({ message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again." }, { status: 403 });
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
    const res = await post(dispatch());
    expect(res.status).toBe(502);
    expect(logs.some((l) => l.includes("secondary-rate-limit"))).toBe(true);
    expect(points.map((p) => p.blobs?.[1])).toEqual(["github-error"]);
  });
});

describe("health", () => {
  it("names the issuing key and its certificate's expiry without calling GitHub", async () => {
    const res = await worker.fetch(new Request("https://license.claudinite.com/v1/public/health"), env(), createExecutionContext());
    expect(res.status).toBe(200);
    const cert = JSON.parse((testEnv as unknown as Env).ISSUING_KEY_CERT);
    const body = JSON.parse(new TextDecoder().decode(b64urlDecode(cert.payload)));
    expect(await res.json()).toEqual({ ok: true, kid: body.keyId, cert_exp: body.notAfter });
    expect(calls).toHaveLength(0);
  });
});
