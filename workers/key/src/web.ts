// The web path: a web session's `claudinite-key` dispatch, forwarded by the router, answered with
// one `Claudinite key` check run carrying the key, or `Claudinite key refused` naming why.
import { createKeyCheckRun, GitHubError, parseKeyDispatch } from "../../../packages/github-app/src/index.ts";
import { countPoint, githubClient, issuingKey, type Env } from "./env.ts";
import { licenceFields, mintKey } from "./key.ts";
import { linksFor, NO_LINKS, wantsLinks } from "./links.ts";
import { REFUSAL_TEXT, resolvePlan } from "./plan.ts";
import { enqueueWrites } from "./writes.ts";

function refuse(status: number, reason: string, delivery: string | null): Response {
  console.log(JSON.stringify({ refused: reason, delivery }));
  return new Response(reason, { status });
}

export async function webhook(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const delivery = req.headers.get("X-GitHub-Delivery");
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return refuse(400, "malformed-payload", delivery);
  }
  const parsed = parseKeyDispatch(payload);
  if (!parsed.ok) {
    if (parsed.reason === "sender-not-user") countPoint(env, { ...parsed.seen, plan: "none", outcome: "refused-sender", path: "web" });
    return refuse(parsed.status, parsed.reason, delivery);
  }
  const { repo, owner, installationId, sender, nonce, head, engineVersion } = parsed.dispatch;
  const seen = { repoId: String(repo.id), ownerType: owner.type, engineVersion, path: "web" as const };

  const nowS = Math.floor(Date.now() / 1000);
  const plan = await resolvePlan(env, { repoId: repo.id, visibility: repo.private ? "private" : "public", ownerId: owner.id, userId: sender.id, typ: "session" }, { installed: true });
  let outcome: string;
  let planName: string;
  let output: { title: string; summary: string; text?: string };
  if ("refused" in plan) {
    outcome = `refused-${plan.refused}`;
    planName = "none";
    output = { title: "Claudinite key refused", summary: `${plan.refused}: ${REFUSAL_TEXT[plan.refused]}` };
  } else {
    outcome = `issued-${plan.state}`;
    planName = plan.plan;
    enqueueWrites(env, ctx, plan.writes);
    const links = wantsLinks(plan)
      ? await linksFor(env, { plan: plan.plan, ownerId: owner.id, ownerLogin: owner.login, ownerType: owner.type, repo: { id: repo.id, fullName: repo.fullName }, subscribed: plan.subscribed })
      : NO_LINKS;
    const { seed, cert } = issuingKey(env);
    const key = await mintKey(seed, cert, { typ: "session", repoId: repo.id, ownerId: owner.id, ownerType: owner.type, ownerLogin: owner.login, userId: sender.id, nonce, ...licenceFields(plan, links) }, nowS);
    const notice = plan.notice ? `, ${plan.notice}` : "";
    output = { title: "Claudinite key", summary: `${plan.plan} key for @${sender.login} (sender type User), state ${plan.state}${notice}, issued ${new Date(nowS * 1000).toISOString()}`, text: key };
  }

  try {
    await createKeyCheckRun(githubClient(env), { installationId, repoName: repo.name, fullName: repo.fullName, head, nonce }, output, nowS);
  } catch (err) {
    if (!(err instanceof GitHubError)) throw err;
    console.error(JSON.stringify({ githubError: err.call, status: err.status, body: err.body, marker: err.secondaryRateLimit ? "secondary-rate-limit" : undefined, delivery }));
    countPoint(env, { ...seen, plan: planName, outcome: "github-error" });
    return new Response(`github-error: ${err.call} ${err.status}`, { status: 502 });
  }
  countPoint(env, { ...seen, plan: planName, outcome });
  return new Response(outcome, { status: 201 });
}
