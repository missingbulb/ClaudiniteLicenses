// The version a Worker names on every answer: the id of the Cloudflare version that served it, from
// the `version_metadata` binding each Worker's wrangler.jsonc declares as CF_VERSION_METADATA. The
// canary probe tells a split's two versions apart by this header, and a log line is attributed by
// the same id. A source package only: each Worker bundles its own copy.

export const VERSION_HEADER = "X-Claudinite-Version";

export interface VersionEnv {
  CF_VERSION_METADATA?: { id: string };
}

/** The serving version's id, or null when the binding is absent: unknown, never an empty string. */
export function versionOf(env: VersionEnv): string | null {
  const id = env.CF_VERSION_METADATA?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** The answer with this Worker's version header set, replacing any a callee set; unchanged when the version is unknown. */
export function withVersion(res: Response, id: string | null): Response {
  if (id === null) return res;
  const out = new Response(res.body, res);
  out.headers.set(VERSION_HEADER, id);
  return out;
}
