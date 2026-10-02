import { afterEach, describe, expect, it } from "vitest";
import { signKey } from "../../packages/signing/src/index.ts";
import { devChain, NOW, payload } from "../../packages/signing/test/chain.ts";
import { startStub } from "../../tools/github-stub.mjs";
import { runSpike, summarize } from "../web-key-roundtrip.mjs";

let stub: Awaited<ReturnType<typeof startStub>> | undefined;
afterEach(async () => {
  await stub?.close();
  stub = undefined;
});

const base = { repo: "acme-user/acme-repo", event: "claudinite-key-public", token: "acme-token", intervalMs: 20, pauseMs: 0 };

describe("summarize", () => {
  it("computes median, p90, max, the over-cut count and dispatch latency over a scripted set", () => {
    const tries = [100, 200, 300, 400, 500, 600, 700, 800, 900, 12000].map((ms, i) => ({ try: i + 1, dispatchStatus: 204, dispatchMs: 10 + i, visibleMs: ms, hasText: true, senderType: "User" }));
    tries.push({ try: 11, dispatchStatus: 403, dispatchMs: 30, visibleMs: null, hasText: false, senderType: null, failure: "dispatch 403" } as never);
    const s = summarize(tries, { cutMs: 10000 });
    expect(s).toMatchObject({ tries: 11, visible: 10, medianMs: 550, p90Ms: 900, maxMs: 12000, overCut: 1, dispatchMedianMs: 15, senderTypes: { User: 10 } });
    expect(s.failures).toEqual([{ try: 11, cause: "dispatch 403" }]);
  });
});

describe("runSpike against the stub", () => {
  it("times each dispatch to its visible check run", async () => {
    stub = await startStub({ dispatchDelays: [100, 200, 300, 400, 1500] });
    const s = await runSpike({ ...base, apiBase: stub.base, tries: 5, cutMs: 1000, maxMs: 5000 });
    expect(s.visible).toBe(5);
    expect(s.overCut).toBe(1);
    expect(s.maxMs).toBeGreaterThanOrEqual(1500);
    expect(s.maxMs).toBeLessThan(1500 + 300);
    expect(s.medianMs).toBeGreaterThanOrEqual(300);
    expect(s.medianMs).toBeLessThan(300 + 300);
    expect(s.senderTypes).toEqual({ User: 5 });
    expect(stub.state.dispatches.map((d: { event_type: string }) => d.event_type)).toEqual(Array(5).fill("claudinite-key-public"));
    expect(new Set(stub.state.dispatches.map((d: { client_payload: { nonce: string } }) => d.client_payload.nonce)).size).toBe(5);
  });

  it("records a check run that never comes as a failure at max-ms", async () => {
    stub = await startStub({ dispatchDelays: [null] });
    const s = await runSpike({ ...base, apiBase: stub.base, tries: 1, cutMs: 100, maxMs: 300 });
    expect(s.visible).toBe(0);
    expect(s.failures).toEqual([{ try: 1, cause: "no check run within 300 ms" }]);
  });

  it("records a refused dispatch without polling", async () => {
    stub = await startStub({ dispatchStatus: 403 });
    const s = await runSpike({ ...base, apiBase: stub.base, tries: 1, cutMs: 100, maxMs: 2000 });
    expect(s.failures).toEqual([{ try: 1, cause: "dispatch 403: Resource not accessible by integration" }]);
    expect(stub.state.requests.filter((r: string) => r.includes("/check-runs"))).toEqual([]);
  });
});

describe("runSpike --verify", () => {
  async function keys() {
    const chain = await devChain();
    const cert = await chain.certify(chain.root, "license");
    const grace = await signKey(chain.issuing.seed, cert, payload({ plan: "private-repo", state: "grace", grace_until: Math.floor(NOW.getTime() / 1000) + 7 * 86400, notice: "overused" }));
    const env = JSON.parse(grace);
    const forged = JSON.parse(await signKey(chain.issuing.seed, cert, payload({ plan: "private-repo", state: "ok" })));
    const tampered = JSON.stringify({ ...env, payload: forged.payload });
    return { roots: [chain.root.publicKey], grace, tampered, kid: JSON.parse(Buffer.from(env.payload, "base64url").toString("utf8")).kid as string };
  }

  it("verifies each visible key against the roots, recording plan, state, notice and the issuing key id; a tampered key is verified: false; a refusal records its summary", async () => {
    const k = await keys();
    stub = await startStub({
      dispatchDelays: [50, 50, 50],
      dispatchOutputs: [
        { title: "Claudinite key", summary: "private-repo key for @acme-user (sender type User), state grace, overused", text: k.grace },
        { title: "Claudinite key", summary: "private-repo key for @acme-user (sender type User), state ok", text: k.tampered },
        { title: "Claudinite key refused", summary: "app-not-installed: the App does not cover this repository" },
      ],
    });
    const s = await runSpike({ ...base, apiBase: stub.base, tries: 3, cutMs: 1000, maxMs: 3000, verify: { roots: k.roots, now: NOW } });
    expect(s.triesDetail.map((t) => ({ verified: t.verified, plan: t.plan, state: t.state, notice: t.notice, kid: t.kid, refusal: t.refusal }))).toEqual([
      { verified: true, plan: "private-repo", state: "grace", notice: "overused", kid: k.kid, refusal: undefined },
      { verified: false, plan: undefined, state: undefined, notice: undefined, kid: undefined, refusal: undefined },
      { verified: undefined, plan: undefined, state: undefined, notice: undefined, kid: undefined, refusal: "app-not-installed: the App does not cover this repository" },
    ]);
    expect(s.triesDetail[1]!.verifyReason).toBe("bad-signature");
    expect(s.verified).toBe(1);
    expect(s.refusals).toBe(1);
    expect(s.seen).toEqual([{ plan: "private-repo", state: "grace", notice: "overused", count: 1 }]);
  });

  it("records nothing about keys without --verify", async () => {
    stub = await startStub({ dispatchDelays: [10] });
    const s = await runSpike({ ...base, apiBase: stub.base, tries: 1, cutMs: 1000, maxMs: 3000 });
    expect(s).not.toHaveProperty("verified");
    expect(s.triesDetail[0]).not.toHaveProperty("verified");
  });
});
