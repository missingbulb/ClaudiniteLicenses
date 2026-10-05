import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetJwksCache } from "../src/oidc.ts";
import { actionsClaims, call, env, freshDatabase, oidcIssuer, resetWorld, seedRepo, world } from "./helpers.ts";

let issuer: Awaited<ReturnType<typeof oidcIssuer>>;

beforeEach(async () => {
  await freshDatabase();
  resetWorld();
  resetJwksCache();
  issuer = await oidcIssuer();
  world.jwks = () => Response.json({ keys: [issuer.jwk] });
});

afterEach(() => vi.restoreAllMocks());

const ask = async (e = env()) => call("/v1/actions-key", { method: "POST", headers: { Authorization: `Bearer ${await issuer.sign(actionsClaims({ repository_visibility: "private" }))}` }, body: "{}" }, e);

describe("the writes producer", () => {
  it("sends nothing for an issued key, whatever the repo's visibility", async () => {
    await seedRepo({ visibility: "private" });
    expect((await ask()).status).toBe(200);
    expect(world.sent).toEqual([]);
    expect(world.waited).toEqual([]);
  });

  it("sends an incident inside waitUntil, and still answers and logs queue-send-failed when sendBatch throws", async () => {
    world.send = async () => {
      throw new Error("acme queue outage");
    };
    const res = await ask();
    expect(res.status).toBe(403);
    expect(world.waited).toHaveLength(1);
    expect(world.logs.some((l) => l.includes('"marker":"queue-send-failed"'))).toBe(true);
  });
});
