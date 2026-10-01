import { afterEach, describe, expect, it } from "vitest";
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
