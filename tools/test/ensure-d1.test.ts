import { cpSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { D1_CONFIGS, ensureD1, PLACEHOLDER_ID, writeDatabaseId } from "../ensure-d1.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const NAME = "claudinite-licenses";
let server: Server | undefined;

afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

// Every comment in these configs is a whole line, so dropping those lines leaves JSON.
const parseJsonc = (text: string) => JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));
type D1Entry = { binding: string; database_name: string; database_id: string; migrations_dir: string };
const d1Of = (config: { d1_databases: D1Entry[] }) => config.d1_databases.find((d) => d.database_name === NAME)!;

async function startCloudflare(databases: { uuid: string; name: string }[]) {
  const requests: string[] = [];
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push(`${req.method} ${req.url}`);
      const url = new URL(req.url!, "http://x");
      const send = (result: unknown) => res.end(JSON.stringify({ success: true, result }));
      if (req.headers.authorization !== "Bearer t") {
        res.statusCode = req.headers.authorization === "Bearer expired" ? 401 : 403;
        return res.end(JSON.stringify({ success: false, errors: [{ message: "bad token" }] }));
      }
      if (url.pathname === "/accounts/acct/d1/database" && req.method === "GET") {
        const filter = url.searchParams.get("name") ?? "";
        return send(databases.filter((d) => d.name.includes(filter)));
      }
      if (url.pathname === "/accounts/acct/d1/database" && req.method === "POST") {
        const db = { uuid: `uuid-${databases.length + 1}`, name: JSON.parse(body).name };
        databases.push(db);
        return send(db);
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ success: false, errors: [{ message: "no route" }] }));
    });
  });
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
  const { port } = server!.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, requests, databases };
}

describe("tools/ensure-d1.mjs", () => {
  it("creates a missing database once, and finds it the next time", async () => {
    const cf = await startCloudflare([{ uuid: "uuid-other", name: `${NAME}-staging` }]);
    const first = await ensureD1({ base: cf.base, token: "t", accountId: "acct", name: NAME });
    expect(first).toEqual({ created: true, id: "uuid-2" });
    const again = await ensureD1({ base: cf.base, token: "t", accountId: "acct", name: NAME });
    expect(again).toEqual({ created: false, id: "uuid-2" });
    expect(cf.requests.filter((r) => r.startsWith("POST"))).toHaveLength(1);
  });

  it("never creates a database that exists", async () => {
    const cf = await startCloudflare([{ uuid: "uuid-live", name: NAME }]);
    expect(await ensureD1({ base: cf.base, token: "t", accountId: "acct", name: NAME })).toEqual({ created: false, id: "uuid-live" });
    expect(cf.requests.filter((r) => r.startsWith("POST"))).toHaveLength(0);
  });

  it("fails on a Cloudflare error", async () => {
    const cf = await startCloudflare([]);
    await expect(ensureD1({ base: cf.base, token: "wrong", accountId: "acct", name: NAME })).rejects.toThrow(/403/);
  });

  it("names the D1 Edit permission when Cloudflare refuses the token, and only then", async () => {
    const cf = await startCloudflare([]);
    for (const token of ["wrong", "expired"]) {
      await expect(ensureD1({ base: cf.base, token, accountId: "acct", name: NAME })).rejects.toThrow(/CLOUDFLARE_API_TOKEN needs the D1 Edit permission/);
    }
    const missing = ensureD1({ base: cf.base, token: "t", accountId: "other", name: NAME });
    await expect(missing).rejects.toThrow(/404/);
    await expect(ensureD1({ base: cf.base, token: "t", accountId: "other", name: NAME })).rejects.not.toThrow(/D1 Edit/);
  });

  it("--write patches database_id in exactly the three configs and leaves every other key untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "acme-d1-"));
    for (const p of [...D1_CONFIGS, "workers/router/wrangler.jsonc"]) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      cpSync(join(ROOT, p), join(dir, p));
    }
    const before = Object.fromEntries([...D1_CONFIGS, "workers/router/wrangler.jsonc"].map((p) => [p, readFileSync(join(dir, p), "utf8")]));
    expect(writeDatabaseId(dir, NAME, "uuid-live")).toEqual(D1_CONFIGS);
    for (const p of D1_CONFIGS) {
      const want = parseJsonc(before[p]!);
      d1Of(want).database_id = "uuid-live";
      expect(parseJsonc(readFileSync(join(dir, p), "utf8")), p).toEqual(want);
    }
    expect(readFileSync(join(dir, "workers/router/wrangler.jsonc"), "utf8")).toBe(before["workers/router/wrangler.jsonc"]);
  });

  it("the three committed configs name the same database and the same placeholder id", () => {
    expect(D1_CONFIGS).toEqual(["db/wrangler.jsonc", "workers/key/wrangler.jsonc", "workers/sync/wrangler.jsonc"]);
    for (const p of D1_CONFIGS) {
      const entry = d1Of(parseJsonc(readFileSync(join(ROOT, p), "utf8")));
      expect(entry, p).toMatchObject({ binding: "DB", database_name: NAME, database_id: PLACEHOLDER_ID });
      expect(resolve(ROOT, dirname(p), entry.migrations_dir), p).toBe(join(ROOT, "db/migrations"));
    }
  });
});
