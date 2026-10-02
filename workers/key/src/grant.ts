// Item grants: `POST /v1/item-grant` exchanges an Actions key and a work item's issue number for a
// grant key carrying the Actions key's licence, so the executor can show a routine session it may
// work that item. The Actions key must chain to a trusted root; there is no replay store.
import { verifyKey } from "../../../packages/signing/src/index.ts";
import { BODY_MAX_JSON, readJsonCapped } from "../../../packages/http/src/index.ts";
import { countPoint, issuingKey, refusal, trustRoots, withinOwnerLimit, type Env } from "./env.ts";
import { mintKey } from "./key.ts";

function refuseKey(reason: string): Response {
  console.log(JSON.stringify({ refused: "key-invalid", reason, status: 401 }));
  return Response.json({ refused: "key-invalid", reason }, { status: 401 });
}

export async function itemGrant(req: Request, env: Env): Promise<Response> {
  const key = /^Bearer (\S+)$/.exec(req.headers.get("Authorization") ?? "")?.[1];
  if (!key) return refuseKey("shape");
  const read = await readJsonCapped(req, BODY_MAX_JSON);
  if (!read.ok && read.reason === "body-too-large") return refusal(413, read.reason);
  const trust = trustRoots(env);
  if ("invalid" in trust) return refusal(503, "trust-roots-invalid");
  const verdict = await verifyKey(key, { roots: trust.roots, now: new Date() });
  if (!verdict.ok) return refuseKey(verdict.reason);
  const a = verdict.payload;
  if (a.typ !== "actions") return refusal(403, "key-not-actions");
  const issue = read.ok ? (read.value as { issue?: unknown } | null)?.issue : undefined;
  if (typeof issue !== "number" || !Number.isSafeInteger(issue) || issue <= 0) return refusal(400, "issue-invalid");
  if (!(await withinOwnerLimit(env, a.owner_login))) return refusal(429, "rate-limited");

  const nowS = Math.floor(Date.now() / 1000);
  const { seed, cert } = issuingKey(env);
  const grant = await mintKey(
    seed,
    cert,
    {
      typ: "grant",
      issue,
      notAfter: a.exp,
      repoId: a.repo_id,
      ownerId: a.owner_id,
      ownerType: a.owner_type,
      ownerLogin: a.owner_login,
      plan: a.plan,
      state: a.state,
      graceUntil: a.grace_until,
      features: a.features,
      seats: a.seats ?? null,
      checkoutUrl: a.checkout_url ?? null,
      portalUrl: a.portal_url ?? null,
      notice: a.notice ?? null,
    },
    nowS,
  );
  countPoint(env, { repoId: String(a.repo_id), plan: a.plan, outcome: `issued-${a.state}`, ownerType: a.owner_type, engineVersion: "unknown", path: "grant" });
  return Response.json({ grant });
}
