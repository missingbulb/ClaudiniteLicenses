// The desktop path for public repos: `POST /v1/public/session-key` with the App user token. The
// user and the repo come from GitHub, read as the caller; GitHub saying public is the whole plan.
import { parseDesktopRequest, readDesktopCaller } from "../../../packages/github-app/src/index.ts";
import { keyCountBlobs } from "../../../packages/licensing/src/index.ts";
import type { Certificate } from "../../../packages/signing/src/index.ts";
import type { Env } from "./index.ts";
import { mintPublicSessionKey } from "./key.ts";

function refusal(status: number, reason: string): Response {
  console.log(JSON.stringify({ refused: reason, status }));
  return Response.json({ refused: reason }, { status });
}

export async function publicSessionKey(req: Request, env: Env): Promise<Response> {
  const parsed = await parseDesktopRequest(req);
  if (!parsed.ok) return refusal(parsed.status, parsed.reason);
  const { token, owner: ownerLogin, name, nonce, engineVersion } = parsed.request;
  const point = (outcome: string, repoId: string, ownerType: string) =>
    env.KEY_COUNTS?.writeDataPoint({ indexes: [repoId], blobs: keyCountBlobs({ plan: "public", outcome, ownerType, engineVersion, path: "desktop" }), doubles: [1] });

  const caller = await readDesktopCaller({ base: env.GITHUB_API_BASE ?? "https://api.github.com", userAgent: "claudinite-public-key" }, token, ownerLogin, name);
  if (!caller.ok) {
    // GitHub refusing the token is a caller nobody authenticated, which counts nothing; any other
    // refusal spent a real token on GitHub and counts.
    if (caller.reason !== "token-invalid") point(caller.reason === "github-error" ? "github-error" : `refused-${caller.reason}`, "unknown", "unknown");
    return refusal(caller.status, caller.reason);
  }
  const { user, repo, owner } = caller;
  if (repo.private) {
    point("refused-private", String(repo.id), owner.type);
    return refusal(403, "refused-private");
  }
  const key = await mintPublicSessionKey(
    env.ISSUING_KEY_PRIVATE,
    JSON.parse(env.ISSUING_KEY_CERT) as Certificate,
    { repoId: repo.id, ownerId: owner.id, ownerType: owner.type, ownerLogin: owner.login, userId: user.id, nonce },
    Math.floor(Date.now() / 1000),
  );
  point("issued", String(repo.id), owner.type);
  return Response.json({ key, plan: "public", state: "ok" });
}
