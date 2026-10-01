#!/usr/bin/env node
// Makes the Polar organization sell exactly the plans billing/plans.json lists: one seat-based
// subscription product per plan and billing interval, since a Polar product carries a single
// interval; every other unarchived product is archived, never deleted. It also turns on seat
// management in the customer portal. Without --apply it only prints what it would change.
// Reads POLAR_ACCESS_TOKEN, an organization access token for the --env's organization, and
// POLAR_API_BASE when set, in place of the --env's API address.
//
//   node tools/polar-products.mjs --env sandbox|production [--apply] [--summary <file>]
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

export const POLAR_VERSION = "2026-10";
export const API_BASES = { sandbox: "https://sandbox-api.polar.sh", production: "https://api.polar.sh" };
export const MANAGED_BY = "claudinite-licenses";
const INTERVALS = /** @type {const} */ (["month", "year"]);
const INTERVAL_WORD = { month: "monthly", year: "yearly" };

/**
 * @typedef {"month" | "year"} Interval
 * @typedef {{ id: string, name: string, price_per_seat: Record<Interval, number> }} Plan
 * @typedef {{ polar_organization: string, currency: string, plans: Plan[] }} Plans
 * @typedef {{ amount_type: "seat_based", price_currency: string, seat_tiers: { seat_tier_type: "volume", tiers: { min_seats: number, price_per_seat: number }[] } }} SeatPriceCreate
 * @typedef {{ plan: string, interval: Interval, name: string, metadata: Record<string, string>, price: SeatPriceCreate }} Desired
 * @typedef {{ id: string, created_at: string, name: string, recurring_interval: string | null, recurring_interval_count: number | null, is_archived: boolean, metadata: Record<string, unknown>, prices: any[], benefits: { id: string }[] }} Product
 * @typedef {{ kind: "create", desired: Desired, description: string }
 *   | { kind: "update", product: Product, desired: Desired, patch: Record<string, unknown>, description: string }
 *   | { kind: "clear-benefits", product: Product, description: string }
 *   | { kind: "archive", product: Product, description: string }
 *   | { kind: "portal-seats", settings: any, description: string }} Action
 * @typedef {{ plan: string, interval: Interval, name: string, price_per_seat: number, product_id: string | null, price_id: string | null }} Result
 */

/** @param {string} [file] @returns {Plans} */
export function readPlans(file = join(import.meta.dirname, "../billing/plans.json")) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** @param {Plans} plans @returns {Desired[]} */
export function desiredProducts(plans) {
  return plans.plans.flatMap((plan) =>
    INTERVALS.map((interval) => ({
      plan: plan.id,
      interval,
      name: `${plan.name} (${INTERVAL_WORD[interval]})`,
      metadata: { claudinite_plan: plan.id, claudinite_interval: interval, managed_by: MANAGED_BY },
      price: {
        amount_type: /** @type {const} */ ("seat_based"),
        price_currency: plans.currency,
        seat_tiers: { seat_tier_type: /** @type {const} */ ("volume"), tiers: [{ min_seats: 1, price_per_seat: plan.price_per_seat[interval] }] },
      },
    })),
  );
}

/** @param {string} base @param {string} token */
function polarClient(base, token) {
  /** @type {string | null} */
  let versionServed = null;
  /**
   * @param {string} method @param {string} path @param {unknown} [body]
   * @returns {Promise<any>}
   */
  async function call(method, path, body) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Polar-Version": POLAR_VERSION,
          "User-Agent": "claudinite-licenses-tools",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status === 429 && attempt < 3) {
        await new Promise((ok) => setTimeout(ok, 1000 * Number(res.headers.get("retry-after") ?? 1)));
        continue;
      }
      versionServed ??= res.headers.get("polar-version");
      const text = await res.text();
      if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}: ${text}`);
      return text ? JSON.parse(text) : null;
    }
  }
  /** @param {string} path */
  async function listAll(path) {
    const items = [];
    for (let page = 1; ; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const data = await call("GET", `${path}${sep}page=${page}&limit=100`);
      items.push(...data.items);
      if (page >= data.pagination.max_page) return items;
    }
  }
  return { call, listAll, versionServed: () => versionServed };
}

/** @param {number} cents */
const dollars = (cents) => `$${(cents / 100).toFixed(2)}`;

/** @param {Product} p */
const activePrices = (p) => (p.prices ?? []).filter((x) => !x.is_archived);

/** @param {any} price @param {SeatPriceCreate} want */
function samePrice(price, want) {
  if (price.amount_type !== "seat_based" || price.price_currency !== want.price_currency) return false;
  const tiers = price.seat_tiers?.tiers ?? [];
  const [w] = want.seat_tiers.tiers;
  return (price.seat_tiers?.seat_tier_type ?? "volume") === "volume" && tiers.length === 1 && tiers[0].min_seats === w?.min_seats && (tiers[0].max_seats ?? null) === null && tiers[0].price_per_seat === w?.price_per_seat;
}

/** @param {Record<string, unknown>} a @param {Record<string, unknown>} b */
function sameMetadata(a, b) {
  const ka = Object.keys(a ?? {});
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

/** @param {any} price */
function describePrice(price) {
  const t = price?.seat_tiers?.tiers;
  return price?.amount_type === "seat_based" && t?.length === 1 ? `${dollars(t[0].price_per_seat)} per seat` : `a ${price?.amount_type ?? "missing"} price`;
}

/**
 * Plans the changes that make Polar match `plans`, and with `apply` makes them.
 * @param {{ base: string, token: string, plans: Plans, apply: boolean }} opts
 */
export async function syncProducts({ base, token, plans, apply }) {
  const polar = polarClient(base, token);
  const orgs = await polar.listAll("/v1/organizations/");
  if (orgs.length !== 1) throw new Error(`the token reaches ${orgs.length} organizations, not one: ${orgs.map((o) => o.name).join(", ")}`);
  const org = orgs[0];
  if (org.name !== plans.polar_organization) throw new Error(`the token belongs to organization ${org.name}, not ${plans.polar_organization}`);

  /** @type {Product[]} */
  const products = (await polar.listAll("/v1/products/?is_archived=false")).sort((a, b) => a.created_at.localeCompare(b.created_at));
  /** @type {Action[]} */
  const actions = [];
  /** @type {Result[]} */
  const results = [];
  /** @type {string[]} */
  const notes = [];
  const kept = new Set();

  for (const d of desiredProducts(plans)) {
    const current = products.find(
      (p) => !kept.has(p.id) && p.metadata?.managed_by === MANAGED_BY && p.metadata?.claudinite_plan === d.plan && p.metadata?.claudinite_interval === d.interval && p.recurring_interval === d.interval && p.recurring_interval_count === 1,
    );
    const pricePerSeat = d.price.seat_tiers.tiers[0]?.price_per_seat ?? 0;
    const result = { plan: d.plan, interval: d.interval, name: d.name, price_per_seat: pricePerSeat, product_id: current?.id ?? null, price_id: null };
    results.push(result);
    if (!current) {
      actions.push({ kind: "create", desired: d, description: `create "${d.name}": seat-based, ${dollars(pricePerSeat)} per seat per ${d.interval}` });
      continue;
    }
    kept.add(current.id);
    const prices = activePrices(current);
    /** @type {Record<string, unknown>} */
    const patch = {};
    const changes = [];
    if (current.name !== d.name) {
      patch.name = d.name;
      changes.push(`rename from "${current.name}"`);
    }
    if (!sameMetadata(current.metadata, d.metadata)) {
      patch.metadata = d.metadata;
      changes.push("reset metadata");
    }
    if (prices.length === 1 && samePrice(prices[0], d.price)) result.price_id = prices[0].id;
    else {
      patch.prices = [d.price];
      changes.push(`replace ${prices.map(describePrice).join(" and ") || "no price"} with ${dollars(pricePerSeat)} per seat (Polar archives the old price; existing subscribers keep it)`);
    }
    if (changes.length) actions.push({ kind: "update", product: current, desired: d, patch, description: `update ${current.id} "${d.name}": ${changes.join("; ")}` });
    if (current.benefits?.length) actions.push({ kind: "clear-benefits", product: current, description: `remove ${current.benefits.length} benefit(s) from ${current.id} "${d.name}"` });
  }
  for (const p of products) if (!kept.has(p.id)) actions.push({ kind: "archive", product: p, description: `archive ${p.id} "${p.name}"` });

  const portal = org.customer_portal_settings;
  if (!portal?.subscription) notes.push("Polar's API exposes no customer portal settings for this organization: turn on subscription seat management in the dashboard, under Settings, Customer portal.");
  else if (portal.subscription.update_seats !== true) actions.push({ kind: "portal-seats", settings: portal, description: "turn on subscription seat management in the customer portal" });

  if (apply) {
    for (const a of actions) {
      const r = a.kind === "create" || a.kind === "update" ? results.find((x) => x.plan === a.desired.plan && x.interval === a.desired.interval) : undefined;
      if (a.kind === "create") {
        const made = await polar.call("POST", "/v1/products/", { name: a.desired.name, recurring_interval: a.desired.interval, recurring_interval_count: 1, metadata: a.desired.metadata, prices: [a.desired.price] });
        Object.assign(/** @type {Result} */ (r), { product_id: made.id, price_id: activePrices(made)[0]?.id ?? null });
      } else if (a.kind === "update") {
        const updated = await polar.call("PATCH", `/v1/products/${a.product.id}`, a.patch);
        /** @type {Result} */ (r).price_id = activePrices(updated)[0]?.id ?? null;
      } else if (a.kind === "clear-benefits") {
        await polar.call("POST", `/v1/products/${a.product.id}/benefits`, { benefits: [] });
      } else if (a.kind === "archive") {
        await polar.call("PATCH", `/v1/products/${a.product.id}`, { is_archived: true });
      } else if (a.kind === "portal-seats") {
        await polar.call("PATCH", `/v1/organizations/${org.id}`, { customer_portal_settings: { ...a.settings, subscription: { ...a.settings.subscription, update_seats: true } } });
      }
    }
  }
  return { organization: { id: org.id, name: org.name }, versionServed: polar.versionServed(), actions, products: results, notes };
}

/** @param {Awaited<ReturnType<typeof syncProducts>>} result @param {{ env: string, apply: boolean }} run */
export function summaryMarkdown(result, run) {
  const verb = run.apply ? (result.actions.length ? "Applied" : "Nothing to change") : result.actions.length ? "Planned (dry run)" : "Nothing to change";
  const lines = [`## Polar products, ${run.env}`, "", `${verb} for organization ${result.organization.name} (${result.organization.id}), Polar-Version ${result.versionServed ?? "unknown"}.`, ""];
  if (result.actions.length) lines.push(...result.actions.map((a) => `- ${a.description}`), "");
  lines.push(...result.notes.map((n) => `> ${n}`), ...(result.notes.length ? [""] : []));
  lines.push("| Plan | Interval | Product | Per seat | Product id | Price id |", "| --- | --- | --- | --- | --- | --- |");
  const pending = run.apply ? "missing" : "on apply";
  for (const p of result.products) lines.push(`| ${p.plan} | ${p.interval} | ${p.name} | ${dollars(p.price_per_seat)} | ${p.product_id ?? `(${pending})`} | ${p.price_id ?? `(${pending})`} |`);
  return `${lines.join("\n")}\n`;
}

if (import.meta.filename === process.argv[1]) {
  // Node's fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY=1 is set at startup.
  if (process.env.HTTPS_PROXY && process.env.NODE_USE_ENV_PROXY !== "1") {
    const child = spawnSync(process.execPath, process.argv.slice(1), { stdio: "inherit", env: { ...process.env, NODE_USE_ENV_PROXY: "1" } });
    process.exit(child.status ?? 1);
  }
  const { values } = parseArgs({ options: { env: { type: "string" }, apply: { type: "boolean", default: false }, summary: { type: "string" } } });
  const env = values.env;
  const token = process.env.POLAR_ACCESS_TOKEN;
  if ((env !== "sandbox" && env !== "production") || !token) {
    console.error("usage: POLAR_ACCESS_TOKEN=... node tools/polar-products.mjs --env sandbox|production [--apply] [--summary <file>]");
    process.exit(2);
  }
  const apply = Boolean(values.apply);
  syncProducts({ base: process.env.POLAR_API_BASE || API_BASES[env], token, plans: readPlans(), apply }).then(
    (result) => {
      const text = summaryMarkdown(result, { env, apply });
      console.log(text);
      if (!apply && result.actions.length) console.log("Dry run: pass --apply to make these changes.");
      if (values.summary) appendFileSync(values.summary, text);
    },
    (err) => {
      console.error(`polar-products: ${err.message}`);
      process.exit(1);
    },
  );
}
