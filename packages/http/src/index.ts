// What every Worker does to a request before it spends anything on it: the per-address cap, the
// body caps, and the cut on the one caller-supplied string that becomes a usage blob. A source
// package only: each Worker bundles its own copy, as it does packages/version.
//
// The cap is Cloudflare's rate-limiting binding, a `ratelimits` entry in each wrangler.jsonc
// (developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/, read 2026-10-01): `limit({
// key })` resolves `{ success }`; `simple.period` is 10 or 60 seconds; the count is per Cloudflare
// location, kept on the machine and synced in the background, so it is permissive and eventually
// consistent rather than exact; a `namespace_id` shared by two bindings shares their counters, so
// each Worker's IP_LIMIT has its own. The page says nothing of what `limit()` does when its store
// is unreachable, so a throw, or a binding missing from the environment, lets the request through:
// the cap protects capacity, and a missing cap must not refuse a real caller.

export const BODY_MAX_JSON = 16 * 1024;
/** GitHub's and Polar's deliveries: theirs to size, so the cap only bounds what a stranger can send. */
export const BODY_MAX_WEBHOOK = 1024 * 1024;
export const ENGINE_VERSION_MAX = 64;
export const IP_LIMITED = "rate-limited";

export interface IpLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface IpLimitEnv {
  IP_LIMIT?: IpLimiter;
}

const MINUTE_MS = 60_000;

// Per isolate: how many requests the cap refused since the last ip-limited line, and when each
// marker last logged, so a flood writes one line a minute rather than one per request.
let refusedSinceLine = 0;
const lastLine: Record<string, number> = {};

function onceAMinute(marker: string, line: Record<string, unknown>): boolean {
  const now = Date.now();
  if (lastLine[marker] !== undefined && now - lastLine[marker]! < MINUTE_MS) return false;
  lastLine[marker] = now;
  console.log(JSON.stringify({ marker, ...line }));
  return true;
}

/** Forgets the per-isolate log clocks; tests only. */
export function resetIpLimitLog(): void {
  refusedSinceLine = 0;
  for (const k of Object.keys(lastLine)) delete lastLine[k];
}

/** Whether the caller's address is within its cap; true when the limiter cannot answer. */
export async function withinIpLimit(env: IpLimitEnv, req: Request): Promise<boolean> {
  const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
  let success: boolean;
  try {
    if (!env.IP_LIMIT) throw new Error("IP_LIMIT is not bound");
    ({ success } = await env.IP_LIMIT.limit({ key: `ip:${ip}` }));
  } catch (err) {
    onceAMinute("ip-limit-unavailable", { error: String(err) });
    return true;
  }
  if (success) return true;
  refusedSinceLine++;
  if (onceAMinute("ip-limited", { count: refusedSinceLine })) refusedSinceLine = 0;
  return false;
}

export function ipLimited(): Response {
  return Response.json({ refused: IP_LIMITED }, { status: 429 });
}

export function tooLarge(): Response {
  return Response.json({ refused: "body-too-large" }, { status: 413 });
}

/** The body's bytes, or null when it is, or claims to be, longer than `max`. */
export async function readCapped(req: Request, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(req.headers.get("Content-Length") ?? "0");
  if (declared > max) return null;
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export type CappedJson = { ok: true; value: unknown } | { ok: false; reason: "body-too-large" | "malformed-body" };

/** The body parsed as JSON, read no further than `max` bytes. */
export async function readJsonCapped(req: Request, max: number): Promise<CappedJson> {
  const bytes = await readCapped(req, max);
  if (bytes === null) return { ok: false, reason: "body-too-large" };
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, reason: "malformed-body" };
  }
}

/** The caller's engine version as a usage blob takes it: never longer than ENGINE_VERSION_MAX. */
export function capEngineVersion(v: string): string {
  return v.slice(0, ENGINE_VERSION_MAX);
}
