// The Actions path: `POST /v1/actions-key` with the run's OIDC token. The repo, owner and
// visibility come from the token's claims alone; the workflow must be one of the member's three
// Claudinite workflows on its default branch, and pull request triggers are refused.
import { BODY_MAX_JSON, readJsonCapped } from "../../../packages/http/src/index.ts";
import { countPoint, issuingKey, refusal, withinOwnerLimit, type Env } from "./env.ts";
import { licenceFields, mintKey } from "./key.ts";
import { linksFor, NO_LINKS, wantsLinks } from "./links.ts";
import { incident, queueIncident } from "./incidents.ts";
import { verifyActionsToken } from "./oidc.ts";
import { readRepo, resolveForRow, type RepoRow } from "./plan.ts";
import { reader } from "./db.ts";

/** The workflow file names the server pins; renaming one needs a server release that accepts the new name first. */
export const PINNED_WORKFLOWS = ["claudinite-scheduler", "claudinite-executor", "claudinite-update"];

const PULL_REQUEST_EVENTS = ["pull_request", "pull_request_target"];

/** The default branch `job_workflow_ref` names, or null when the ref is not a pinned workflow of `repository` on a branch. */
function pinnedBranch(repository: string, ref: string): string | null {
  for (const name of PINNED_WORKFLOWS) {
    const prefix = `${repository}/.github/workflows/${name}.yml@refs/heads/`;
    if (ref.startsWith(prefix) && ref.length > prefix.length) return ref.slice(prefix.length);
  }
  return null;
}

export async function actionsKey(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const token = /^Bearer (\S+)$/.exec(req.headers.get("Authorization") ?? "")?.[1];
  if (!token) return refusal(401, "token-missing");
  const read = await readJsonCapped(req, BODY_MAX_JSON);
  if (!read.ok && read.reason === "body-too-large") return refusal(413, read.reason);
  // The engine version only labels the usage point; a request without one still gets a key.
  const claimed = read.ok ? (read.value as { engine_version?: unknown } | null)?.engine_version : undefined;
  const engineVersion = typeof claimed === "string" ? claimed : "unknown";

  const nowS = Math.floor(Date.now() / 1000);
  const verdict = await verifyActionsToken(token, { issuer: env.OIDC_ISSUER, nowS });
  if (!verdict.ok) return refusal(verdict.reason === "jwks-unavailable" ? 502 : 401, verdict.reason);
  const c = verdict.claims;
  const point = (plan: string, outcome: string, ownerType = "unknown") =>
    countPoint(env, { repoId: String(c.repositoryId), plan, outcome, ownerType, engineVersion, path: "actions" });

  if (PULL_REQUEST_EVENTS.includes(c.eventName)) {
    point("none", "refused-pull-request-trigger");
    return refusal(403, "pull-request-trigger");
  }
  const branch = pinnedBranch(c.repository, c.jobWorkflowRef);
  if (branch === null) {
    point("none", "refused-workflow-not-pinned");
    return refusal(403, "workflow-not-pinned");
  }
  if (!(await withinOwnerLimit(env, c.repositoryOwner))) return refusal(429, "rate-limited");

  const db = reader(env);
  let row: RepoRow | null;
  try {
    row = await readRepo(db, c.repositoryId);
  } catch (err) {
    // Unlike a session key, an Actions key cannot fail open: the pin needs the row's default branch.
    incident(env, ctx, "d1-unreadable", "actions", { repo_id: c.repositoryId, path: "actions", error: String(err) });
    point("none", "refused-server-error");
    return refusal(503, "server-error");
  }
  if (!row) {
    queueIncident(env, ctx, "app-not-installed", "actions");
    point("none", "refused-app-not-installed");
    return refusal(403, "app-not-installed");
  }
  if (row.default_branch === null || row.owner_type === null) {
    point("none", "refused-repo-not-synced", row.owner_type ?? "unknown");
    return refusal(403, "repo-not-synced");
  }
  if (branch !== row.default_branch) {
    point("none", "refused-workflow-not-pinned", row.owner_type);
    return refusal(403, "workflow-not-pinned");
  }
  // The licensee's state, with no user of its own and nothing written.
  const plan = await resolveForRow(env, db, { repoId: c.repositoryId, visibility: c.repositoryVisibility, ownerId: c.repositoryOwnerId, userId: null, typ: "actions" }, row, { ctx, path: "actions" });
  if ("refused" in plan) {
    point("none", `refused-${plan.refused}`, row.owner_type);
    return refusal(503, plan.refused);
  }
  const ownerType = row.owner_type;
  const links = wantsLinks(plan)
    ? await linksFor(env, { plan: plan.plan, ownerId: c.repositoryOwnerId, ownerLogin: c.repositoryOwner, ownerType, repo: { id: c.repositoryId, fullName: c.repository }, subscribed: plan.subscribed }, ctx)
    : NO_LINKS;
  const { seed, cert } = issuingKey(env);
  const key = await mintKey(seed, cert, { typ: "actions", repoId: c.repositoryId, ownerId: c.repositoryOwnerId, ownerType, ownerLogin: c.repositoryOwner, ...licenceFields(plan, links) }, nowS);
  point(plan.plan, `issued-${plan.state}`, ownerType);
  return Response.json({ key, plan: plan.plan, state: plan.state, notice: plan.notice, ...links });
}
