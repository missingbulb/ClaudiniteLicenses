import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isWriteMessage } from "../../packages/licensing/src/index.ts";
import { pushQueueMessage } from "../push-queue-message.mjs";

const TOOL = resolve(import.meta.dirname, "../push-queue-message.mjs");
const WRITES = "claudinite-licenses-writes";
let server: Server | undefined;

afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

async function startCloudflare(queues: { queue_id: string; queue_name: string }[], perPage = 2) {
  const requests: string[] = [];
  const pushed: { queue: string; body: unknown }[] = [];
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push(`${req.method} ${req.url}`);
      const url = new URL(req.url!, "http://x");
      if (req.headers.authorization !== "Bearer t") {
        res.statusCode = 403;
        return res.end(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }));
      }
      if (url.pathname === "/accounts/acct/queues" && req.method === "GET") {
        const page = Number(url.searchParams.get("page") ?? 1);
        const result = queues.slice((page - 1) * perPage, page * perPage);
        return res.end(JSON.stringify({ success: true, result, result_info: { page, per_page: perPage, total_pages: Math.max(1, Math.ceil(queues.length / perPage)) } }));
      }
      const m = /^\/accounts\/acct\/queues\/([^/]+)\/messages$/.exec(url.pathname);
      if (m && req.method === "POST" && queues.some((q) => q.queue_id === m[1])) {
        pushed.push({ queue: m[1]!, body: JSON.parse(body) });
        return res.end(JSON.stringify({ success: true, errors: [], messages: [], result: { metadata: { metrics: { backlog_bytes: 120, backlog_count: 1, oldest_message_timestamp_ms: 0 } } } }));
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ success: false, errors: [{ code: 7003, message: "No route for the URI" }] }));
    });
  });
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
  const { port } = server!.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, requests, pushed };
}

const HELD = [
  { queue_id: "q-a", queue_name: "acme-a" },
  { queue_id: "q-b", queue_name: "acme-b" },
  { queue_id: "q-w", queue_name: WRITES },
  { queue_id: "q-d", queue_name: `${WRITES}-dlq` },
];
const MESSAGE = { v: 1, kind: "incident", at: 1_790_000_000, marker: "deploy-read-back", detail: "run" };

describe("tools/push-queue-message.mjs", () => {
  it("looks the queue's id up by name, reading every page, and posts the message to it as json", async () => {
    const cf = await startCloudflare(HELD);
    const out = await pushQueueMessage({ base: cf.base, token: "t", accountId: "acct", queue: WRITES, body: MESSAGE });
    expect(out).toMatchObject({ queue_id: "q-w" });
    expect(cf.pushed).toEqual([{ queue: "q-w", body: { body: MESSAGE, content_type: "json" } }]);
    expect(cf.requests.filter((r) => r.startsWith("GET"))).toHaveLength(2);
  });

  it("fails on an unknown queue name, naming the names held, and posts nothing", async () => {
    const cf = await startCloudflare(HELD);
    await expect(pushQueueMessage({ base: cf.base, token: "t", accountId: "acct", queue: "acme-missing", body: MESSAGE })).rejects.toThrow(/acme-missing.*acme-a, acme-b, claudinite-licenses-writes, claudinite-licenses-writes-dlq/);
    expect(cf.pushed).toEqual([]);
  });

  it("names the permission the token lacks on a 403", async () => {
    const cf = await startCloudflare(HELD);
    await expect(pushQueueMessage({ base: cf.base, token: "wrong", accountId: "acct", queue: WRITES, body: MESSAGE })).rejects.toThrow(/403.*Queues Edit/);
  });

  async function cli(base: string, args: string[], token = "t") {
    const child = spawn(process.execPath, [TOOL, ...args, "--base", base], { env: { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: "acct" } });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    const code = await new Promise((done) => child.on("close", done));
    return { code, out, err };
  }

  it("builds a deploy-read-back incident the consumer accepts, prints it as its one line and exits 0", async () => {
    const cf = await startCloudflare(HELD);
    const before = Math.floor(Date.now() / 1000);
    const { code, out } = await cli(cf.base, ["--queue", WRITES, "--marker", "deploy-read-back", "--detail", "https://github.com/acme/runs/1"]);
    expect(code).toBe(0);
    const lines = out.trim().split("\n");
    expect(lines).toHaveLength(1);
    const sent = JSON.parse(lines[0]!);
    expect(sent).toEqual({ v: 1, kind: "incident", at: expect.any(Number), marker: "deploy-read-back", detail: "https://github.com/acme/runs/1" });
    expect(sent.at).toBeGreaterThanOrEqual(before);
    expect(isWriteMessage(sent)).toBe(true);
    expect(cf.pushed).toEqual([{ queue: "q-w", body: { body: sent, content_type: "json" } }]);
  });

  it("takes --at, and exits 1 naming the permission when the token is refused", async () => {
    const cf = await startCloudflare(HELD);
    const ok = await cli(cf.base, ["--queue", WRITES, "--marker", "deploy-read-back", "--detail", "d", "--at", "1790000000"]);
    expect(JSON.parse(ok.out).at).toBe(1_790_000_000);
    const refused = await cli(cf.base, ["--queue", WRITES, "--marker", "deploy-read-back", "--detail", "d"], "wrong");
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(/Queues Edit/);
    expect(refused.out).toBe("");
  });

  it("builds the reconcile requests the deploy pushes, each a message the consumer accepts", async () => {
    for (const marker of ["reconcile-now", "polar-reconcile-now"]) {
      const cf = await startCloudflare(HELD);
      const { code, out } = await cli(cf.base, ["--queue", WRITES, "--marker", marker, "--detail", "https://github.com/acme/runs/1"]);
      expect(code, marker).toBe(0);
      const sent = JSON.parse(out);
      expect(sent, marker).toMatchObject({ v: 1, kind: "incident", marker });
      expect(isWriteMessage(sent), marker).toBe(true);
      await new Promise<void>((done) => server!.close(() => done()));
      server = undefined;
    }
  });

  it("refuses a message the consumer would not accept, before calling anything", async () => {
    const cf = await startCloudflare(HELD);
    const { code, err } = await cli(cf.base, ["--queue", WRITES, "--marker", "acme-marker", "--detail", "d"]);
    expect(code).toBe(2);
    expect(err).toMatch(/acme-marker/);
    expect(cf.requests).toEqual([]);
  });
});
