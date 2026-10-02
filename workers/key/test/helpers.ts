import { applyD1Migrations, env as testEnv, type D1Migration } from "cloudflare:test";
import { vi } from "vitest";
import { b64urlDecode, b64urlEncode, verifyKey, type KeyPayload } from "../../../packages/signing/src/index.ts";
import worker, { type Env } from "../src/index.ts";
import { resetLinkCaches } from "../src/links.ts";

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

/** What the fetch spy answers and records: GitHub's API and web hosts, the OIDC issuer and Polar. */
export interface World {
  calls: GitHubCall[];
  points: Point[];
  logs: string[];
  dbCalls: number;
  /** Every statement prepared, in order. */
  dbSql: string[];
  /** Each sendBatch call's message bodies. */
  sent: unknown[][];
  /** The signal each Polar request carried, in order. */
  polarSignals: AbortSignal[];
  /** Every promise handed to the request's waitUntil. */
  waited: Promise<unknown>[];
  /** What WRITES.sendBatch does; resolves at once unless a test says otherwise. */
  send: () => Promise<void>;
  limited: Record<string, number>;
  /** Each IP_LIMIT bucket's count. */
  ipLimited: Record<string, number>;
  user: () => Response;
  repo: () => Response;
  oauth: () => Response;
  jwks: () => Response;
  polarProducts: () => Response;
  polarCheckout: () => Response | Promise<Response>;
  polarSession: () => Response | Promise<Response>;
}

export const POLAR = "https://polar-api.test";
export const CHECKOUT_URL = "https://sandbox.polar.test/checkout/acme";
export const PORTAL_URL = "https://sandbox.polar.test/portal/acme";

const managedProduct = (plan: string, interval: string) => ({ id: `prod_${plan}_${interval}`, name: `${plan} (${interval})`, is_archived: false, recurring_interval: interval, metadata: { claudinite_plan: plan, claudinite_interval: interval, managed_by: "claudinite-licenses" } });

export let world: World;

export function resetWorld(): World {
  resetLinkCaches();
  world = {
    calls: [],
    points: [],
    logs: [],
    dbCalls: 0,
    dbSql: [],
    sent: [],
    polarSignals: [],
    waited: [],
    send: async () => {},
    limited: {},
    ipLimited: {},
    user: () => Response.json({ id: 3003, login: "acme-dev", type: "User" }),
    repo: () => Response.json(githubRepo()),
    oauth: () => Response.json({ access_token: "ghu_new", expires_in: 28800, refresh_token: "ghr_new", refresh_token_expires_in: 15811200 }),
    jwks: () => Response.json({ keys: [] }),
    polarProducts: () => {
      const items = ["private-repo", "personal", "organization"].flatMap((p) => ["month", "year"].map((i) => managedProduct(p, i)));
      return Response.json({ items, pagination: { total_count: items.length, max_page: 1 } });
    },
    polarCheckout: () => Response.json({ id: "chk_acme", url: CHECKOUT_URL, expires_at: "2026-10-02T00:00:00Z" }, { status: 201 }),
    polarSession: () => Response.json({ id: "cs_acme", token: "acme", customer_portal_url: PORTAL_URL }, { status: 201 }),
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const body = new TextDecoder().decode(await req.arrayBuffer());
    world.calls.push({ url: req.url, method: req.method, headers: req.headers, body });
    const url = new URL(req.url);
    if (url.origin === POLAR) world.polarSignals.push(init?.signal ?? req.signal);
    if (url.pathname.endsWith("/access_tokens")) return Response.json({ token: "ghs_acme" }, { status: 201 });
    if (url.pathname.endsWith("/check-runs")) return Response.json({ id: 77 }, { status: 201 });
    if (req.url === "https://github-api.test/user") return world.user();
    if (/^\/repos\/[^/]+\/[^/]+$/.test(url.pathname)) return world.repo();
    if (req.url === "https://github-web.test/login/oauth/access_token") return world.oauth();
    if (req.url === "https://oidc.test/.well-known/jwks") return world.jwks();
    if (url.origin === POLAR && req.method === "GET" && url.pathname === "/v1/products/") return world.polarProducts();
    if (url.origin === POLAR && req.method === "POST" && url.pathname === "/v1/checkouts/") return world.polarCheckout();
    if (url.origin === POLAR && req.method === "POST" && url.pathname === "/v1/customer-sessions/") return world.polarSession();
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
          world.dbSql.push(sql.replace(/\s+/g, " ").trim());
          if (opts.broken) throw new Error("D1_ERROR: acme outage");
          return target.prepare(sql);
        };
      }
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

/** The pool's real IP_LIMIT would count every test's requests on one bucket; this one counts per key and allows `ipLimit` a key. */
export function ipLimiter(ipLimit: number): RateLimit {
  return {
    limit: async ({ key }: { key: string }) => {
      world.ipLimited[key] = (world.ipLimited[key] ?? 0) + 1;
      return { success: world.ipLimited[key]! <= ipLimit };
    },
  } as RateLimit;
}

export function env(over: Partial<Env> & { brokenDb?: boolean; limit?: number; ipLimit?: number } = {}): Env {
  const { brokenDb, limit = 600, ipLimit = Number.POSITIVE_INFINITY, ...rest } = over;
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
    IP_LIMIT: ipLimiter(ipLimit),
    WRITES: {
      send: async () => {
        throw new Error("the key Worker sends batches only");
      },
      sendBatch: async (batch: Iterable<MessageSendRequest>) => {
        const bodies = [...batch].map((m) => m.body);
        await world.send();
        world.sent.push(bodies);
      },
    } as unknown as Queue,
    POLAR_API_BASE: POLAR,
    POLAR_ACCESS_TOKEN: "polar_oat_acme",
    TRUST_ROOTS: base.DEV_ROOTS,
    ...rest,
  };
}

export async function freshDatabase(): Promise<void> {
  await applyD1Migrations(base.DB, base.TEST_MIGRATIONS);
  await base.DB.batch(["repos", "subscriptions", "seats", "overuse", "usage"].map((t) => base.DB.prepare(`DELETE FROM ${t}`)));
}

export const DAY = 86400;
export const nowS = () => Math.floor(Date.now() / 1000);

export async function seedSubscription(over: Partial<{ id: string; owner_id: number; owner_type: string; plan: string; seats: number; repo_ids: string | null; status: string; ended_at: number | null }> = {}) {
  const r = { id: `sub_${crypto.randomUUID()}`, owner_id: 2002, owner_type: "User", plan: "personal", seats: 5, repo_ids: null, status: "active", ended_at: null, ...over };
  await base.DB.prepare(
    "INSERT INTO subscriptions (polar_subscription_id, owner_id, owner_type, plan, seats, repo_ids, source, modified_at, raw, status, ended_at) VALUES (?, ?, ?, ?, ?, ?, 'polar', 1, '{}', ?, ?)",
  )
    .bind(r.id, r.owner_id, r.owner_type, r.plan, r.seats, r.repo_ids, r.status, r.ended_at)
    .run();
}

/** Seats for `n` users of a licensee, user ids 4001.., in that order of first key, each active yesterday. */
export async function seedSeats(licenseeId: number, n: number) {
  const now = nowS();
  for (let i = 0; i < n; i++) {
    await base.DB.prepare("INSERT INTO seats (licensee_id, user_id, first_key_at, last_key_at) VALUES (?, ?, ?, ?)").bind(licenseeId, 4001 + i, now - 20 * DAY + i * 60, now - DAY).run();
  }
}

export async function seedOveruse(ownerId: number, startedAt: number | null, spentUntil: number | null) {
  await base.DB.prepare("INSERT INTO overuse (licensee_id, grace_started_at, grace_spent_until) VALUES (?, ?, ?)").bind(ownerId, startedAt, spentUntil).run();
}

export async function seedUsage(repoId: number, userId: number, day: string) {
  await base.DB.prepare("INSERT INTO usage (repo_id, user_id, day) VALUES (?, ?, ?)").bind(repoId, userId, day).run();
}

/** The request's ExecutionContext, recording what it is handed. */
export function recordingContext(): ExecutionContext {
  return { waitUntil: (p: Promise<unknown>) => void world.waited.push(p), passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
}

export async function seedRepo(over: Partial<{ repo_id: number; owner_id: number; owner_type: string; owner_login: string; visibility: string; installation_id: number; full_name: string; default_branch: string | null }> = {}) {
  const r = { repo_id: 1001, owner_id: 2002, owner_type: "User", owner_login: "acme-user", visibility: "public", installation_id: 5005, full_name: "acme-user/acme-repo", default_branch: "main", ...over };
  await base.DB.prepare(
    "INSERT INTO repos (repo_id, owner_id, owner_type, owner_login, visibility, installation_id, full_name, default_branch, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)",
  )
    .bind(r.repo_id, r.owner_id, r.owner_type, r.owner_login, r.visibility, r.installation_id, r.full_name, r.default_branch)
    .run();
}

/** Calls the Worker and waits for what it handed waitUntil, so the queued writes are recorded. */
export async function call(path: string, init: RequestInit = {}, e: Env = env()): Promise<Response> {
  const res = await worker.fetch(new Request(`https://license.claudinite.com${path}`, init), e, recordingContext());
  await Promise.allSettled(world.waited);
  return res;
}

/** The queued messages of every send, in order. */
export const sentMessages = () => world.sent.flat() as { kind: string; [k: string]: unknown }[];

/** The queued incident messages, in order. */
export const sentIncidents = () => sentMessages().filter((m) => m.kind === "incident");

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
