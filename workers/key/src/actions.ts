// The Actions path: `POST /v1/actions-key` with the run's OIDC token. The repo, owner and
// visibility come from the token's claims alone; the workflow must be one of the member's three
// Claudinite workflows on its default branch, and pull request triggers are refused.
import { countPoint, issuingKey, refusal, withinOwnerLimit, type Env } from "./env.ts";
import { mintKey } from "./key.ts";
import { verifyActionsToken } from "./oidc.ts";
import { planFor, readRepo, type RepoRow } from "./plan.ts";

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

export async function actionsKey(req: Request, env: Env): Promise<Response> {
  const token = /^Bearer (\S+)$/.exec(req.headers.get("Authorization") ?? "")?.[1];
  if (!token) return refusal(401, "token-missing");
  let engineVersion = "unknown";
  try {
    const body = (await req.json()) as { engine_version?: unknown };
    if (typeof body?.engine_version === "string") engineVersion = body.engine_version;
  } catch {
    // The engine version only labels the usage point; a request without one still gets a key.
  }

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

  let row: RepoRow | null;
  try {
    row = await readRepo(env.DB, c.repositoryId);
  } catch (err) {
    // Unlike a session key, an Actions key cannot fail open: the pin needs the row's default branch.
    console.log(JSON.stringify({ marker: "d1-unreadable", repo_id: c.repositoryId, path: "actions", error: String(err) }));
    point("none", "refused-server-error");
    return refusal(503, "server-error");
  }
  if (!row) {
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
  const plan = planFor(row, c.repositoryVisibility);
  if ("refused" in plan) {
    point("none", `refused-${plan.refused}`, row.owner_type);
    return refusal(403, plan.refused);
  }
  const { seed, cert } = issuingKey(env);
  const key = await mintKey(
    seed,
    cert,
    { typ: "actions", repoId: c.repositoryId, ownerId: c.repositoryOwnerId, ownerType: row.owner_type, ownerLogin: c.repositoryOwner, plan: plan.plan, state: plan.state, features: plan.features },
    nowS,
  );
  point(plan.plan, "issued", row.owner_type);
  return Response.json({ key, plan: plan.plan, state: plan.state });
}
