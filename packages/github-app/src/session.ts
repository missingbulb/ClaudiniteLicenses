// What a session key request carries, read the same way by both key Workers: the web path's
// repository_dispatch payload, and the desktop path's request with the caller's App user token,
// whose user and repo are read from GitHub as that caller rather than trusted from the body.
import { GitHubError, githubCall, type GitHubApi } from "./index.ts";

export const NONCE = /^[A-Za-z0-9_-]{16,64}$/;
const HEAD = /^[0-9a-f]{40}$/;
const REPO = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;

export type OwnerType = "User" | "Organization";

export interface RepoRef {
  id: number;
  name: string;
  fullName: string;
  private: boolean;
}

export interface Owner {
  id: number;
  login: string;
  type: OwnerType;
}

export interface KeyDispatch {
  repo: RepoRef;
  owner: Owner;
  installationId: number;
  sender: { id: number; login: string };
  nonce: string;
  head: string;
  engineVersion: string;
}

export type Refused = { ok: false; status: number; reason: string };

interface DispatchPayload {
  repository?: { id?: unknown; name?: unknown; full_name?: unknown; private?: unknown; owner?: { id?: unknown; login?: unknown; type?: unknown } };
  installation?: { id?: unknown };
  sender?: { id?: unknown; login?: unknown; type?: unknown };
  client_payload?: { nonce?: unknown; engine_version?: unknown; head?: unknown };
}

/**
 * Reads a `claudinite-key` or `claudinite-key-public` dispatch. A refusal carries `seen`, what a
 * usage count can still say about the request.
 */
export function parseKeyDispatch(payload: unknown): { ok: true; dispatch: KeyDispatch } | (Refused & { seen: { repoId: string; ownerType: string; engineVersion: string } }) {
  const d = (typeof payload === "object" && payload !== null ? payload : {}) as DispatchPayload;
  const repo = d.repository;
  const owner = repo?.owner;
  const engineVersion = typeof d.client_payload?.engine_version === "string" ? d.client_payload.engine_version : "unknown";
  const seen = { repoId: String(repo?.id ?? "unknown"), ownerType: typeof owner?.type === "string" ? owner.type : "unknown", engineVersion };
  const refuse = (status: number, reason: string) => ({ ok: false as const, status, reason, seen });
  if (d.sender?.type !== "User") return refuse(403, "sender-not-user");
  const nonce = d.client_payload?.nonce;
  const head = d.client_payload?.head;
  const installationId = d.installation?.id;
  if (typeof nonce !== "string" || !NONCE.test(nonce)) return refuse(400, "bad-nonce");
  if (typeof head !== "string" || !HEAD.test(head)) return refuse(400, "bad-head");
  if (typeof installationId !== "number") return refuse(400, "no-installation");
  if (
    typeof repo?.id !== "number" ||
    typeof repo.name !== "string" ||
    typeof repo.full_name !== "string" ||
    typeof owner?.id !== "number" ||
    typeof owner.login !== "string" ||
    (owner.type !== "User" && owner.type !== "Organization") ||
    typeof d.sender.id !== "number" ||
    typeof d.sender.login !== "string"
  ) {
    return refuse(400, "malformed-payload");
  }
  return {
    ok: true,
    dispatch: {
      repo: { id: repo.id, name: repo.name, fullName: repo.full_name, private: repo.private === true },
      owner: { id: owner.id, login: owner.login, type: owner.type },
      installationId,
      sender: { id: d.sender.id, login: d.sender.login },
      nonce,
      head,
      engineVersion,
    },
  };
}

export interface DesktopRequest {
  token: string;
  owner: string;
  name: string;
  nonce: string;
  engineVersion: string;
}

/** Reads a desktop key request: `Authorization: Bearer <App user token>`, body `{ repo: "owner/name", nonce, engine_version }`. */
export async function parseDesktopRequest(req: Request): Promise<{ ok: true; request: DesktopRequest } | Refused> {
  const token = /^Bearer (\S+)$/.exec(req.headers.get("Authorization") ?? "")?.[1];
  if (!token) return { ok: false, status: 401, reason: "token-missing" };
  let body: { repo?: unknown; nonce?: unknown; engine_version?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return { ok: false, status: 400, reason: "malformed-body" };
  }
  const m = typeof body?.repo === "string" ? REPO.exec(body.repo) : null;
  if (!m) return { ok: false, status: 400, reason: "bad-repo" };
  if (typeof body.nonce !== "string" || !NONCE.test(body.nonce)) return { ok: false, status: 400, reason: "bad-nonce" };
  const engineVersion = typeof body.engine_version === "string" ? body.engine_version : "unknown";
  return { ok: true, request: { token, owner: m[1]!, name: m[2]!, nonce: body.nonce, engineVersion } };
}

/**
 * Reads the caller and the repo from GitHub with the caller's own token: the user must be a
 * `User`, and the repo visible to them with push access, the access a web session's dispatch needs.
 */
export async function readDesktopCaller(
  api: GitHubApi,
  token: string,
  owner: string,
  name: string,
): Promise<{ ok: true; user: { id: number; login: string }; repo: RepoRef; owner: Owner } | Refused> {
  const call = async (path: string, callName: string) => {
    try {
      return { answer: (await githubCall(api, "GET", path, token, undefined, callName)) as Record<string, unknown> };
    } catch (err) {
      if (!(err instanceof GitHubError)) throw err;
      return { error: err };
    }
  };
  const fromError = (err: GitHubError, notFound: string): Refused => {
    if (err.status === 401) return { ok: false, status: 401, reason: "token-invalid" };
    if (err.status === 404) return { ok: false, status: 403, reason: notFound };
    console.error(JSON.stringify({ githubError: err.call, status: err.status, marker: err.secondaryRateLimit ? "secondary-rate-limit" : undefined }));
    return { ok: false, status: 502, reason: "github-error" };
  };
  const user = await call("/user", "user");
  if (user.error) return fromError(user.error, "token-invalid");
  const u = user.answer!;
  if (u.type !== "User" || typeof u.id !== "number" || typeof u.login !== "string") return { ok: false, status: 403, reason: "sender-not-user" };
  const repo = await call(`/repos/${owner}/${name}`, "repo read");
  if (repo.error) return fromError(repo.error, "repo-not-visible");
  const r = repo.answer! as { id?: unknown; name?: unknown; full_name?: unknown; private?: unknown; owner?: { id?: unknown; login?: unknown; type?: unknown }; permissions?: { push?: unknown } };
  if (
    typeof r.id !== "number" ||
    typeof r.name !== "string" ||
    typeof r.full_name !== "string" ||
    typeof r.owner?.id !== "number" ||
    typeof r.owner.login !== "string" ||
    (r.owner.type !== "User" && r.owner.type !== "Organization")
  ) {
    return { ok: false, status: 502, reason: "github-error" };
  }
  if (r.permissions?.push !== true) return { ok: false, status: 403, reason: "no-push-access" };
  return {
    ok: true,
    user: { id: u.id, login: u.login },
    repo: { id: r.id, name: r.name, fullName: r.full_name, private: r.private === true },
    owner: { id: r.owner.id, login: r.owner.login, type: r.owner.type },
  };
}
