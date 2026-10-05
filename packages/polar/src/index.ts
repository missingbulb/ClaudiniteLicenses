// The Polar API client the license server and its tools share: the versioned call, the products
// we manage, checkouts, customer sessions, subscriptions, webhook endpoints, and the Standard
// Webhooks check on a delivery. Only fetch and WebCrypto, so a Worker bundles it and Node runs it.

export const POLAR_VERSION = "2026-10";
export const API_BASES = { sandbox: "https://sandbox-api.polar.sh", production: "https://api.polar.sh" } as const;
export const MANAGED_BY = "claudinite-licenses";

/** The subscription events the sync Worker writes from. */
export const SUBSCRIPTION_EVENTS = [
  "subscription.created",
  "subscription.updated",
  "subscription.active",
  "subscription.canceled",
  "subscription.uncanceled",
  "subscription.revoked",
  "subscription.past_due",
] as const;

/** Every event the deploy's endpoint subscribes to: the subscription events, and checkout.created, which the live read-back proves the signature with. */
export const WEBHOOK_EVENTS: string[] = [...SUBSCRIPTION_EVENTS, "checkout.created"];

/** A Polar call that failed: `status` is Polar's HTTP status, or null when no answer came. */
export class PolarError extends Error {
  readonly call: string;
  readonly status: number | null;
  readonly body: string;
  constructor(call: string, status: number | null, body: string) {
    super(status === null ? `${call}: ${body}` : `${call} answered ${status}: ${body}`);
    this.name = "PolarError";
    this.call = call;
    this.status = status;
    this.body = body;
  }
}

export interface PolarClientOptions {
  base: string;
  token: string;
  version?: string;
  fetch?: typeof fetch;
  /** Gives up on one call after this long. */
  timeoutMs?: number;
  /** How many times a 429 is retried after Polar's retry-after. */
  retries?: number;
  userAgent?: string;
}

export interface PolarClient {
  call(method: string, path: string, body?: unknown): Promise<any>;
  listAll(path: string): Promise<any[]>;
  versionServed(): string | null;
}

export function polarClient(opts: PolarClientOptions): PolarClient {
  const doFetch = opts.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const version = opts.version ?? POLAR_VERSION;
  let versionServed: string | null = null;

  async function once(method: string, path: string, body: unknown): Promise<Response> {
    const label = `${method} ${path}`;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const request = doFetch(`${opts.base}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${opts.token}`,
        Accept: "application/json",
        "Polar-Version": version,
        "User-Agent": opts.userAgent ?? "claudinite-licenses",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const timeout =
      opts.timeoutMs === undefined
        ? null
        : new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new PolarError(label, null, `timed out after ${opts.timeoutMs} ms`));
            }, opts.timeoutMs);
          });
    try {
      return await (timeout ? Promise.race([request, timeout]) : request);
    } catch (err) {
      if (err instanceof PolarError) throw err;
      throw new PolarError(label, null, String(err));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async function call(method: string, path: string, body?: unknown): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      const res = await once(method, path, body);
      if (res.status === 429 && attempt < (opts.retries ?? 0)) {
        await new Promise((ok) => setTimeout(ok, 1000 * Number(res.headers.get("retry-after") ?? 1)));
        continue;
      }
      versionServed ??= res.headers.get("polar-version");
      const text = await res.text();
      if (!res.ok) throw new PolarError(`${method} ${path}`, res.status, text.slice(0, 500));
      return text ? JSON.parse(text) : null;
    }
  }

  async function listAll(path: string): Promise<any[]> {
    const items: any[] = [];
    for (let page = 1; ; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const data = await call("GET", `${path}${sep}page=${page}&limit=100`);
      items.push(...data.items);
      if (page >= data.pagination.max_page) return items;
    }
  }

  return { call, listAll, versionServed: () => versionServed };
}

export type Interval = "month" | "year";

export interface PolarProduct {
  id: string;
  name: string;
  is_archived: boolean;
  recurring_interval: string | null;
  metadata: Record<string, unknown>;
  [k: string]: unknown;
}

export type ManagedProducts = Record<string, Partial<Record<Interval, PolarProduct>>>;

/** The unarchived products whose metadata says we manage them, by `claudinite_plan` and `claudinite_interval`. */
export async function listManagedProducts(client: PolarClient): Promise<ManagedProducts> {
  const out: ManagedProducts = {};
  for (const p of (await client.listAll("/v1/products/?is_archived=false")) as PolarProduct[]) {
    const plan = p.metadata?.claudinite_plan;
    const interval = p.metadata?.claudinite_interval;
    if (p.is_archived || p.metadata?.managed_by !== MANAGED_BY || typeof plan !== "string" || (interval !== "month" && interval !== "year")) continue;
    (out[plan] ??= {})[interval] ??= p;
  }
  return out;
}

export interface CheckoutFor {
  plan: string;
  ownerId: number;
  ownerLogin: string;
  ownerType: "User" | "Organization";
}

/**
 * Creates a checkout offering both of the plan's products, monthly first, so the buyer picks the
 * interval on Polar's page. The owner's numeric GitHub id is the external customer id, and the
 * metadata names the owner: a fleet covers every repo the owner has, so no repo is named.
 */
export async function createCheckout(client: PolarClient, f: CheckoutFor, products?: ManagedProducts): Promise<{ id: string; url: string; expires_at: string }> {
  const byInterval = (products ?? (await listManagedProducts(client)))[f.plan];
  const ids = [byInterval?.month?.id, byInterval?.year?.id].filter((id): id is string => typeof id === "string");
  if (ids.length === 0) throw new Error(`no managed products for ${f.plan}`);
  const metadata: Record<string, string> = {
    claudinite_plan: f.plan,
    github_owner_id: String(f.ownerId),
    github_owner_login: f.ownerLogin,
    github_owner_type: f.ownerType,
  };
  const made = await client.call("POST", "/v1/checkouts/", { products: ids, external_customer_id: String(f.ownerId), metadata });
  return { id: made.id, url: made.url, expires_at: made.expires_at };
}

/**
 * The owner's customer portal link, from a customer session made by external customer id, or null
 * when Polar has no such customer. Polar's 2026-10 schema names no 404 for this route; an unknown
 * external id is answered 404 or 422, and both read as no customer.
 */
export async function createCustomerSession(client: PolarClient, f: { ownerId: number }): Promise<string | null> {
  try {
    const session = await client.call("POST", "/v1/customer-sessions/", { external_customer_id: String(f.ownerId) });
    return typeof session?.customer_portal_url === "string" ? session.customer_portal_url : null;
  } catch (err) {
    if (err instanceof PolarError && (err.status === 404 || err.status === 422)) return null;
    throw err;
  }
}

export interface PolarSubscription {
  id: string;
  created_at: string;
  modified_at: string | null;
  status: string;
  seats?: number | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  ended_at: string | null;
  product_id: string;
  metadata: Record<string, unknown>;
  customer: { id: string; external_id: string | null; [k: string]: unknown };
  product: PolarProduct;
  [k: string]: unknown;
}

/** Every subscription, active and ended alike: a revoked one is the row that sets seats to zero. */
export async function listSubscriptions(client: PolarClient): Promise<PolarSubscription[]> {
  return (await client.listAll("/v1/subscriptions/")) as PolarSubscription[];
}

/**
 * Keeps one raw, 2026-10 endpoint at `url`. One already listed there is kept, unless `rotate`;
 * otherwise every endpoint at that url is deleted and a new one created. Polar returns an
 * endpoint's secret only in the create answer, so the caller must store it at once.
 */
export async function ensureWebhookEndpoint(client: PolarClient, f: { url: string; events: string[]; rotate?: boolean }): Promise<{ id: string; kept: true } | { id: string; secret: string; kept: false }> {
  const atUrl = ((await client.listAll("/v1/webhooks/endpoints")) as { id: string; url: string }[]).filter((e) => e.url === f.url);
  if (atUrl.length === 1 && !f.rotate) return { id: atUrl[0]!.id, kept: true };
  for (const e of atUrl) await client.call("DELETE", `/v1/webhooks/endpoints/${e.id}`);
  const made = await client.call("POST", "/v1/webhooks/endpoints", { url: f.url, format: "raw", events: f.events, api_version: POLAR_VERSION });
  return { id: made.id, secret: made.secret, kept: false };
}

/** How far a delivery's timestamp may be from the verifier's clock, in seconds. */
export const WEBHOOK_TOLERANCE_S = 300;

export type WebhookRefusal = "signature-missing" | "timestamp-skew" | "signature-mismatch" | "payload-malformed";

export interface WebhookEvent {
  type: string;
  timestamp?: string;
  data: any;
}

function b64decode(s: string): Uint8Array<ArrayBuffer> | null {
  try {
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function b64encode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function hmacKey(secret: string): Promise<CryptoKey | null> {
  const raw = b64decode(secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret);
  if (!raw || raw.length === 0) return null;
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** The `v1,<base64>` signature Standard Webhooks puts on `${id}.${timestamp}.${body}`, keyed by the secret's base64 after `whsec_`. */
export async function signDelivery(secret: string, id: string, timestamp: number, body: string): Promise<string> {
  const key = await hmacKey(secret);
  if (!key) throw new Error("not a whsec_ secret");
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)));
  return `v1,${b64encode(sig)}`;
}

/**
 * Checks a delivery as Standard Webhooks specifies, which every secret Polar generated after
 * 2026-09-08 follows: `webhook-id`, a `webhook-timestamp` within 5 minutes of `nowS`, and a
 * `webhook-signature` of space-separated `v1,<base64>` entries, any one of which must be the HMAC.
 * HMAC verify compares in constant time.
 */
export async function verifyWebhook(headers: Headers | Request, body: string, secret: string, nowS: number): Promise<{ ok: true; id: string; event: WebhookEvent } | { ok: false; reason: WebhookRefusal }> {
  const h = headers instanceof Request ? headers.headers : headers;
  const id = h.get("webhook-id");
  const timestamp = h.get("webhook-timestamp");
  const signatures = h.get("webhook-signature");
  if (!id || !timestamp || !signatures) return { ok: false, reason: "signature-missing" };
  const t = Number(timestamp);
  if (!/^\d+$/.test(timestamp) || Math.abs(nowS - t) > WEBHOOK_TOLERANCE_S) return { ok: false, reason: "timestamp-skew" };
  const key = await hmacKey(secret);
  if (!key) return { ok: false, reason: "signature-mismatch" };
  const signed = new TextEncoder().encode(`${id}.${timestamp}.${body}`);
  let matched = false;
  for (const entry of signatures.split(" ")) {
    const [scheme, value] = entry.split(",", 2);
    const sig = scheme === "v1" && value ? b64decode(value) : null;
    if (sig && (await crypto.subtle.verify("HMAC", key, sig, signed))) matched = true;
  }
  if (!matched) return { ok: false, reason: "signature-mismatch" };
  let event: unknown;
  try {
    event = JSON.parse(body);
  } catch {
    return { ok: false, reason: "payload-malformed" };
  }
  if (typeof event !== "object" || event === null || typeof (event as WebhookEvent).type !== "string") return { ok: false, reason: "payload-malformed" };
  return { ok: true, id, event: event as WebhookEvent };
}
