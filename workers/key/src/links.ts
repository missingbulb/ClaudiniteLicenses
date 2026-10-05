// The checkout and portal links a key carries when its owner has no fleet: the checkout of the fleet
// the owner's type can buy, and the portal when the owner has any subscription. Polar is asked only
// for such a key, with one deadline over every call, and never delays or fails a key: a link Polar
// does not give in time is null, with an incident for the alerts.
import { checkoutPlanFor, type OwnerType } from "../../../packages/licensing/src/index.ts";
import { createCheckout, createCustomerSession, listManagedProducts, polarClient, POLAR_VERSION, type ManagedProducts, type PolarClient } from "../../../packages/polar/src/index.ts";
import type { Plan } from "../../../packages/signing/src/index.ts";
import { incident, type IncidentEnv } from "./incidents.ts";

export const LINK_DEADLINE_MS = 3000;
const CACHE_MS = 3600_000;

export interface Links {
  checkout_url: string | null;
  portal_url: string | null;
}

export interface LinkSubject {
  ownerId: number;
  ownerLogin: string;
  ownerType: OwnerType;
  subscribed: boolean;
}

export const NO_LINKS: Links = { checkout_url: null, portal_url: null };

const linkCache = new Map<string, { at: number; links: Links }>();
let productCache: { at: number; base: string; products: ManagedProducts } | null = null;

/** Empties the isolate's caches, for tests that run in one isolate. */
export function resetLinkCaches(): void {
  linkCache.clear();
  productCache = null;
}

/** Whether a key on this plan needs a link at all: only the no-fleet answer does. */
export function wantsLinks(r: { plan: Plan }): boolean {
  return r.plan === "public";
}

const https = (u: unknown): string | null => (typeof u === "string" && u.startsWith("https://") ? u : null);

async function products(client: PolarClient, base: string): Promise<ManagedProducts> {
  if (productCache && productCache.base === base && Date.now() - productCache.at < CACHE_MS) return productCache.products;
  const fresh = await listManagedProducts(client);
  productCache = { at: Date.now(), base, products: fresh };
  return fresh;
}

export async function linksFor(env: IncidentEnv & { POLAR_API_BASE?: string; POLAR_ACCESS_TOKEN?: string }, s: LinkSubject, ctx?: ExecutionContext): Promise<Links> {
  if (!env.POLAR_API_BASE || !env.POLAR_ACCESS_TOKEN) {
    incident(env, ctx, "polar-unreachable", "unconfigured", { call: "unconfigured" });
    return NO_LINKS;
  }
  const plan = checkoutPlanFor(s.ownerType);
  const key = `${s.ownerId}:${plan}:${s.subscribed}`;
  const cached = linkCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.links;

  // The client aborts what the race below abandons; the race keeps one deadline over both calls.
  const client = polarClient({ base: env.POLAR_API_BASE, token: env.POLAR_ACCESS_TOKEN, version: POLAR_VERSION, userAgent: "claudinite-key", timeoutMs: LINK_DEADLINE_MS });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((ok) => (timer = setTimeout(() => ok("timeout"), LINK_DEADLINE_MS)));
  const within = async (call: string, work: () => Promise<string | null>): Promise<{ url: string | null; failed: boolean }> => {
    const settled = await Promise.race([work().then((url) => ({ url: https(url) })).catch((err: unknown) => ({ err })), deadline]);
    if (settled === "timeout" || "err" in settled) {
      incident(env, ctx, "polar-unreachable", call, { call, error: settled === "timeout" ? `no answer in ${LINK_DEADLINE_MS} ms` : String(settled.err) });
      return { url: null, failed: true };
    }
    return { url: settled.url, failed: false };
  };
  try {
    const [checkout, portal] = await Promise.all([
      within("checkout", async () => (await createCheckout(client, { plan, ownerId: s.ownerId, ownerLogin: s.ownerLogin, ownerType: s.ownerType }, await products(client, env.POLAR_API_BASE!))).url),
      s.subscribed ? within("customer-session", () => createCustomerSession(client, { ownerId: s.ownerId })) : Promise.resolve({ url: null, failed: false }),
    ]);
    const links = { checkout_url: checkout.url, portal_url: portal.url };
    if (!checkout.failed && !portal.failed) linkCache.set(key, { at: Date.now(), links });
    return links;
  } finally {
    clearTimeout(timer);
  }
}
