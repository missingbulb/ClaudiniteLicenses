import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { startPolarStub } from "../polar-stub.mjs";
import { POLAR_VERSION, readPlans, syncProducts } from "../polar-products.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const plans = readPlans();
let stub: Awaited<ReturnType<typeof startPolarStub>>;

afterEach(async () => stub?.close());

const active = () => stub.state.products.filter((p) => !p.is_archived);
const managed = () => active().filter((p) => p.metadata.managed_by === "claudinite-licenses");
const sync = (apply: boolean, p = plans) => syncProducts({ base: stub.base, token: stub.token, plans: p, apply });
const seatPrice = (cents: number) => ({ amount_type: "seat_based", price_currency: "usd", seat_tiers: { seat_tier_type: "volume", tiers: [{ min_seats: 1, price_per_seat: cents }] } });

describe("billing/plans.json", () => {
  it("prices each plan per seat, monthly and yearly, a year being ten months", () => {
    expect(plans.plans.map((p) => p.id)).toEqual(["private-repo", "personal", "organization"]);
    expect(plans.plans.map((p) => p.price_per_seat.month)).toEqual([200, 1900, 9900]);
    for (const p of plans.plans) expect(p.price_per_seat.year, p.id).toBe(p.price_per_seat.month * 10);
  });
});

describe("tools/polar-products.mjs", () => {
  it("from an empty organization, creates a seat-based product per plan and interval, with no benefits", async () => {
    stub = await startPolarStub();
    const result = await sync(true);
    expect(stub.state.writes.filter((w) => w.method === "POST" && w.path === "/v1/products/")).toHaveLength(6);
    const got = managed().map((p) => ({
      name: p.name,
      interval: p.recurring_interval,
      metadata: p.metadata,
      benefits: p.benefits,
      tiers: p.prices.map((x) => [x.amount_type, x.price_currency, x.seat_tiers.seat_tier_type, x.seat_tiers.tiers]),
    }));
    const tier = (cents: number) => [["seat_based", "usd", "volume", [{ min_seats: 1, max_seats: null, price_per_seat: cents }]]];
    const meta = (plan: string, interval: string) => ({ claudinite_plan: plan, claudinite_interval: interval, managed_by: "claudinite-licenses" });
    expect(got).toEqual([
      { name: "Claudinite Private repo (monthly)", interval: "month", metadata: meta("private-repo", "month"), benefits: [], tiers: tier(200) },
      { name: "Claudinite Private repo (yearly)", interval: "year", metadata: meta("private-repo", "year"), benefits: [], tiers: tier(2000) },
      { name: "Claudinite Personal (monthly)", interval: "month", metadata: meta("personal", "month"), benefits: [], tiers: tier(1900) },
      { name: "Claudinite Personal (yearly)", interval: "year", metadata: meta("personal", "year"), benefits: [], tiers: tier(19000) },
      { name: "Claudinite Organization (monthly)", interval: "month", metadata: meta("organization", "month"), benefits: [], tiers: tier(9900) },
      { name: "Claudinite Organization (yearly)", interval: "year", metadata: meta("organization", "year"), benefits: [], tiers: tier(99000) },
    ]);
    expect(result.products.map((p) => [p.product_id, p.price_id])).toEqual(managed().map((p) => [p.id, p.prices[0]!.id]));
    expect(result.versionServed).toBe(POLAR_VERSION);
  });

  it("turns on seat management in the customer portal, keeping the other portal settings", async () => {
    stub = await startPolarStub();
    await sync(true);
    expect(stub.state.organization.customer_portal_settings).toEqual({ usage: { show: true }, subscription: { update_seats: true, update_plan: true }, customer: { allow_email_change: true } });
  });

  it("notes, and changes nothing there, when the organization exposes no customer portal settings", async () => {
    stub = await startPolarStub({ portalSettings: null });
    const result = await sync(true);
    expect(stub.state.writes.some((w) => w.path.startsWith("/v1/organizations/"))).toBe(false);
    expect(result.notes.join("\n")).toMatch(/seat management/i);
  });

  it("archives every product it did not create, never deleting one, and leaves archived ones alone", async () => {
    stub = await startPolarStub();
    const handMade = [
      stub.addProduct({ name: "Claudinite Personal", prices: [seatPrice(1900)] }),
      stub.addProduct({ name: "Pro", recurring_interval: "year", metadata: { claudinite_plan: "personal" } }),
      stub.addProduct({ name: "Ebook", recurring_interval: null }),
    ];
    const old = stub.addProduct({ name: "Old", is_archived: true });
    await sync(true);
    for (const p of handMade) expect(p.is_archived, p.name).toBe(true);
    expect(stub.state.writes.some((w) => w.method === "DELETE")).toBe(false);
    expect(stub.state.writes.some((w) => w.path === `/v1/products/${old.id}`)).toBe(false);
    expect(active()).toHaveLength(6);
  });

  it("a second run changes nothing", async () => {
    stub = await startPolarStub();
    stub.addProduct({ name: "Hand-made" });
    const first = await sync(true);
    const writes = stub.state.writes.length;
    const second = await sync(true);
    expect(second.actions).toEqual([]);
    expect(stub.state.writes).toHaveLength(writes);
    expect(second.products).toEqual(first.products);
  });

  it("on a price change, gives the product a new price and archives the old one, keeping the product", async () => {
    stub = await startPolarStub();
    const first = await sync(true);
    const raised = structuredClone(plans);
    raised.plans[1]!.price_per_seat = { month: 2500, year: 25000 };
    const before = stub.state.writes.length;
    const changed = await sync(true, raised);
    const writes = stub.state.writes.slice(before);
    expect(writes.map((w) => `${w.method} ${w.path}`).sort()).toEqual([`PATCH /v1/products/${first.products[2]!.product_id}`, `PATCH /v1/products/${first.products[3]!.product_id}`].sort());
    expect(writes.map((w) => w.body)).toEqual([{ prices: [seatPrice(2500)] }, { prices: [seatPrice(25000)] }]);
    const personal = changed.products.filter((p) => p.plan === "personal");
    expect(personal.map((p) => p.product_id)).toEqual([first.products[2]!.product_id, first.products[3]!.product_id]);
    expect(personal.map((p) => p.price_id)).not.toContain(first.products[2]!.price_id);
    expect(stub.state.archivedPrices.map((p) => p.id).sort()).toEqual([first.products[2]!.price_id, first.products[3]!.price_id].sort());
    expect(managed()).toHaveLength(6);
    expect((await sync(true, raised)).actions).toEqual([]);
  });

  it("repairs a managed product's name, metadata and benefits in place", async () => {
    stub = await startPolarStub();
    const first = await sync(true);
    const p = stub.state.products.find((x) => x.id === first.products[0]!.product_id)!;
    p.name = "Renamed by hand";
    p.metadata = { ...p.metadata, extra: "x" };
    p.benefits = [{ id: "benefit-1" }];
    const before = stub.state.writes.length;
    await sync(true);
    expect(stub.state.writes.slice(before).map((w) => `${w.method} ${w.path} ${JSON.stringify(w.body)}`)).toEqual([
      `PATCH /v1/products/${p.id} ${JSON.stringify({ name: "Claudinite Private repo (monthly)", metadata: { claudinite_plan: "private-repo", claudinite_interval: "month", managed_by: "claudinite-licenses" } })}`,
      `POST /v1/products/${p.id}/benefits {"benefits":[]}`,
    ]);
  });

  it("keeps the oldest of two managed products for one plan and interval, archiving the other", async () => {
    stub = await startPolarStub();
    const first = await sync(true);
    const dup = stub.addProduct({ name: "Claudinite Personal (monthly)", metadata: { claudinite_plan: "personal", claudinite_interval: "month", managed_by: "claudinite-licenses" }, prices: [seatPrice(1900)] });
    const again = await sync(true);
    expect(dup.is_archived).toBe(true);
    expect(again.products).toEqual(first.products);
  });

  it("without apply, prints the plan and writes nothing", async () => {
    stub = await startPolarStub();
    stub.addProduct({ name: "Hand-made" });
    const result = await sync(false);
    expect(stub.state.writes).toEqual([]);
    expect(result.actions.map((a) => a.kind).sort()).toEqual(["archive", "create", "create", "create", "create", "create", "create", "portal-seats"]);
    expect(result.products.every((p) => p.product_id === null)).toBe(true);
  });

  it("refuses a token for an organization other than the one billing/plans.json names", async () => {
    stub = await startPolarStub({ organizationName: "Someone Else" });
    await expect(sync(true)).rejects.toThrow(/Someone Else.*MissingBulb/);
    expect(stub.state.writes).toEqual([]);
  });
});

describe("polar-products.yml", () => {
  const wf = parse(readFileSync(join(ROOT, ".github/workflows/polar-products.yml"), "utf8"));
  type Step = { uses?: string; run?: string; env?: Record<string, string> };
  const steps = wf.jobs.products.steps as Step[];
  const step = steps.find((s) => s.run?.includes("polar-products.mjs"))!;

  // Evaluates a step's `${{ }}` env values the way Actions would, for the operators and the
  // property and index access these use; an unset secret reads as the empty string.
  function resolveEnv(ctx: { inputs: Record<string, unknown>; secrets: Record<string, string> }) {
    const scopes = { inputs: new Proxy(ctx.inputs, { get: (t, p) => t[String(p)] ?? "" }), secrets: new Proxy(ctx.secrets, { get: (t, p) => t[String(p)] ?? "" }) };
    return Object.fromEntries(
      Object.entries(step.env ?? {}).map(([k, v]) => {
        const m = /^\$\{\{(.*)\}\}$/s.exec(String(v));
        if (!m) return [k, String(v)];
        const value = new Function("inputs", "secrets", `return (${m[1]!.replace(/==/g, "===")});`)(scopes.inputs, scopes.secrets);
        return [k, value === undefined || value === null ? "" : String(value)];
      }),
    );
  }

  // Asynchronous, since the stub answering the step's requests runs in this process.
  async function runStep(inputs: Record<string, unknown>, secrets: Record<string, string>) {
    const summary = join(mkdtempSync(join(tmpdir(), "acme-summary-")), "summary.md");
    const child = spawn("bash", ["-e", "-c", step.run!], {
      cwd: ROOT,
      env: { PATH: process.env.PATH!, GITHUB_STEP_SUMMARY: summary, POLAR_API_BASE: stub.base, ...resolveEnv({ inputs, secrets }) },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const status: number | null = await new Promise((ok) => child.on("close", ok));
    return { status, stdout, stderr, summary: existsSync(summary) ? readFileSync(summary, "utf8") : "" };
  }

  it("is dispatch-only, with an env choice and an apply switch off by default, reading contents only", () => {
    expect(Object.keys(wf.on)).toEqual(["workflow_dispatch"]);
    expect(wf.on.workflow_dispatch.inputs.env.options).toEqual(["sandbox", "production"]);
    expect(wf.on.workflow_dispatch.inputs.apply).toMatchObject({ type: "boolean", default: false });
    expect(wf.permissions).toEqual({ contents: "read" });
  });

  it("pins its actions by the SHAs the other workflows use", () => {
    const ci = parse(readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8"));
    const pinned = new Set((ci.jobs.verify.steps as Step[]).filter((s) => s.uses).map((s) => s.uses));
    const uses = steps.filter((s) => s.uses).map((s) => s.uses);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(pinned, u).toContain(u);
  });

  for (const [env, secret, other] of [
    ["sandbox", "POLAR_SANDBOX_TOKEN", "POLAR_TOKEN"],
    ["production", "POLAR_TOKEN", "POLAR_SANDBOX_TOKEN"],
  ] as const) {
    it(`hands the tool ${secret} for ${env}, and fails when it is unset`, async () => {
      stub = await startPolarStub({ token: `token-of-${secret}` });
      const secrets = { [secret]: `token-of-${secret}`, [other]: `token-of-${other}` };
      const dry = await runStep({ env, apply: false }, secrets);
      expect(dry.status, dry.stderr).toBe(0);
      expect(stub.state.writes).toEqual([]);
      const applied = await runStep({ env, apply: true }, secrets);
      expect(applied.status, applied.stderr).toBe(0);
      expect(stub.state.products.filter((p) => !p.is_archived)).toHaveLength(6);
      for (const p of stub.state.products) {
        expect(applied.summary).toContain(p.id);
        expect(applied.summary).toContain(p.prices[0]!.id);
      }
      const missing = await runStep({ env, apply: true }, { [other]: `token-of-${other}` });
      expect(missing.status).not.toBe(0);
      expect(missing.stdout + missing.stderr).toContain(secret);
    });
  }
});
