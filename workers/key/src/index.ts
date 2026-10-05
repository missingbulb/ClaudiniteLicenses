// The key Worker: answers an Actions run's OIDC token with the owner's key, deciding from D1 reads
// alone. It writes nothing to D1: each incident goes onto the writes queue the sync Worker consumes.
import { certStanding } from "../../../packages/signing/src/index.ts";
import { ipLimited, ipLimitState, withoutBody, type IpLimitState } from "../../../packages/http/src/index.ts";
import { certBody, type Env } from "./env.ts";
import { actionsKey } from "./actions.ts";
import { versionOf, withVersion } from "../../../packages/version/src/index.ts";
import { reader } from "./db.ts";

export type { Env } from "./env.ts";

/** Where and how fast a D1 read was served, each null when the result's meta does not say. */
interface ServedBy {
  d1_served_by_primary: boolean | null;
  d1_served_by_region: string | null;
  d1_ms: number | null;
}

const UNKNOWN_SERVED: ServedBy = { d1_served_by_primary: null, d1_served_by_region: null, d1_ms: null };

/** D1Result's meta fields (developers.cloudflare.com/d1/worker-api/return-object/), absent locally. */
function servedBy(meta: Partial<D1Meta> | undefined): ServedBy {
  return {
    d1_served_by_primary: typeof meta?.served_by_primary === "boolean" ? meta.served_by_primary : null,
    d1_served_by_region: typeof meta?.served_by_region === "string" ? meta.served_by_region : null,
    d1_ms: typeof meta?.duration === "number" ? meta.duration : null,
  };
}

/**
 * Judges its own certificate and D1, answering 503 while either is wrong, and says where and how
 * fast its D1 read was served.
 */
async function health(env: Env, ipLimit: IpLimitState | null): Promise<Response> {
  const body = certBody(env);
  let d1: "ok" | "unreadable" = "ok";
  let served = UNKNOWN_SERVED;
  try {
    served = servedBy((await reader(env).prepare("SELECT 1").run()).meta);
  } catch {
    d1 = "unreadable";
  }
  const cert = certStanding(body.notAfter, new Date());
  const alerts = [cert.alert, d1 === "unreadable" ? "d1-unreadable" : null].filter((a) => a !== null);
  return Response.json(
    {
      ok: alerts.length === 0,
      kid: body.keyId,
      cert_exp: body.notAfter,
      cert_days_left: cert.daysLeft,
      d1,
      ...served,
      queue: env.WRITES ? "bound" : "unbound",
      polar: env.POLAR_API_BASE && env.POLAR_ACCESS_TOKEN ? "configured" : "unconfigured",
      ip_limit: ipLimit,
      version: versionOf(env),
      alerts,
    },
    { status: alerts.length === 0 ? 200 : 503 },
  );
}

/** Every route Cloudflare serves to the world: each meets the per-address cap before anything else. */
export const PUBLIC_ROUTES = ["POST /v1/actions-key", "GET /v1/key/health", "HEAD /v1/key/health"];

async function route(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const at = `${req.method} ${url.pathname}`;
  const ipLimit = PUBLIC_ROUTES.includes(at) ? await ipLimitState(env, req) : null;
  if (ipLimit === "refused") return ipLimited();
  switch (at) {
    case "POST /v1/actions-key":
      return actionsKey(req, env, ctx);
    case "GET /v1/key/health":
      return health(env, ipLimit);
    case "HEAD /v1/key/health":
      return withoutBody(await health(env, ipLimit));
    default:
      return new Response("not found", { status: 404 });
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return withVersion(await route(req, env, ctx), versionOf(env));
  },
};
