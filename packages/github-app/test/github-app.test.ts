import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { b64urlDecode } from "../../signing/src/index.ts";
import { appJwt, GitHubError, installationToken, pemToPkcs8, type GitHubClient } from "../src/index.ts";

const { privateKey: PKCS1 } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const gh: GitHubClient = { base: "https://github-api.test", appId: "4242", privateKey: PKCS1, userAgent: "acme-agent" };
const NOW_S = 1_790_000_000;

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

let calls: Call[];
let tokenAnswer: () => Response;

beforeEach(() => {
  calls = [];
  tokenAnswer = () => Response.json({ token: "ghs_acme", expires_at: "2099-01-01T00:00:00Z" }, { status: 201 });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const text = await req.text();
    calls.push({ url: req.url, method: req.method, headers: req.headers, body: text ? JSON.parse(text) : undefined });
    if (req.url.endsWith("/access_tokens")) return tokenAnswer();
    if (req.url.endsWith("/check-runs")) return Response.json({ id: 1 }, { status: 201 });
    return new Response("unexpected", { status: 599 });
  });
});

afterEach(() => vi.restoreAllMocks());

const decode = (part: string) => JSON.parse(new TextDecoder().decode(b64urlDecode(part)));

describe("appJwt", () => {
  it("signs RS256, issued by the App id, backdated a minute and living at most 10 minutes", async () => {
    const [h, c, s] = (await appJwt(gh.appId, gh.privateKey, NOW_S)).split(".");
    expect(decode(h!)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decode(c!)).toEqual({ iat: NOW_S - 60, exp: NOW_S + 540, iss: "4242" });
    expect(s).toMatch(/^[\w-]{300,}$/);
  });

  it("reads the PKCS#1 PEM GitHub hands out and a PKCS#8 one alike", async () => {
    const { privateKey: pkcs8 } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    expect(pemToPkcs8(PKCS1).length).toBeGreaterThan(1000);
    expect((await appJwt("1", pkcs8, NOW_S)).split(".")).toHaveLength(3);
    expect(() => pemToPkcs8("not a pem")).toThrow(/PEM/);
  });
});

describe("installationToken", () => {
  it("sends exactly the repositories and permissions it is given, under the App JWT", async () => {
    expect(await installationToken(gh, 5005, { repositories: ["acme-repo"], permissions: { metadata: "read" } }, NOW_S)).toBe("ghs_acme");
    expect(calls).toHaveLength(1);
    expect(`${calls[0]!.method} ${calls[0]!.url}`).toBe("POST https://github-api.test/app/installations/5005/access_tokens");
    expect(calls[0]!.body).toEqual({ repositories: ["acme-repo"], permissions: { metadata: "read" } });
    expect(calls[0]!.headers.get("Authorization")).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(calls[0]!.headers.get("User-Agent")).toBe("acme-agent");
  });

  it("leaves repositories out when none are given, so the token covers the whole installation", async () => {
    await installationToken(gh, 5005, { permissions: { metadata: "read" } }, NOW_S);
    expect(calls[0]!.body).toEqual({ permissions: { metadata: "read" } });
  });

  it("turns a 401 into a GitHubError naming the installation token call", async () => {
    tokenAnswer = () => Response.json({ message: "Bad credentials" }, { status: 401 });
    const err = await installationToken(gh, 5005, { permissions: { checks: "write" } }, NOW_S).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect(err).toMatchObject({ status: 401, call: "installation token" });
  });
});
