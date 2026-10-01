#!/usr/bin/env node
// A local stand-in for the Polar API calls the billing tools make: the token's organization and its
// customer portal settings, and products with their prices and benefits. It answers only requests
// carrying its token and a Polar-Version it knows, and records every write.
//
//   node tools/polar-stub.mjs --port <n> [--token <t>]
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { parseArgs } from "node:util";

export const STUB_VERSIONS = ["2026-04", "2026-10", "2027-01"];

/**
 * @typedef {{ id: string, created_at: string, modified_at: string | null, source: string, amount_type: string, price_currency: string, tax_behavior: string | null, is_archived: boolean, product_id: string, seat_tiers?: any, price_amount?: number }} Price
 * @typedef {{ id: string, created_at: string, modified_at: string | null, name: string, description: string | null, visibility: string, recurring_interval: string | null, recurring_interval_count: number | null, is_recurring: boolean, is_archived: boolean, organization_id: string, metadata: Record<string, unknown>, prices: Price[], benefits: { id: string }[], medias: [], attached_custom_fields: [] }} Product
 * @typedef {{ name?: string, metadata?: Record<string, unknown>, recurring_interval?: string | null, is_archived?: boolean, prices?: any[], benefits?: string[] }} Seed
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
  };

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

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : undefined;
    const url = new URL(req.url ?? "/", "http://stub");
    const path = url.pathname;
    state.requests.push(`${req.method} ${path}${url.search}`);
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
    return send(404, { detail: "Not Found (stub)" });
  });

  await new Promise((ok) => server.listen(opts.port ?? 0, "127.0.0.1", () => ok(undefined)));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    token,
    state,
    addProduct,
    close: () =>
      new Promise((ok) => {
        server.closeAllConnections();
        server.close(() => ok(undefined));
      }),
  };
}

if (import.meta.filename === process.argv[1]) {
  const { values } = parseArgs({ options: { port: { type: "string" }, token: { type: "string" } } });
  const stub = await startPolarStub({ port: Number(values.port ?? 8791), token: values.token });
  console.log(`polar stub listening on ${stub.base}, token ${stub.token}`);
}
