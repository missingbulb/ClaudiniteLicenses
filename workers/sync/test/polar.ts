import { vi } from "vitest";
import { signDelivery } from "../../../packages/polar/src/index.ts";
import { env } from "./github.ts";

export const POLAR = "https://polar-api.test";
export const iso = (s: number) => new Date(s * 1000).toISOString();
export const unix = (t: string) => Math.floor(Date.parse(t) / 1000);

const product = (plan: string, interval: string, managed = true) => ({
  id: `prod_${plan}_${interval}`,
  name: `${plan} (${interval})`,
  is_archived: false,
  recurring_interval: interval,
  metadata: { claudinite_plan: plan, claudinite_interval: interval, ...(managed ? { managed_by: "claudinite-licenses" } : {}) },
});

/** A Polar 2026-10 subscription as a webhook or the listing carries it. */
export function polarSub(over: Record<string, unknown> & { plan?: string; interval?: string; managed?: boolean; externalId?: string | null } = {}) {
  const { plan = "personal", interval = "month", managed = true, externalId = "2002", ...rest } = over;
  const p = product(plan, interval, managed);
  return {
    id: "sub_acme",
    created_at: "2026-09-01T00:00:00Z",
    modified_at: "2026-09-02T00:00:00Z",
    status: "active",
    recurring_interval: interval,
    seats: 5,
    current_period_start: "2026-09-01T00:00:00Z",
    current_period_end: "2026-10-01T00:00:00Z",
    cancel_at_period_end: false,
    canceled_at: null,
    ended_at: null,
    product_id: p.id,
    metadata: { claudinite_plan: plan, github_owner_id: externalId, github_owner_login: "acme-user", github_owner_type: "User" },
    customer: { id: "cus_acme", external_id: externalId, email: "acme@example.com" },
    product: p,
    ...rest,
  };
}

/** A signed Standard Webhooks delivery to the sync Worker's Polar route. */
export async function polarDelivery(type: string, data: unknown, opts: { secret?: string; timestamp?: number } = {}): Promise<Request> {
  const body = JSON.stringify({ type, timestamp: new Date().toISOString(), data });
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const id = `msg_${crypto.randomUUID()}`;
  return new Request("https://license.claudinite.com/v1/sync/polar-webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "webhook-id": id, "webhook-timestamp": String(timestamp), "webhook-signature": await signDelivery(opts.secret ?? env.POLAR_WEBHOOK_SECRET!, id, timestamp, body) },
    body,
  });
}

export interface FakePolar {
  calls: string[];
  subscriptions: unknown[];
  status: number;
}

/** Stands in for Polar's subscription listing on POLAR, paged as Polar pages; every other URL goes to whatever fetch answered before. */
export function fakePolar(): FakePolar {
  const polar: FakePolar = { calls: [], subscriptions: [], status: 200 };
  const before = vi.isMockFunction(globalThis.fetch) ? vi.mocked(globalThis.fetch).getMockImplementation() : undefined;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.origin !== POLAR) return before ? before(input, init) : new Response("unexpected", { status: 599 });
    polar.calls.push(`${req.method} ${url.pathname}${url.search} ${req.headers.get("Authorization")} ${req.headers.get("Polar-Version")}`);
    if (polar.status !== 200) return Response.json({ detail: "stubbed failure" }, { status: polar.status });
    if (req.method === "GET" && url.pathname === "/v1/subscriptions/") {
      const limit = Number(url.searchParams.get("limit") ?? 10);
      const page = Number(url.searchParams.get("page") ?? 1);
      return Response.json({ items: polar.subscriptions.slice((page - 1) * limit, page * limit), pagination: { total_count: polar.subscriptions.length, max_page: Math.max(1, Math.ceil(polar.subscriptions.length / limit)) } });
    }
    return new Response("unexpected", { status: 599 });
  });
  return polar;
}

export interface SubscriptionRowRead {
  polar_subscription_id: string;
  owner_id: number;
  owner_type: string;
  plan: string;
  seats: number | null;
  source: string;
  period_end: number | null;
  cancel_at_period_end: number | null;
  modified_at: number;
  raw: string;
  status: string | null;
  ended_at: number | null;
  product_id: string | null;
  interval: string | null;
}

export async function subscriptionRows(): Promise<SubscriptionRowRead[]> {
  const { results } = await env.DB.prepare("SELECT * FROM subscriptions ORDER BY polar_subscription_id").all<SubscriptionRowRead>();
  return results;
}
