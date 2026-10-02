import { createExecutionContext, createMessageBatch, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { WRITES_QUEUE } from "../src/writes.ts";
import wranglerConfig from "../wrangler.jsonc?raw";
import { env, fakeGitHub, freshDatabase } from "./github.ts";
import { fakePolar } from "./polar.ts";

const ID = (env as unknown as { CF_VERSION_METADATA: { id: string } }).CF_VERSION_METADATA.id;
const send = (path: string, init?: RequestInit) => worker.fetch(new Request(`https://license.claudinite.com${path}`, init), env, createExecutionContext());
let logs: string[];

beforeEach(async () => {
  await freshDatabase();
  fakeGitHub();
  fakePolar();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("version", () => {
  it("is supplied by the binding the wrangler config declares", () => {
    expect(JSON.parse(wranglerConfig.replace(/^\s*\/\/.*$/gm, "")).version_metadata).toEqual({ binding: "CF_VERSION_METADATA" });
    expect(ID).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("is named on every route's answer, 2xx, 4xx and 5xx alike", async () => {
    await env.DB.prepare("INSERT INTO incidents (marker, at) VALUES ('d1-unreadable', ?)").bind(Math.floor(Date.now() / 1000)).run();
    const answers = [
      await send("/v1/sync/health"),
      await send("/v1/sync/alerts"),
      await send("/v1/sync/polar-webhook", { method: "POST", body: "{}" }),
      await send("/webhook", { method: "POST", body: "{not json" }),
      await send("/elsewhere"),
    ];
    expect(answers.map((r) => r.status)).toEqual([200, 503, 401, 400, 404]);
    expect(answers.map((r) => r.headers.get("X-Claudinite-Version"))).toEqual(answers.map(() => ID));
  });

  it("is the health body's version", async () => {
    const res = await send("/v1/sync/health");
    expect(((await res.json()) as { version: string }).version).toBe(res.headers.get("X-Claudinite-Version"));
  });

  it("is logged once at the start of each scheduled and queue invocation", async () => {
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: new Date(), cron: "47 * * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);
    await worker.queue(createMessageBatch(WRITES_QUEUE, []), env, createExecutionContext());
    const versionLines = logs.filter((l) => l.includes('"version"')).map((l) => JSON.parse(l));
    expect(versionLines).toEqual([
      { invocation: "scheduled", cron: "47 * * * *", version: ID },
      { invocation: "queue", messages: 0, version: ID },
    ]);
    expect(JSON.parse(logs[0]!)).toEqual(versionLines[0]);
  });
});
