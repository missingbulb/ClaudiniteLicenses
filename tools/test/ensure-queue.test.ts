import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureQueues } from "../ensure-queue.mjs";

const TOOL = resolve(import.meta.dirname, "../ensure-queue.mjs");
let server: Server | undefined;

afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

async function startCloudflare(queues: { queue_id: string; queue_name: string }[], perPage = 2) {
  const requests: string[] = [];
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push(`${req.method} ${req.url}`);
      const url = new URL(req.url!, "http://x");
      if (req.headers.authorization !== "Bearer t") {
        res.statusCode = 403;
        return res.end(JSON.stringify({ success: false, errors: [{ message: "bad token" }] }));
      }
      if (url.pathname === "/accounts/acct/queues" && req.method === "GET") {
        const page = Number(url.searchParams.get("page") ?? 1);
        const result = queues.slice((page - 1) * perPage, page * perPage);
        return res.end(JSON.stringify({ success: true, result, result_info: { page, per_page: perPage, total_pages: Math.max(1, Math.ceil(queues.length / perPage)) } }));
      }
      if (url.pathname === "/accounts/acct/queues" && req.method === "POST") {
        const q = { queue_id: `q-${queues.length + 1}`, queue_name: JSON.parse(body).queue_name };
        queues.push(q);
        return res.end(JSON.stringify({ success: true, result: q }));
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ success: false, errors: [{ message: "no route" }] }));
    });
  });
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
  const { port } = server!.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, requests, queues };
}

const NAMES = ["claudinite-licenses-writes", "claudinite-licenses-writes-dlq"];

describe("tools/ensure-queue.mjs", () => {
  it("creates the queue and its dead-letter queue once, and keeps both the next time, reading every page", async () => {
    const cf = await startCloudflare([
      { queue_id: "q-a", queue_name: "acme-a" },
      { queue_id: "q-b", queue_name: "acme-b" },
      { queue_id: "q-c", queue_name: "claudinite-licenses-writes-staging" },
    ]);
    const first = await ensureQueues({ base: cf.base, token: "t", accountId: "acct", names: NAMES });
    expect(first).toEqual([
      { name: NAMES[0], created: true, id: "q-4" },
      { name: NAMES[1], created: true, id: "q-5" },
    ]);
    const again = await ensureQueues({ base: cf.base, token: "t", accountId: "acct", names: NAMES });
    expect(again.map((q) => q.created)).toEqual([false, false]);
    expect(cf.requests.filter((r) => r.startsWith("POST"))).toHaveLength(2);
    expect(cf.requests.filter((r) => r.startsWith("GET")).length).toBeGreaterThanOrEqual(5);
  });

  it("names the permission the token lacks", async () => {
    const cf = await startCloudflare([]);
    await expect(ensureQueues({ base: cf.base, token: "wrong", accountId: "acct", names: NAMES })).rejects.toThrow(/Queues Edit/);
  });

  it("with --dlq, prints each queue and exits 0", async () => {
    const cf = await startCloudflare([{ queue_id: "q-1", queue_name: NAMES[0]! }]);
    const child = spawn(process.execPath, [TOOL, "--name", NAMES[0]!, "--dlq", "--base", cf.base], { env: { ...process.env, CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "acct" } });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    const code = await new Promise((done) => child.on("close", done));
    expect(code).toBe(0);
    expect(out).toBe(`already held: ${NAMES[0]} q-1\ncreated: ${NAMES[1]} q-2\n`);
  });
});
