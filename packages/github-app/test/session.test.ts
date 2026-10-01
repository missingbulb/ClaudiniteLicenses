import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDesktopRequest, parseKeyDispatch, readDesktopCaller } from "../src/index.ts";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const NONCE = "acme-nonce-0123456789abcdef";
const api = { base: "https://github-api.test", userAgent: "acme-agent" };

function dispatch(over: Record<string, unknown> = {}, client: Record<string, unknown> = {}) {
  return {
    action: "claudinite-key",
    repository: { id: 1001, name: "acme-repo", full_name: "acme-user/acme-repo", private: false, owner: { id: 2002, login: "acme-user", type: "User" } },
    installation: { id: 5005 },
    sender: { id: 3003, login: "acme-dev", type: "User" },
    client_payload: { nonce: NONCE, engine_version: "1.1.0", head: HEAD, ...client },
    ...over,
  };
}

describe("parseKeyDispatch", () => {
  it("reads a well-formed dispatch", () => {
    expect(parseKeyDispatch(dispatch())).toEqual({
      ok: true,
      dispatch: {
        repo: { id: 1001, name: "acme-repo", fullName: "acme-user/acme-repo", private: false },
        owner: { id: 2002, login: "acme-user", type: "User" },
        installationId: 5005,
        sender: { id: 3003, login: "acme-dev" },
        nonce: NONCE,
        head: HEAD,
        engineVersion: "1.1.0",
      },
    });
  });

  it("refuses a Bot sender before anything else, keeping what a usage count needs", () => {
    expect(parseKeyDispatch(dispatch({ sender: { id: 9, login: "acme-bot[bot]", type: "Bot" }, installation: undefined }))).toEqual({
      ok: false,
      status: 403,
      reason: "sender-not-user",
      seen: { repoId: "1001", ownerType: "User", engineVersion: "1.1.0" },
    });
  });

  it("refuses a malformed nonce, head, installation or repository with 400", () => {
    const cases: [unknown, string][] = [
      [dispatch({}, { nonce: "short" }), "bad-nonce"],
      [dispatch({}, { nonce: "a".repeat(65) }), "bad-nonce"],
      [dispatch({}, { nonce: "has space in it 0123" }), "bad-nonce"],
      [dispatch({}, { head: HEAD.toUpperCase() }), "bad-head"],
      [dispatch({ installation: undefined }), "no-installation"],
      [dispatch({ repository: { id: "1001" } }), "malformed-payload"],
      ["junk", "sender-not-user"],
    ];
    for (const [payload, reason] of cases) {
      const res = parseKeyDispatch(payload);
      expect(res.ok ? "ok" : res.reason, JSON.stringify(payload)).toBe(reason);
    }
  });
});

describe("parseDesktopRequest", () => {
  const req = (body: unknown, auth: string | null = "Bearer ghu_acme") =>
    new Request("https://x/v1/session-key", { method: "POST", headers: auth ? { Authorization: auth } : {}, body: typeof body === "string" ? body : JSON.stringify(body) });

  it("reads the token, repo, nonce and engine version", async () => {
    expect(await parseDesktopRequest(req({ repo: "acme-user/acme-repo", nonce: NONCE, engine_version: "1.1.0" }))).toEqual({
      ok: true,
      request: { token: "ghu_acme", owner: "acme-user", name: "acme-repo", nonce: NONCE, engineVersion: "1.1.0" },
    });
  });

  it("refuses a missing token with 401 and a malformed body with 400", async () => {
    expect(await parseDesktopRequest(req({ repo: "acme-user/acme-repo", nonce: NONCE }, null))).toMatchObject({ ok: false, status: 401, reason: "token-missing" });
    for (const body of ["{", { repo: "acme-user", nonce: NONCE }, { repo: "acme-user/acme-repo", nonce: "short" }, { repo: "a/b/c", nonce: NONCE }]) {
      expect(await parseDesktopRequest(req(body)), JSON.stringify(body)).toMatchObject({ ok: false, status: 400 });
    }
  });
});

describe("readDesktopCaller", () => {
  let calls: { url: string; auth: string | null }[];
  let user: () => Response;
  let repo: () => Response;

  beforeEach(() => {
    calls = [];
    user = () => Response.json({ id: 3003, login: "acme-dev", type: "User" });
    repo = () => Response.json({ id: 1001, name: "acme-repo", full_name: "acme-user/acme-repo", private: false, visibility: "public", owner: { id: 2002, login: "acme-user", type: "User" }, permissions: { push: true } });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const r = new Request(input, init);
      calls.push({ url: r.url, auth: r.headers.get("Authorization") });
      if (r.url.endsWith("/user")) return user();
      if (r.url.endsWith("/repos/acme-user/acme-repo")) return repo();
      return new Response("unexpected", { status: 599 });
    });
  });

  afterEach(() => vi.restoreAllMocks());

  const read = () => readDesktopCaller(api, "ghu_acme", "acme-user", "acme-repo");

  it("reads the user and the repo as the caller", async () => {
    expect(await read()).toEqual({
      ok: true,
      user: { id: 3003, login: "acme-dev" },
      repo: { id: 1001, name: "acme-repo", fullName: "acme-user/acme-repo", private: false },
      owner: { id: 2002, login: "acme-user", type: "User" },
    });
    expect(calls).toEqual([
      { url: "https://github-api.test/user", auth: "Bearer ghu_acme" },
      { url: "https://github-api.test/repos/acme-user/acme-repo", auth: "Bearer ghu_acme" },
    ]);
  });

  it("names each refusal", async () => {
    user = () => Response.json({ message: "Bad credentials" }, { status: 401 });
    expect(await read()).toEqual({ ok: false, status: 401, reason: "token-invalid" });
    user = () => Response.json({ id: 1, login: "acme-org", type: "Organization" });
    expect(await read()).toEqual({ ok: false, status: 403, reason: "sender-not-user" });
    user = () => Response.json({ id: 3003, login: "acme-dev", type: "User" });
    repo = () => Response.json({ message: "Not Found" }, { status: 404 });
    expect(await read()).toEqual({ ok: false, status: 403, reason: "repo-not-visible" });
    repo = () => Response.json({ id: 1001, name: "acme-repo", full_name: "acme-user/acme-repo", private: false, owner: { id: 2002, login: "acme-user", type: "User" }, permissions: { push: false } });
    expect(await read()).toEqual({ ok: false, status: 403, reason: "no-push-access" });
    repo = () => Response.json({ message: "boom" }, { status: 500 });
    expect(await read()).toEqual({ ok: false, status: 502, reason: "github-error" });
  });
});
