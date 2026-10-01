// The desktop path: `POST /v1/session-key` with the App user token `cn login` obtained. The user
// and the repo come from GitHub, read as the caller, never from the body.
import { parseDesktopRequest, readDesktopCaller } from "../../../packages/github-app/src/index.ts";
import { countPoint, issuingKey, refusal, withinOwnerLimit, type Env } from "./env.ts";
import { mintKey } from "./key.ts";
import { resolvePlan } from "./plan.ts";

export async function sessionKey(req: Request, env: Env): Promise<Response> {
  const parsed = await parseDesktopRequest(req);
  if (!parsed.ok) return refusal(parsed.status, parsed.reason);
  const { token, owner: ownerLogin, name, nonce, engineVersion } = parsed.request;
  if (!(await withinOwnerLimit(env, ownerLogin))) return refusal(429, "rate-limited");

  const caller = await readDesktopCaller({ base: env.GITHUB_API_BASE ?? "https://api.github.com", userAgent: "claudinite-key" }, token, ownerLogin, name);
  if (!caller.ok) {
    countPoint(env, { repoId: "unknown", plan: "none", outcome: caller.reason === "github-error" ? "github-error" : `refused-${caller.reason}`, ownerType: "unknown", engineVersion, path: "desktop" });
    return refusal(caller.status, caller.reason);
  }
  const { user, repo, owner } = caller;
  const seen = { repoId: String(repo.id), ownerType: owner.type, engineVersion, path: "desktop" as const };
  const plan = await resolvePlan(env, { repoId: repo.id, visibility: repo.private ? "private" : "public" });
  if ("refused" in plan) {
    countPoint(env, { ...seen, plan: "none", outcome: `refused-${plan.refused}` });
    return refusal(plan.refused === "server-error" ? 503 : 403, plan.refused);
  }
  const { seed, cert } = issuingKey(env);
  const key = await mintKey(
    seed,
    cert,
    { typ: "session", repoId: repo.id, ownerId: owner.id, ownerType: owner.type, ownerLogin: owner.login, userId: user.id, nonce, plan: plan.plan, state: plan.state, features: plan.features },
    Math.floor(Date.now() / 1000),
  );
  countPoint(env, { ...seen, plan: plan.plan, outcome: "issued" });
  return Response.json({ key, plan: plan.plan, state: plan.state });
}
