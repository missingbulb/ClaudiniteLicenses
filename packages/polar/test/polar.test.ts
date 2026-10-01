import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { desiredProducts, readPlans } from "../../../tools/polar-products.mjs";
import { startPolarStub } from "../../../tools/polar-stub.mjs";
import {
  createCheckout,
  createCustomerSession,
  ensureWebhookEndpoint,
  listManagedProducts,
  listSubscriptions,
  MANAGED_BY,
  polarClient,
  PolarError,
  POLAR_VERSION,
  signDelivery,
  verifyWebhook,
} from "../src/index.ts";

let stub: Awaited<ReturnType<typeof startPolarStub>>;
const client = () => polarClient({ base: stub.base, token: stub.token, version: POLAR_VERSION });

beforeEach(async () => {
  stub = await startPolarStub();
});

afterEach(async () => {
  await stub.close();
});

function seedManagedProducts() {
  return desiredProducts(readPlans()).map((d: { name: string; metadata: Record<string, string>; interval: string; price: unknown }) =>
    stub.addProduct({ name: d.name, metadata: d.metadata, recurring_interval: d.interval, prices: [d.price] }),
  );
}

describe("polarClient", () => {
  it("sends the token, the pinned Polar-Version and JSON, and names the call and status when Polar refuses", async () => {
    const res = await client().call("GET", "/v1/organizations/");
    expect(res.items).toHaveLength(1);
    const bad = polarClient({ base: stub.base, token: "polar_oat_wrong", version: POLAR_VERSION });
    const err = await bad.call("GET", "/v1/organizations/").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PolarError);
    expect(err).toMatchObject({ status: 401, call: "GET /v1/organizations/" });
  });

  it("gives up after timeoutMs with a PolarError carrying no status", async () => {
    const hanging = polarClient({ base: stub.base, token: stub.token, version: POLAR_VERSION, timeoutMs: 50, fetch: () => new Promise<Response>(() => {}) });
    const err = await hanging.call("GET", "/v1/organizations/").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PolarError);
    expect(err).toMatchObject({ status: null, call: "GET /v1/organizations/" });
    expect(String((err as Error).message)).toMatch(/timed out after 50 ms/);
  });
});

describe("listManagedProducts", () => {
  it("keys the unarchived products we manage by plan and interval, and leaves out the rest", async () => {
    const made = seedManagedProducts();
    stub.addProduct({ name: "Hand-made", metadata: { claudinite_plan: "personal", claudinite_interval: "month" } });
    stub.addProduct({ name: "Archived", metadata: { claudinite_plan: "personal", claudinite_interval: "month", managed_by: MANAGED_BY }, is_archived: true });
    const products = await listManagedProducts(client());
    expect(Object.keys(products).sort()).toEqual(["organization", "personal", "private-repo"]);
    expect(products.personal?.month?.id).toBe(made.find((p) => p.metadata.claudinite_plan === "personal" && p.metadata.claudinite_interval === "month")!.id);
    expect(products["private-repo"]?.year?.metadata.claudinite_interval).toBe("year");
  });
});

describe("createCheckout", () => {
  it("offers both of the plan's products, monthly first, with the owner as external customer id and every metadata key", async () => {
    seedManagedProducts();
    const products = await listManagedProducts(client());
    const out = await createCheckout(client(), { plan: "private-repo", ownerId: 2002, ownerLogin: "acme-user", ownerType: "User", repo: { id: 1001, fullName: "acme-user/acme-repo" } });
    expect(out.url).toMatch(/^https:\/\//);
    expect(typeof out.id).toBe("string");
    expect(typeof out.expires_at).toBe("string");
    const body = stub.state.checkouts.at(-1)!.body;
    expect(body).toEqual({
      products: [products["private-repo"]!.month!.id, products["private-repo"]!.year!.id],
      external_customer_id: "2002",
      metadata: { claudinite_plan: "private-repo", github_owner_id: "2002", github_owner_login: "acme-user", github_owner_type: "User", github_repo_id: "1001", github_repo_full_name: "acme-user/acme-repo" },
    });
  });

  it("names no repo for an owner-wide plan, and refuses a plan with no managed products", async () => {
    seedManagedProducts();
    await createCheckout(client(), { plan: "organization", ownerId: 8008, ownerLogin: "acme-org", ownerType: "Organization", repo: { id: 1001, fullName: "acme-org/acme-repo" } });
    expect(stub.state.checkouts.at(-1)!.body.metadata).toEqual({ claudinite_plan: "organization", github_owner_id: "8008", github_owner_login: "acme-org", github_owner_type: "Organization" });
    await expect(createCheckout(client(), { plan: "internal", ownerId: 1, ownerLogin: "acme", ownerType: "User" })).rejects.toThrow(/no managed products for internal/);
  });
});

describe("createCustomerSession", () => {
  it("returns the portal URL for a customer Polar knows by external id, and null for one it does not", async () => {
    stub.createSubscription({ externalId: "2002", plan: "personal", seats: 5 });
    expect(await createCustomerSession(client(), { ownerId: 2002 })).toMatch(/^https:\/\/.*\/portal\//);
    expect(stub.state.customerSessions.at(-1)).toEqual({ external_customer_id: "2002" });
    expect(await createCustomerSession(client(), { ownerId: 4040 })).toBeNull();
  });
});

describe("listSubscriptions", () => {
  it("walks every page, ended subscriptions included", async () => {
    for (let i = 0; i < 250; i++) stub.createSubscription({ externalId: String(3000 + i), plan: "organization", seats: 1 });
    stub.endSubscription(stub.state.subscriptions[7]!.id, "2026-09-30T00:00:00Z");
    const all = await listSubscriptions(client());
    expect(all).toHaveLength(250);
    expect(stub.state.requests.filter((r) => r.startsWith("GET /v1/subscriptions/"))).toHaveLength(3);
    expect(all.find((s) => s.id === stub.state.subscriptions[7]!.id)).toMatchObject({ status: "canceled", ended_at: "2026-09-30T00:00:00Z" });
  });
});

describe("ensureWebhookEndpoint", () => {
  const url = "https://license.claudinite.com/v1/sync/polar-webhook";
  const events = ["subscription.created", "checkout.created"];

  it("creates a raw 2026-10 endpoint once with its secret, and keeps it on the second call", async () => {
    const first = await ensureWebhookEndpoint(client(), { url, events });
    expect(first.kept).toBe(false);
    expect(first.kept === false && first.secret).toMatch(/^whsec_/);
    expect(stub.state.endpoints).toHaveLength(1);
    expect(stub.state.endpoints[0]).toMatchObject({ url, format: "raw", api_version: "2026-10", events });
    const second = await ensureWebhookEndpoint(client(), { url, events });
    expect(second).toEqual({ id: first.id, kept: true });
    expect(stub.state.endpoints).toHaveLength(1);
  });

  it("replaces an endpoint whose url is listed twice, and one it is asked to rotate", async () => {
    stub.addEndpoint({ url, events });
    stub.addEndpoint({ url, events });
    const other = stub.addEndpoint({ url: "https://elsewhere.test/hook", events });
    const made = await ensureWebhookEndpoint(client(), { url, events });
    expect(made.kept).toBe(false);
    expect(stub.state.endpoints.map((e) => e.id).sort()).toEqual([made.id, other.id].sort());
    const rotated = await ensureWebhookEndpoint(client(), { url, events, rotate: true });
    expect(rotated.kept).toBe(false);
    expect(rotated.id).not.toBe(made.id);
    expect(stub.state.endpoints.map((e) => e.id).sort()).toEqual([rotated.id, other.id].sort());
  });
});

describe("verifyWebhook", () => {
  const now = 1_790_000_000;

  async function delivery(over: { body?: string; timestamp?: number; signature?: string; drop?: string } = {}) {
    const endpoint = stub.addEndpoint({ url: "https://acme.test/hook", events: ["subscription.created"] });
    const body = JSON.stringify({ type: "subscription.created", timestamp: "2026-09-21T00:00:00Z", data: { id: "sub_acme" } });
    const timestamp = over.timestamp ?? now;
    const signature = await signDelivery(endpoint.secret, "msg_acme", timestamp, body);
    const headers = new Headers({ "webhook-id": "msg_acme", "webhook-timestamp": String(timestamp), "webhook-signature": over.signature?.replace("$RIGHT", signature) ?? signature });
    if (over.drop) headers.delete(over.drop);
    return { headers, body: over.body ?? body, secret: endpoint.secret };
  }

  it("accepts a delivery signed with the endpoint's secret and returns the event", async () => {
    const d = await delivery();
    const res = await verifyWebhook(d.headers, d.body, d.secret, now);
    expect(res).toEqual({ ok: true, id: "msg_acme", event: { type: "subscription.created", timestamp: "2026-09-21T00:00:00Z", data: { id: "sub_acme" } } });
  });

  it("accepts a right signature beside a wrong one", async () => {
    const d = await delivery({ signature: "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= $RIGHT" });
    expect((await verifyWebhook(d.headers, d.body, d.secret, now)).ok).toBe(true);
  });

  it("refuses a byte-changed body, a timestamp more than 5 minutes off, and a missing header, naming each", async () => {
    const d = await delivery();
    expect(await verifyWebhook(d.headers, d.body.replace("sub_acme", "sub_acmf"), d.secret, now)).toEqual({ ok: false, reason: "signature-mismatch" });
    const old = await delivery({ timestamp: now - 360 });
    expect(await verifyWebhook(old.headers, old.body, old.secret, now)).toEqual({ ok: false, reason: "timestamp-skew" });
    const ahead = await delivery({ timestamp: now + 360 });
    expect(await verifyWebhook(ahead.headers, ahead.body, ahead.secret, now)).toEqual({ ok: false, reason: "timestamp-skew" });
    const within = await delivery({ timestamp: now - 290 });
    expect((await verifyWebhook(within.headers, within.body, within.secret, now)).ok).toBe(true);
    for (const header of ["webhook-id", "webhook-timestamp", "webhook-signature"]) {
      const missing = await delivery({ drop: header });
      expect(await verifyWebhook(missing.headers, missing.body, missing.secret, now), header).toEqual({ ok: false, reason: "signature-missing" });
    }
    expect(await verifyWebhook(d.headers, d.body, "whsec_" + btoa("another secret entirely"), now)).toEqual({ ok: false, reason: "signature-mismatch" });
  });

  it("verifies a delivery the stub's deliver() posted, signed with that endpoint's secret", async () => {
    const seen: { headers: Headers; body: string }[] = [];
    const { createServer } = await import("node:http");
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c)).on("end", () => {
        seen.push({ headers: new Headers(req.headers as Record<string, string>), body });
        res.statusCode = 204;
        res.end();
      });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    try {
      const { port } = server.address() as { port: number };
      const endpoint = stub.addEndpoint({ url: `http://127.0.0.1:${port}/hook`, events: ["subscription.created"] });
      expect(await stub.deliver("subscription.created", { id: "sub_acme" }, { endpointId: endpoint.id })).toBe(204);
      const got = seen[0]!;
      const t = Number(got.headers.get("webhook-timestamp"));
      expect(await verifyWebhook(got.headers, got.body, endpoint.secret, t)).toMatchObject({ ok: true, event: { type: "subscription.created", data: { id: "sub_acme" } } });
    } finally {
      server.close();
    }
  });
});
