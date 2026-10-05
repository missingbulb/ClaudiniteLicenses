#!/usr/bin/env node
// A local stand-in for the Polar API calls the billing tools and the Workers make: the token's
// organization and its customer portal settings, products with their prices and benefits,
// subscriptions (paged, from a seeded list), checkouts, customer sessions, and webhook endpoints
// with a generated whsec_ secret each, plus deliver(), which posts a Standard Webhooks delivery
// signed with an endpoint's secret to its url. It answers only requests carrying its token and a
// Polar-Version it knows, and records every write. The links it hands out are https URLs naming
// the stub's address, which nothing serves over TLS; they only have to be shaped like Polar's.
// slow(ms) holds every answer that long, for a caller's own deadline to run out first.
//
//   node tools/polar-stub.mjs --port <n> [--token <t>] [--slow-ms <ms>]
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { parseArgs } from "node:util";
import { MANAGED_BY, signDelivery } from "../packages/polar/src/index.ts";

export { signDelivery };

export const STUB_VERSIONS = ["2026-04", "2026-10", "2027-01"];

/**
 * @typedef {{ id: string, created_at: string, modified_at: string | null, source: string, amount_type: string, price_currency: string, tax_behavior: string | null, is_archived: boolean, product_id: string, seat_tiers?: any, price_amount?: number }} Price
 * @typedef {{ id: string, created_at: string, modified_at: string | null, name: string, description: string | null, visibility: string, recurring_interval: string | null, recurring_interval_count: number | null, is_recurring: boolean, is_archived: boolean, organization_id: string, metadata: Record<string, unknown>, prices: Price[], benefits: { id: string }[], medias: [], attached_custom_fields: [] }} Product
 * @typedef {{ name?: string, metadata?: Record<string, unknown>, recurring_interval?: string | null, is_archived?: boolean, prices?: any[], benefits?: string[] }} Seed
 * @typedef {{ id?: string, externalId: string | null, plan: string, interval?: "month" | "year", seats: number, status?: string, ownerType?: string, metadata?: Record<string, unknown>, product?: any, managed?: boolean }} SubscriptionSeed
 * @typedef {{ id: string, created_at: string, modified_at: string | null, url: string, name: string | null, api_version: string, format: string, secret: string, organization_id: string, events: string[], enabled: boolean, uses_standard_webhook_signature: boolean }} Endpoint
 */

/**
 * @param {{ port?: number, token?: string, organizationName?: string, portalSettings?: any }} [opts]
 */
export async function startPolarStub(opts = {}) {
  const token = opts.token ?? "polar_oat_stub";
  let clock = Date.parse("2026-01-01T00:00:00Z");
  const now = () => new Date((clock += 1000)).toISOString();
  const organization = {
    id: randomUUID(),
    created_at: now(),
    name: opts.organizationName ?? "MissingBulb",
    slug: (opts.organizationName ?? "MissingBulb").toLowerCase(),
    customer_portal_settings: opts.portalSettings === undefined ? { usage: { show: true }, subscription: { update_seats: false, update_plan: true }, customer: { allow_email_change: true } } : opts.portalSettings,
  };
  const state = {
    organization,
    /** @type {Product[]} */
    products: [],
    /** @type {Price[]} */
    archivedPrices: [],
    /** @type {{ method: string, path: string, body: any }[]} */
    writes: [],
    /** @type {string[]} */
    requests: [],
    /** @type {any[]} */
    subscriptions: [],
    /** @type {{ id: string, body: any }[]} */
    checkouts: [],
    /** @type {any[]} */
    customerSessions: [],
    /** @type {Endpoint[]} */
    endpoints: [],
  };
  /** @type {string} filled once the server listens */
  let linkOrigin = "";
  let slowMs = 0;

  /** @param {string} productId @param {any} p @returns {Price} */
  const newPrice = (productId, p) => ({
    id: randomUUID(),
    created_at: now(),
    modified_at: null,
    source: "catalog",
    amount_type: p.amount_type,
    price_currency: p.price_currency ?? "usd",
    tax_behavior: p.tax_behavior ?? null,
    is_archived: false,
    product_id: productId,
    ...(p.amount_type === "seat_based"
      ? {
          seat_tiers: {
            seat_tier_type: p.seat_tiers.seat_tier_type ?? "volume",
            tiers: p.seat_tiers.tiers.map((/** @type {any} */ t) => ({ min_seats: t.min_seats, max_seats: t.max_seats ?? null, price_per_seat: t.price_per_seat })),
            minimum_seats: p.seat_tiers.tiers[0].min_seats,
            maximum_seats: p.seat_tiers.tiers.at(-1).max_seats ?? null,
          },
        }
      : { price_amount: p.price_amount ?? 0 }),
  });

  /** @param {Seed} seed @returns {Product} */
  const addProduct = (seed) => {
    const id = randomUUID();
    const interval = seed.recurring_interval === undefined ? "month" : seed.recurring_interval;
    /** @type {Product} */
    const product = {
      id,
      created_at: now(),
      modified_at: null,
      name: seed.name ?? "Hand-made product",
      description: null,
      visibility: "public",
      recurring_interval: interval,
      recurring_interval_count: interval ? 1 : null,
      is_recurring: Boolean(interval),
      is_archived: seed.is_archived ?? false,
      organization_id: organization.id,
      metadata: seed.metadata ?? {},
      prices: [],
      benefits: (seed.benefits ?? []).map((b) => ({ id: b })),
      medias: [],
      attached_custom_fields: [],
    };
    product.prices = (seed.prices ?? [{ amount_type: "fixed", price_amount: 500 }]).map((p) => newPrice(id, p));
    state.products.push(product);
    return product;
  };

  /** A Polar-shaped subscription, on a product we manage for the plan unless `managed` is false. @param {SubscriptionSeed} seed */
  const createSubscription = (seed) => {
    const interval = seed.interval ?? "month";
    const product =
      seed.product ??
      state.products.find((p) => p.metadata.managed_by === MANAGED_BY && p.metadata.claudinite_plan === seed.plan && p.metadata.claudinite_interval === interval) ?? {
        id: randomUUID(),
        name: `${seed.plan} (${interval})`,
        is_archived: false,
        recurring_interval: interval,
        metadata: { claudinite_plan: seed.plan, claudinite_interval: interval, ...(seed.managed === false ? {} : { managed_by: MANAGED_BY }) },
      };
    const at = now();
    const metadata = {
      claudinite_plan: seed.plan,
      ...(seed.externalId ? { github_owner_id: seed.externalId } : {}),
      github_owner_type: seed.ownerType ?? (seed.plan === "organization" ? "Organization" : "User"),
      ...seed.metadata,
    };
    const sub = {
      id: seed.id ?? randomUUID(),
      created_at: at,
      modified_at: null,
      status: seed.status ?? "active",
      recurring_interval: interval,
      current_period_start: at,
      current_period_end: new Date(Date.parse(at) + 30 * 86_400_000).toISOString(),
      cancel_at_period_end: false,
      canceled_at: null,
      started_at: at,
      ends_at: null,
      ended_at: null,
      customer_id: randomUUID(),
      product_id: product.id,
      seats: seed.seats,
      metadata,
      customer: { id: randomUUID(), external_id: seed.externalId, email: "acme@example.com" },
      product,
    };
    state.subscriptions.push(sub);
    return sub;
  };

  /** Ends a subscription as Polar's revoke does: canceled, ended at `at`. @param {string} id @param {string} at */
  const endSubscription = (id, at) => {
    const sub = state.subscriptions.find((s) => s.id === id);
    if (!sub) throw new Error(`no subscription ${id}`);
    Object.assign(sub, { status: "canceled", ended_at: at, ends_at: at, canceled_at: at, modified_at: now() });
    return sub;
  };

  /** @param {{ url: string, events: string[], format?: string, api_version?: string }} body @returns {Endpoint} */
  const addEndpoint = (body) => {
    const endpoint = {
      id: randomUUID(),
      created_at: now(),
      modified_at: null,
      url: body.url,
      name: null,
      api_version: body.api_version ?? "2026-04",
      format: body.format ?? "raw",
      secret: `whsec_${randomBytes(32).toString("base64")}`,
      organization_id: organization.id,
      events: body.events,
      enabled: true,
      uses_standard_webhook_signature: true,
    };
    state.endpoints.push(endpoint);
    return endpoint;
  };

  /**
   * Posts one Standard Webhooks delivery of `event` to the endpoint's url, signed with its secret,
   * and returns the answer's status.
   * @param {string} event @param {unknown} data @param {{ endpointId: string, timestamp?: number }} opts
   */
  const deliver = async (event, data, opts) => {
    const endpoint = state.endpoints.find((e) => e.id === opts.endpointId);
    if (!endpoint) throw new Error(`no endpoint ${opts.endpointId}`);
    const id = `msg_${randomUUID()}`;
    const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ type: event, timestamp: new Date(timestamp * 1000).toISOString(), data });
    const res = await fetch(endpoint.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "webhook-id": id, "webhook-timestamp": String(timestamp), "webhook-signature": await signDelivery(endpoint.secret, id, timestamp, body) },
      body,
    });
    await res.arrayBuffer();
    return res.status;
  };

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : undefined;
    const url = new URL(req.url ?? "/", "http://stub");
    const path = url.pathname;
    state.requests.push(`${req.method} ${path}${url.search}`);
    if (slowMs > 0) {
      await new Promise((ok) => setTimeout(ok, slowMs));
      // A caller that gave up has closed the socket; there is nobody left to answer.
      if (res.destroyed || req.socket.destroyed) return;
    }
    /** @param {number} status @param {unknown} [data] */
    const send = (status, data) => {
      res.writeHead(status, { "Content-Type": "application/json", "Polar-Version": String(req.headers["polar-version"] ?? "2026-10") });
      res.end(data === undefined ? "" : JSON.stringify(data));
    };
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: "invalid_token" });
    if (!STUB_VERSIONS.includes(String(req.headers["polar-version"]))) return send(404, { detail: "Not Found" });
    if (req.method !== "GET") state.writes.push({ method: req.method ?? "", path, body });

    /** @param {unknown[]} all */
    const page = (all) => {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 10), 100);
      const n = Number(url.searchParams.get("page") ?? 1);
      return send(200, { items: all.slice((n - 1) * limit, n * limit), pagination: { total_count: all.length, max_page: Math.max(1, Math.ceil(all.length / limit)) } });
    };
    let m;
    if (req.method === "GET" && path === "/v1/organizations/") return page([organization]);
    if (req.method === "PATCH" && path === `/v1/organizations/${organization.id}`) {
      for (const [k, v] of Object.entries(body ?? {})) if (v !== null) Object.assign(organization, { [k]: v });
      return send(200, organization);
    }
    if (req.method === "GET" && path === "/v1/products/") {
      const archived = url.searchParams.get("is_archived");
      return page(state.products.filter((p) => archived === null || String(p.is_archived) === archived));
    }
    if (req.method === "POST" && path === "/v1/products/") {
      if (!body?.name || !Array.isArray(body.prices) || body.prices.length === 0 || !body.recurring_interval) return send(422, { detail: [{ msg: "name, prices and recurring_interval are required" }] });
      const product = addProduct({ name: body.name, metadata: body.metadata, recurring_interval: body.recurring_interval, prices: body.prices });
      return send(201, product);
    }
    if ((m = /^\/v1\/products\/([^/]+)$/.exec(path))) {
      const product = state.products.find((p) => p.id === m[1]);
      if (!product) return send(404, { error: "ResourceNotFound" });
      if (req.method === "GET") return send(200, product);
      if (req.method === "PATCH") {
        if (body.recurring_interval !== undefined && body.recurring_interval !== product.recurring_interval) return send(403, { error: "NotPermitted", detail: "recurring_interval can't be changed" });
        if (body.name !== undefined) product.name = body.name;
        if (body.metadata !== undefined) product.metadata = body.metadata;
        if (body.is_archived !== undefined) product.is_archived = body.is_archived;
        if (body.prices !== undefined) {
          const kept = [];
          for (const p of body.prices) {
            if (p.id) {
              const existing = product.prices.find((x) => x.id === p.id);
              if (!existing) return send(422, { detail: [{ msg: `price ${p.id} is not on this product` }] });
              kept.push(existing);
            } else kept.push(newPrice(product.id, p));
          }
          for (const old of product.prices) if (!kept.includes(old)) state.archivedPrices.push({ ...old, is_archived: true });
          product.prices = kept;
        }
        product.modified_at = now();
        return send(200, product);
      }
    }
    if (req.method === "POST" && (m = /^\/v1\/products\/([^/]+)\/benefits$/.exec(path))) {
      const product = state.products.find((p) => p.id === m[1]);
      if (!product) return send(404, { error: "ResourceNotFound" });
      product.benefits = (body.benefits ?? []).map((/** @type {string} */ b) => ({ id: b }));
      return send(200, product);
    }
    if (req.method === "GET" && path === "/v1/subscriptions/") return page(state.subscriptions);
    if (req.method === "POST" && path === "/v1/checkouts/") {
      if (!Array.isArray(body?.products) || body.products.length === 0) return send(422, { detail: [{ msg: "products is required" }] });
      const id = randomUUID();
      state.checkouts.push({ id, body });
      return send(201, { id, url: `${linkOrigin}/checkout/${id}`, expires_at: new Date(clock + 3600_000).toISOString(), status: "open", products: body.products, external_customer_id: body.external_customer_id ?? null, metadata: body.metadata ?? {} });
    }
    if (req.method === "POST" && path === "/v1/customer-sessions/") {
      state.customerSessions.push(body);
      const known = state.subscriptions.some((s) => s.customer.external_id !== null && s.customer.external_id === body?.external_customer_id);
      if (!known) return send(404, { error: "ResourceNotFound", detail: "Customer not found" });
      const token = randomBytes(12).toString("hex");
      return send(201, { id: randomUUID(), token, expires_at: new Date(clock + 3600_000).toISOString(), customer_portal_url: `${linkOrigin}/portal/${token}` });
    }
    if (req.method === "GET" && (path === "/v1/webhooks/endpoints" || path === "/v1/webhooks/endpoints/")) return page(state.endpoints);
    if (req.method === "POST" && (path === "/v1/webhooks/endpoints" || path === "/v1/webhooks/endpoints/")) {
      if (!body?.url || !body.format || !Array.isArray(body.events)) return send(422, { detail: [{ msg: "url, format and events are required" }] });
      return send(201, addEndpoint(body));
    }
    if (req.method === "DELETE" && (m = /^\/v1\/webhooks\/endpoints\/([^/]+)$/.exec(path))) {
      const at = state.endpoints.findIndex((e) => e.id === m[1]);
      if (at === -1) return send(404, { error: "ResourceNotFound" });
      state.endpoints.splice(at, 1);
      return send(204);
    }
    return send(404, { detail: "Not Found (stub)" });
  });

  await new Promise((ok) => server.listen(opts.port ?? 0, "127.0.0.1", () => ok(undefined)));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  linkOrigin = `https://127.0.0.1:${port}`;
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    /** The origin of the checkout and portal links the stub hands out. */
    linkOrigin,
    token,
    state,
    addProduct,
    createSubscription,
    endSubscription,
    addEndpoint,
    deliver,
    /** Holds every answer `ms` milliseconds from now on; 0 answers at once again. @param {number} ms */
    slow: (ms) => {
      slowMs = ms;
    },
    close: () =>
      new Promise((ok) => {
        server.closeAllConnections();
        server.close(() => ok(undefined));
      }),
  };
}

if (import.meta.filename === process.argv[1]) {
  const { values } = parseArgs({ options: { port: { type: "string" }, token: { type: "string" }, "slow-ms": { type: "string" } } });
  const stub = await startPolarStub({ port: Number(values.port ?? 8791), token: values.token });
  if (values["slow-ms"]) stub.slow(Number(values["slow-ms"]));
  console.log(`polar stub listening on ${stub.base}, token ${stub.token}`);
}
