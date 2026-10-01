import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LINK_DEADLINE_MS } from "../src/links.ts";
import { resetJwksCache } from "../src/oidc.ts";
import { actionsClaims, call, env, freshDatabase, githubRepo, HEAD, NONCE, nowS, oidcIssuer, resetWorld, seedRepo, sentIncidents, sentMessages, world } from "./helpers.ts";

beforeEach(async () => {
  await freshDatabase();
  resetWorld();
  resetJwksCache();
});

afterEach(() => vi.restoreAllMocks());

const desktop = (e = env()) =>
  call("/v1/session-key", { method: "POST", headers: { Authorization: "Bearer ghu_acme", "Content-Type": "application/json" }, body: JSON.stringify({ repo: "acme-user/acme-repo", nonce: NONCE, engine_version: "1.1.0" }) }, e);

const privateRepo = () => {
  world.repo = () => Response.json(githubRepo({ private: true, visibility: "private" }));
};

const markerLines = (marker: string) => world.logs.filter((l) => l.includes(`"marker":"${marker}"`));

describe("incidents on the writes queue", () => {
  it("queues one usage and one d1-unreadable incident naming the path for a fail-open session key", async () => {
    privateRepo();
    const res = await desktop(env({ brokenDb: true }));
    expect(await res.json()).toMatchObject({ state: "unverified" });
    expect(sentMessages().map((m) => m.kind).sort()).toEqual(["incident", "usage"]);
    expect(sentIncidents()).toEqual([{ v: 1, kind: "incident", at: expect.any(Number), marker: "d1-unreadable", detail: "desktop" }]);
    expect(Math.abs((sentIncidents()[0]!.at as number) - nowS())).toBeLessThan(5);
    expect(markerLines("d1-unreadable")).toHaveLength(1);
  });

  it("queues d1-unreadable from the web path too, naming it", async () => {
    const res = await call(
      "/webhook",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-GitHub-Event": "repository_dispatch" },
        body: JSON.stringify({
          action: "claudinite-key",
          repository: { id: 1001, name: "acme-repo", full_name: "acme-user/acme-repo", private: false, owner: { id: 2002, login: "acme-user", type: "User" } },
          installation: { id: 5005 },
          sender: { id: 3003, login: "acme-dev", type: "User" },
          client_payload: { nonce: NONCE, engine_version: "1.1.0", head: HEAD },
        }),
      },
      env({ brokenDb: true }),
    );
    expect(res.status).toBe(201);
    expect(sentIncidents()).toMatchObject([{ marker: "d1-unreadable", detail: "web" }]);
  });

  it("queues polar-unreachable naming the call when Polar does not answer in time", async () => {
    await seedRepo({ visibility: "private" });
    privateRepo();
    world.polarCheckout = () => Response.json({ detail: "boom" }, { status: 500 });
    await desktop();
    expect(sentIncidents()).toEqual([{ v: 1, kind: "incident", at: expect.any(Number), marker: "polar-unreachable", detail: "checkout" }]);
  });

  it("queues polar-unreachable when Polar is unconfigured and a key wants a link", async () => {
    await seedRepo({ visibility: "private" });
    privateRepo();
    await desktop(env({ POLAR_ACCESS_TOKEN: undefined }));
    expect(sentIncidents()).toMatchObject([{ marker: "polar-unreachable", detail: "unconfigured" }]);
  });

  it("queues app-not-installed naming the path for a desktop request for a repo with no row", async () => {
    const res = await desktop();
    expect(await res.json()).toEqual({ refused: "app-not-installed" });
    expect(sentIncidents()).toEqual([{ v: 1, kind: "incident", at: expect.any(Number), marker: "app-not-installed", detail: "desktop" }]);
  });

  it("queues app-not-installed and d1-unreadable from the Actions path", async () => {
    const issuer = await oidcIssuer();
    world.jwks = () => Response.json({ keys: [issuer.jwk] });
    const ask = async (e = env()) => call("/v1/actions-key", { method: "POST", headers: { Authorization: `Bearer ${await issuer.sign(actionsClaims())}` }, body: "{}" }, e);
    expect((await ask()).status).toBe(403);
    expect(sentIncidents()).toMatchObject([{ marker: "app-not-installed", detail: "actions" }]);
    resetWorld();
    world.jwks = () => Response.json({ keys: [issuer.jwk] });
    expect((await ask(env({ brokenDb: true }))).status).toBe(503);
    expect(sentIncidents()).toMatchObject([{ marker: "d1-unreadable", detail: "actions" }]);
  });

  it("queues no incident for a plain ok key", async () => {
    await seedRepo();
    expect((await desktop()).status).toBe(200);
    expect(sentIncidents()).toEqual([]);
  });

  it("still logs the line and throws nothing with the queue unbound", async () => {
    privateRepo();
    const res = await desktop(env({ brokenDb: true, WRITES: undefined }));
    expect(res.status).toBe(200);
    expect(markerLines("d1-unreadable")).toHaveLength(1);
    expect(world.sent).toEqual([]);
  });

  it("queues secondary-rate-limit naming the call when GitHub refuses the check run for it", async () => {
    await seedRepo();
    vi.mocked(globalThis.fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new Request(input, init).url;
      if (url.endsWith("/access_tokens")) return Response.json({ token: "ghs_acme" }, { status: 201 });
      return Response.json({ message: "You have exceeded a secondary rate limit." }, { status: 403, headers: { "retry-after": "60" } });
    });
    const res = await call(
      "/webhook",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-GitHub-Event": "repository_dispatch" },
        body: JSON.stringify({
          action: "claudinite-key",
          repository: { id: 1001, name: "acme-repo", full_name: "acme-user/acme-repo", private: false, owner: { id: 2002, login: "acme-user", type: "User" } },
          installation: { id: 5005 },
          sender: { id: 3003, login: "acme-dev", type: "User" },
          client_payload: { nonce: NONCE, engine_version: "1.1.0", head: HEAD },
        }),
      },
    );
    expect(res.status).toBe(502);
    expect(sentIncidents()).toMatchObject([{ marker: "secondary-rate-limit" }]);
    expect(typeof sentIncidents()[0]!.detail).toBe("string");
  });
});

describe("the Polar client's own timeout", () => {
  it("aborts a Polar request the 3-second deadline abandoned", async () => {
    await seedRepo({ visibility: "private" });
    privateRepo();
    const realSetTimeout = globalThis.setTimeout;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      world.polarCheckout = () => new Promise<Response>(() => {});
      let done = false;
      const answered = desktop().finally(() => (done = true));
      for (let i = 0; i < 200 && !done; i++) {
        await vi.advanceTimersByTimeAsync(250);
        await new Promise((ok) => realSetTimeout(ok, 5));
      }
      expect((await answered).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
    const checkout = world.calls.findIndex((c) => c.url.endsWith("/v1/checkouts/"));
    const polarCalls = world.calls.filter((c) => c.url.startsWith("https://polar-api.test"));
    const signal = world.polarSignals[polarCalls.findIndex((c) => c === world.calls[checkout])];
    expect(signal?.aborted).toBe(true);
    expect(LINK_DEADLINE_MS).toBe(3000);
  });
});
