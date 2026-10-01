import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ensureDns } from "../ensure-dns.mjs";

type Rec = { type: string; name: string; content: string; proxied: boolean };
const ROOT = resolve(import.meta.dirname, "../..");
let server: Server | undefined;

afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

async function startCloudflare(records: Rec[]) {
  const requests: string[] = [];
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push(`${req.method} ${req.url}`);
      const url = new URL(req.url!, "http://x");
      const send = (result: unknown) => res.end(JSON.stringify({ success: true, result }));
      if (url.pathname === "/zones") return send(url.searchParams.get("name") === "claudinite.com" ? [{ id: "z1" }] : []);
      if (url.pathname === "/zones/z1/dns_records" && req.method === "GET") return send(records.filter((r) => r.name === url.searchParams.get("name")));
      if (url.pathname === "/zones/z1/dns_records" && req.method === "POST") {
        const rec = JSON.parse(body);
        records.push(rec);
        return send(rec);
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ success: false, errors: [{ message: "no route" }] }));
    });
  });
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
  const { port } = server!.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, requests, records };
}

describe("tools/ensure-dns.mjs", () => {
  it("creates a proxied AAAA 100:: record when the name has none", async () => {
    const cf = await startCloudflare([{ type: "TXT", name: "license.claudinite.com", content: "x", proxied: false }]);
    const out = await ensureDns({ base: cf.base, token: "t", zone: "claudinite.com", name: "license.claudinite.com" });
    expect(out.created).toBe(true);
    expect(cf.records.at(-1)).toMatchObject({ type: "AAAA", name: "license.claudinite.com", content: "100::", proxied: true });
  });

  it("leaves an existing proxied record alone, so calling twice creates one record", async () => {
    const cf = await startCloudflare([]);
    await ensureDns({ base: cf.base, token: "t", zone: "claudinite.com", name: "license.claudinite.com" });
    const again = await ensureDns({ base: cf.base, token: "t", zone: "claudinite.com", name: "license.claudinite.com" });
    expect(again.created).toBe(false);
    expect(cf.requests.filter((r) => r.startsWith("POST"))).toHaveLength(1);
  });

  it("refuses an unproxied record, which Worker routes never see", async () => {
    const cf = await startCloudflare([{ type: "A", name: "license.claudinite.com", content: "192.0.2.1", proxied: false }]);
    await expect(ensureDns({ base: cf.base, token: "t", zone: "claudinite.com", name: "license.claudinite.com" })).rejects.toThrow(/not proxied/);
  });

  it("fails when the token sees no such zone", async () => {
    const cf = await startCloudflare([]);
    await expect(ensureDns({ base: cf.base, token: "t", zone: "other.com", name: "license.other.com" })).rejects.toThrow(/no zone named other\.com/);
  });
});

describe("deploy.yml", () => {
  it("makes the route hostname resolve before it reads the Workers back", () => {
    const wf = parse(readFileSync(join(ROOT, ".github/workflows/deploy.yml"), "utf8"));
    const steps = wf.jobs.deploy.steps as { name?: string; run?: string }[];
    const dns = steps.findIndex((s) => s.run?.includes("tools/ensure-dns.mjs") && s.run.includes("--name license.claudinite.com"));
    const readBack = steps.findIndex((s) => s.name === "Read back the live Workers");
    expect(dns).toBeGreaterThan(-1);
    expect(dns).toBeLessThan(readBack);
  });
});
