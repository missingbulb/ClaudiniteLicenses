import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetJwksCache } from "../src/oidc.ts";
import { actionsClaims, call, env, freshDatabase, nowS, oidcIssuer, resetWorld, seedRepo, sentIncidents, world } from "./helpers.ts";

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

  it("queues no incident for a plain ok key", async () => {
    await seedRepo();
    expect((await ask()).status).toBe(200);
    expect(sentIncidents()).toEqual([]);
  });

  it("still logs the line and throws nothing with the queue unbound", async () => {
    const res = await ask(env({ brokenDb: true, WRITES: undefined }));
    expect(res.status).toBe(503);
    expect(markerLines("d1-unreadable")).toHaveLength(1);
    expect(world.sent).toEqual([]);
  });
});
