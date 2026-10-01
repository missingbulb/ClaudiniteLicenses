import { applyD1Migrations, createExecutionContext, env as testEnv, type D1Migration } from "cloudflare:test";
import { vi } from "vitest";
import { b64urlDecode, b64urlEncode, verifyKey, type KeyPayload } from "../../../packages/signing/src/index.ts";
import worker, { type Env } from "../src/index.ts";

export const HEAD = "0123456789abcdef0123456789abcdef01234567";
export const NONCE = "acme-nonce-0123456789abcdef";
export const base = testEnv as unknown as Env & { TEST_MIGRATIONS: D1Migration[]; DEV_ROOTS: string };
export const roots: string[] = JSON.parse(base.DEV_ROOTS);

export interface Point {
  indexes?: string[];
  blobs?: string[];
  doubles?: number[];
}

export interface GitHubCall {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

/** What the fetch spy answers and records: GitHub's API and web hosts, and the OIDC issuer. */
export interface World {
  calls: GitHubCall[];
  points: Point[];
  logs: string[];
  dbCalls: number;
  limited: Record<string, number>;
  user: () => Response;
  repo: () => Response;
  oauth: () => Response;
  jwks: () => Response;
}

export let world: World;

export function resetWorld(): World {
  world = {
    calls: [],
    points: [],
    logs: [],
    dbCalls: 0,
    limited: {},
    user: () => Response.json({ id: 3003, login: "acme-dev", type: "User" }),
    repo: () => Response.json(githubRepo()),
    oauth: () => Response.json({ access_token: "ghu_new", expires_in: 28800, refresh_token: "ghr_new", refresh_token_expires_in: 15811200 }),
    jwks: () => Response.json({ keys: [] }),
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const body = await req.text();
    world.calls.push({ url: req.url, method: req.method, headers: req.headers, body });
    const url = new URL(req.url);
    if (url.pathname.endsWith("/access_tokens")) return Response.json({ token: "ghs_acme" }, { status: 201 });
    if (url.pathname.endsWith("/check-runs")) return Response.json({ id: 77 }, { status: 201 });
    if (req.url === "https://github-api.test/user") return world.user();
    if (/^\/repos\/[^/]+\/[^/]+$/.test(url.pathname)) return world.repo();
    if (req.url === "https://github-web.test/login/oauth/access_token") return world.oauth();
    if (req.url === "https://oidc.test/.well-known/jwks") return world.jwks();
    return new Response("unexpected", { status: 599 });
  });
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void world.logs.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void world.logs.push(a.join(" ")));
  return world;
}

export function githubRepo(over: Record<string, unknown> = {}) {
  return { id: 1001, name: "acme-repo", full_name: "acme-user/acme-repo", private: false, visibility: "public", owner: { id: 2002, login: "acme-user", type: "User" }, permissions: { push: true }, ...over };
}

/** A D1 binding that counts every statement prepared, or throws on each one. */
export function countingDb(inner: D1Database, opts: { broken?: boolean } = {}): D1Database {
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          world.dbCalls++;
          if (opts.broken) throw new Error("D1_ERROR: acme outage");
          return target.prepare(sql);
        };
      }
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

export function env(over: Partial<Env> & { brokenDb?: boolean; limit?: number } = {}): Env {
  const { brokenDb, limit = 600, ...rest } = over;
  return {
    ...base,
    DB: countingDb(base.DB, { broken: brokenDb }),
    KEY_COUNTS: { writeDataPoint: (p: Point) => void world.points.push(p) } as unknown as AnalyticsEngineDataset,
    OWNER_LIMIT: {
      limit: async ({ key }: { key: string }) => {
        world.limited[key] = (world.limited[key] ?? 0) + 1;
        return { success: world.limited[key]! <= limit };
      },
    } as RateLimit,
    ...rest,
  };
}

export async function freshDatabase(): Promise<void> {
  await applyD1Migrations(base.DB, base.TEST_MIGRATIONS);
  await base.DB.prepare("DELETE FROM repos").run();
}

export async function seedRepo(over: Partial<{ repo_id: number; owner_id: number; owner_type: string; owner_login: string; visibility: string; installation_id: number; full_name: string; default_branch: string | null }> = {}) {
  const r = { repo_id: 1001, owner_id: 2002, owner_type: "User", owner_login: "acme-user", visibility: "public", installation_id: 5005, full_name: "acme-user/acme-repo", default_branch: "main", ...over };
  await base.DB.prepare(
    "INSERT INTO repos (repo_id, owner_id, owner_type, owner_login, visibility, installation_id, full_name, default_branch, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)",
  )
    .bind(r.repo_id, r.owner_id, r.owner_type, r.owner_login, r.visibility, r.installation_id, r.full_name, r.default_branch)
    .run();
}

export async function call(path: string, init: RequestInit = {}, e: Env = env()): Promise<Response> {
  return worker.fetch(new Request(`https://license.claudinite.com${path}`, init), e, createExecutionContext());
}

export async function verified(key: string): Promise<KeyPayload> {
  const v = await verifyKey(key, { roots, now: new Date() });
  if (!v.ok) throw new Error(`key does not verify: ${v.reason}`);
  return v.payload;
}

export function certKeyId(): string {
  const cert = JSON.parse(base.ISSUING_KEY_CERT) as { payload: string };
  return JSON.parse(new TextDecoder().decode(b64urlDecode(cert.payload))).keyId;
}

export function certUse(key: string): string {
  const cert = (JSON.parse(key) as { certificate: { payload: string } }).certificate;
  return JSON.parse(new TextDecoder().decode(b64urlDecode(cert.payload))).use;
}

/** An RSA signer standing in for GitHub's OIDC issuer; its JWKS is what the spy serves. */
export async function oidcIssuer(kid = "acme-kid-1") {
  const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = { ...((await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey), kid, alg: "RS256", use: "sig" };
  const enc = (v: unknown) => b64urlEncode(new TextEncoder().encode(JSON.stringify(v)));
  return {
    jwk,
    async sign(claims: Record<string, unknown>, header: Record<string, unknown> = {}): Promise<string> {
      const input = `${enc({ alg: "RS256", typ: "JWT", kid, ...header })}.${enc(claims)}`;
      const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(input)));
      return `${input}.${b64urlEncode(sig)}`;
    },
  };
}

export function actionsClaims(over: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "https://oidc.test",
    aud: "claudinite",
    iat: now - 10,
    nbf: now - 10,
    exp: now + 300,
    repository_id: "1001",
    repository_owner_id: "2002",
    repository: "acme-user/acme-repo",
    repository_owner: "acme-user",
    repository_visibility: "public",
    event_name: "schedule",
    job_workflow_ref: "acme-user/acme-repo/.github/workflows/claudinite-scheduler.yml@refs/heads/main",
    ...over,
  };
}

export const githubCalls = () => world.calls.filter((c) => !c.url.startsWith("https://oidc.test/"));
