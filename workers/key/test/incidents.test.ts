import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetJwksCache } from "../src/oidc.ts";
import { LINK_DEADLINE_MS } from "../src/links.ts";
import { actionsClaims, call, env, freshDatabase, nowS, oidcIssuer, polarCalls, resetWorld, seedRepo, seedSubscription, sentIncidents, world } from "./helpers.ts";

let issuer: Awaited<ReturnType<typeof oidcIssuer>>;

beforeEach(async () => {
  await freshDatabase();
  resetWorld();
  resetJwksCache();
  issuer = await oidcIssuer();
  world.jwks = () => Response.json({ keys: [issuer.jwk] });
});

afterEach(() => vi.restoreAllMocks());

const ask = async (e = env()) => call("/v1/actions-key", { method: "POST", headers: { Authorization: `Bearer ${await issuer.sign(actionsClaims())}` }, body: "{}" }, e);

const markerLines = (marker: string) => world.logs.filter((l) => l.includes(`"marker":"${marker}"`));

describe("incidents on the writes queue", () => {
  it("queues app-not-installed naming the path for a repo with no row", async () => {
    expect((await ask()).status).toBe(403);
    expect(sentIncidents()).toEqual([{ v: 1, kind: "incident", at: expect.any(Number), marker: "app-not-installed", detail: "actions" }]);
    expect(Math.abs((sentIncidents()[0]!.at as number) - nowS())).toBeLessThan(5);
  });

  it("queues d1-unreadable naming the path when D1 cannot be read", async () => {
    expect((await ask(env({ brokenDb: true }))).status).toBe(503);
    expect(sentIncidents()).toMatchObject([{ marker: "d1-unreadable", detail: "actions" }]);
    expect(markerLines("d1-unreadable")).toHaveLength(1);
  });

  it("queues no incident for a plain ok key, with or without a fleet", async () => {
    await seedRepo();
    expect((await ask()).status).toBe(200);
    await seedSubscription({ plan: "personal" });
    expect((await ask()).status).toBe(200);
    expect(sentIncidents()).toEqual([]);
  });

  it("queues polar-unreachable naming the call when Polar refuses the checkout, and still issues the key with no link", async () => {
    await seedRepo();
    world.polarCheckout = () => Response.json({ detail: "boom" }, { status: 500 });
    const res = await ask();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ plan: "public", checkout_url: null, portal_url: null });
    expect(sentIncidents()).toEqual([{ v: 1, kind: "incident", at: expect.any(Number), marker: "polar-unreachable", detail: "checkout" }]);
  });

  it("queues polar-unreachable when Polar is unconfigured and a key wants a link", async () => {
    await seedRepo();
    expect((await ask(env({ POLAR_ACCESS_TOKEN: undefined }))).status).toBe(200);
    expect(sentIncidents()).toMatchObject([{ marker: "polar-unreachable", detail: "unconfigured" }]);
  });

  it("still logs the line and throws nothing with the queue unbound", async () => {
    const res = await ask(env({ brokenDb: true, WRITES: undefined }));
    expect(res.status).toBe(503);
    expect(markerLines("d1-unreadable")).toHaveLength(1);
    expect(world.sent).toEqual([]);
  });
});

describe("the Polar client's own timeout", () => {
  it("answers within the 3-second deadline and aborts the Polar request it abandoned", async () => {
    await seedRepo();
    const realSetTimeout = globalThis.setTimeout;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let res: Response;
    try {
      world.polarCheckout = () => new Promise<Response>(() => {});
      let done = false;
      const answered = ask().finally(() => (done = true));
      for (let i = 0; i < 200 && !done; i++) {
        await vi.advanceTimersByTimeAsync(250);
        await new Promise((ok) => realSetTimeout(ok, 5));
      }
      res = await answered;
    } finally {
      vi.useRealTimers();
    }
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ plan: "public", checkout_url: null });
    const checkout = polarCalls().findIndex((c) => c.url.endsWith("/v1/checkouts/"));
    expect(world.polarSignals[checkout]?.aborted).toBe(true);
    expect(sentIncidents()).toMatchObject([{ marker: "polar-unreachable", detail: "checkout" }]);
    expect(LINK_DEADLINE_MS).toBe(3000);
  });
});
