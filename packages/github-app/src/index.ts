// The Claudinite App's GitHub client, shared by the Workers that act as the App: its JWT, an
// installation token for exactly the repositories and permissions a call needs, and the key check
// run. A source package only: each Worker bundles its own copy, so nothing is shared at runtime.
import { b64urlEncode } from "../../signing/src/index.ts";

export class GitHubError extends Error {
  readonly status: number;
  readonly body: string;
  readonly call: string;

  constructor(status: number, body: string, call: string) {
    super(`${call} answered ${status}`);
    this.status = status;
    this.body = body;
    this.call = call;
  }

  get secondaryRateLimit(): boolean {
    return this.status === 403 && /secondary rate limit/i.test(this.body);
  }
}

function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

function der(tag: number, content: Uint8Array): Uint8Array {
  const len = derLength(content.length);
  const out = new Uint8Array(1 + len.length + content.length);
  out[0] = tag;
  out.set(len, 1);
  out.set(content, 1 + len.length);
  return out;
}

function cat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// version 0, AlgorithmIdentifier { rsaEncryption, NULL }
const PKCS8_RSA_HEAD = Uint8Array.from([0x02, 0x01, 0x00, 0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);

/** GitHub hands out PKCS#1 PEM ("RSA PRIVATE KEY"); WebCrypto imports PKCS#8 only, so wrap it. */
export function pemToPkcs8(pem: string): Uint8Array<ArrayBuffer> {
  const m = /-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END (RSA )?PRIVATE KEY-----/.exec(pem);
  if (!m) throw new Error("GITHUB_APP_PRIVATE_KEY is not a PEM private key");
  const body = atob(m[2]!.replace(/\s+/g, ""));
  const raw = Uint8Array.from(body, (c) => c.charCodeAt(0));
  return m[1] ? cat(der(0x30, cat(PKCS8_RSA_HEAD, der(0x04, raw)))) : raw;
}

export async function appJwt(appId: string, pem: string, nowS: number): Promise<string> {
  const key = await crypto.subtle.importKey("pkcs8", pemToPkcs8(pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const enc = (v: unknown) => b64urlEncode(new TextEncoder().encode(JSON.stringify(v)));
  // Backdated a minute for clock drift; GitHub refuses a JWT living longer than 10 minutes.
  const input = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iat: nowS - 60, exp: nowS + 540, iss: appId })}`;
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input)));
  return `${input}.${b64urlEncode(sig)}`;
}

export interface GitHubApi {
  base: string;
  userAgent: string;
}

export interface GitHubClient extends GitHubApi {
  appId: string;
  privateKey: string;
}

/** One GitHub API call: a JSON body out when given, the parsed JSON answer back, a GitHubError on any non-2xx. */
export async function githubCall(api: GitHubApi, method: string, path: string, auth: string, body: unknown, name: string): Promise<unknown> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": api.userAgent,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${api.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new GitHubError(res.status, text, name);
  return text ? JSON.parse(text) : {};
}

export interface TokenScope {
  repositories?: string[];
  permissions: Record<string, "read" | "write">;
}

/** An installation token holding exactly `scope`: the named repositories, or the whole installation when none are named. */
export async function installationToken(gh: GitHubClient, installationId: number, scope: TokenScope, nowS: number): Promise<string> {
  const jwt = await appJwt(gh.appId, gh.privateKey, nowS);
  const body = scope.repositories ? { repositories: scope.repositories, permissions: scope.permissions } : { permissions: scope.permissions };
  const token = (await githubCall(gh, "POST", `/app/installations/${installationId}/access_tokens`, jwt, body, "installation token")) as { token?: unknown };
  if (typeof token.token !== "string") throw new GitHubError(502, "no token in the answer", "installation token");
  return token.token;
}

export interface CheckRunOutput {
  title: string;
  summary: string;
  text?: string;
}

/** Creates one completed, neutral `Claudinite key` check run with an installation token scoped to the repo. */
export async function createKeyCheckRun(
  gh: GitHubClient,
  target: { installationId: number; repoName: string; fullName: string; head: string; nonce: string },
  output: CheckRunOutput,
  nowS: number,
): Promise<void> {
  const token = await installationToken(gh, target.installationId, { repositories: [target.repoName], permissions: { checks: "write" } }, nowS);
  await githubCall(
    gh,
    "POST",
    `/repos/${target.fullName}/check-runs`,
    token,
    { name: "Claudinite key", head_sha: target.head, external_id: target.nonce, status: "completed", conclusion: "neutral", output },
    "check run",
  );
}

/**
 * The summary of a `Claudinite key refused` check run, `<reason>: <text>`: the binary takes what
 * precedes the first colon as the cause, so the reason is one word and the text holds no colon.
 */
export function refusalSummary(reason: string, text: string): string {
  if (!/^[a-z0-9-]+$/.test(reason)) throw new Error(`refusal reason ${JSON.stringify(reason)} is not one lower-case word`);
  if (text.includes(":")) throw new Error(`refusal text for ${reason} holds a colon, which would move the binary's cut`);
  return `${reason}: ${text}`;
}

export * from "./session.ts";
