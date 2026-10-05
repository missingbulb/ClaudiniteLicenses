import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { D1_CONFIGS, ensureD1, PLACEHOLDER_ID, readReplication, setReadReplication, writeDatabaseId } from "../ensure-d1.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const NAME = "claudinite-licenses";
let server: Server | undefined;

afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

// Every comment in these configs is a whole line, so dropping those lines leaves JSON.
const parseJsonc = (text: string) => JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));
type D1Entry = { binding: string; database_name: string; database_id: string; migrations_dir: string };
const d1Of = (config: { d1_databases: D1Entry[] }) => config.d1_databases.find((d) => d.database_name === NAME)!;

type Database = { uuid: string; name: string; mode?: string; putIgnored?: boolean };

async function startCloudflare(databases: Database[]) {
  const requests: string[] = [];
  const bodies: unknown[] = [];
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
      const one = databases.find((d) => url.pathname === `/accounts/acct/d1/database/${d.uuid}`);
      if (one && req.method === "GET") return send({ uuid: one.uuid, name: one.name, version: "production", read_replication: { mode: one.mode ?? "disabled" } });
      if (one && req.method === "PUT") {
        const parsed = JSON.parse(body) as { read_replication: { mode: string } };
        bodies.push(parsed);
        if (!one.putIgnored) one.mode = parsed.read_replication.mode;
        return send({ uuid: one.uuid, name: one.name, read_replication: { mode: one.mode ?? "disabled" } });
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ success: false, errors: [{ message: "no route" }] }));
    });
  });
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
  const { port } = server!.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, requests, bodies, databases };
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
    for (const p of [...D1_CONFIGS, "tools/dev-routes/wrangler.jsonc"]) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      cpSync(join(ROOT, p), join(dir, p));
    }
    const before = Object.fromEntries([...D1_CONFIGS, "tools/dev-routes/wrangler.jsonc"].map((p) => [p, readFileSync(join(dir, p), "utf8")]));
    expect(writeDatabaseId(dir, NAME, "uuid-live")).toEqual(D1_CONFIGS);
    for (const p of D1_CONFIGS) {
      const want = parseJsonc(before[p]!);
      d1Of(want).database_id = "uuid-live";
      expect(parseJsonc(readFileSync(join(dir, p), "utf8")), p).toEqual(want);
    }
    expect(readFileSync(join(dir, "tools/dev-routes/wrangler.jsonc"), "utf8")).toBe(before["tools/dev-routes/wrangler.jsonc"]);
  });

  it("the three committed configs name the same database and the same placeholder id", () => {
    expect(D1_CONFIGS).toEqual(["db/wrangler.jsonc", "workers/key/wrangler.jsonc", "workers/sync/wrangler.jsonc"]);
    for (const p of D1_CONFIGS) {
      const entry = d1Of(parseJsonc(readFileSync(join(ROOT, p), "utf8")));
      expect(entry, p).toMatchObject({ binding: "DB", database_name: NAME, database_id: PLACEHOLDER_ID });
      expect(resolve(ROOT, dirname(p), entry.migrations_dir), p).toBe(join(ROOT, "db/migrations"));
    }
  });

  describe("read replication", () => {
    it("turns a disabled database to auto with one PUT carrying the documented body, and reads the mode back", async () => {
      const cf = await startCloudflare([{ uuid: "uuid-live", name: NAME }]);
      expect(await readReplication({ base: cf.base, token: "t", accountId: "acct", id: "uuid-live" })).toBe("disabled");
      expect(await setReadReplication({ base: cf.base, token: "t", accountId: "acct", id: "uuid-live", mode: "auto" })).toEqual({ changed: true, mode: "auto" });
      expect(cf.bodies).toEqual([{ read_replication: { mode: "auto" } }]);
      expect(cf.requests.slice(1)).toEqual(["GET /accounts/acct/d1/database/uuid-live", "PUT /accounts/acct/d1/database/uuid-live", "GET /accounts/acct/d1/database/uuid-live"]);
    });

    it("sends no PUT when the database already has the mode", async () => {
      const cf = await startCloudflare([{ uuid: "uuid-live", name: NAME, mode: "auto" }]);
      expect(await setReadReplication({ base: cf.base, token: "t", accountId: "acct", id: "uuid-live", mode: "auto" })).toEqual({ changed: false, mode: "auto" });
      expect(cf.requests).toEqual(["GET /accounts/acct/d1/database/uuid-live"]);
    });

    it("fails naming both modes when the read-back after the PUT is not the mode asked for", async () => {
      const cf = await startCloudflare([{ uuid: "uuid-live", name: NAME, putIgnored: true }]);
      await expect(setReadReplication({ base: cf.base, token: "t", accountId: "acct", id: "uuid-live", mode: "auto" })).rejects.toThrow(/asked for auto.*reads disabled/);
    });

    it("names the D1 Edit permission when Cloudflare refuses the token", async () => {
      const cf = await startCloudflare([{ uuid: "uuid-live", name: NAME }]);
      await expect(setReadReplication({ base: cf.base, token: "wrong", accountId: "acct", id: "uuid-live", mode: "auto" })).rejects.toThrow(/403.*D1 Edit/);
      await expect(readReplication({ base: cf.base, token: "expired", accountId: "acct", id: "uuid-live" })).rejects.toThrow(/401.*D1 Edit/);
    });

    it("refuses a mode the API does not name, before any request", async () => {
      const cf = await startCloudflare([{ uuid: "uuid-live", name: NAME }]);
      await expect(setReadReplication({ base: cf.base, token: "t", accountId: "acct", id: "uuid-live", mode: "on" })).rejects.toThrow(/auto or disabled/);
      expect(cf.requests).toEqual([]);
    });

    it("reports a database whose answer carries no read_replication as null, never as disabled", async () => {
      const cf = await startCloudflare([]);
      server!.removeAllListeners("request");
      server!.on("request", (_req, res) => res.end(JSON.stringify({ success: true, result: { uuid: "uuid-live", name: NAME } })));
      expect(await readReplication({ base: cf.base, token: "t", accountId: "acct", id: "uuid-live" })).toBeNull();
    });
  });

  describe("the CLI", () => {
    const cli = (base: string, args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> =>
      new Promise((ok) => {
        const child = spawn(process.execPath, ["tools/ensure-d1.mjs", "--name", NAME, "--base", base, ...args], {
          cwd: ROOT,
          env: { PATH: process.env.PATH!, CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "acct", NO_PROXY: "127.0.0.1" },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (c) => (stdout += c));
        child.stderr.on("data", (c) => (stderr += c));
        child.on("close", (status) => ok({ status, stdout, stderr }));
      });

    it("without a replication flag reads nothing about replication and sends no PUT", async () => {
      const cf = await startCloudflare([{ uuid: "uuid-live", name: NAME }]);
      const res = await cli(cf.base, []);
      expect(res.status, res.stderr).toBe(0);
      expect(cf.requests).toEqual([`GET /accounts/acct/d1/database?name=${NAME}`]);
    });

    it("--read-replication auto sets the mode on the database it found and prints the mode read back", async () => {
      const cf = await startCloudflare([{ uuid: "uuid-live", name: NAME }]);
      const first = await cli(cf.base, ["--read-replication", "auto"]);
      expect(first.status, first.stderr).toBe(0);
      expect(first.stdout).toMatch(/^read replication: auto \(changed\)$/m);
      const again = await cli(cf.base, ["--read-replication", "auto"]);
      expect(again.stdout).toMatch(/^read replication: auto \(unchanged\)$/m);
      expect(cf.requests.filter((r) => r.startsWith("PUT"))).toHaveLength(1);
    });

    it("--show-read-replication prints the mode and changes nothing", async () => {
      const cf = await startCloudflare([{ uuid: "uuid-live", name: NAME }]);
      const res = await cli(cf.base, ["--show-read-replication"]);
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toMatch(/^read replication: disabled$/m);
      expect(cf.requests.filter((r) => !r.startsWith("GET"))).toEqual([]);
    });

    it("--show-read-replication only looks a database up: a missing one prints no database and is never created", async () => {
      const cf = await startCloudflare([{ uuid: "uuid-other", name: `${NAME}-staging` }]);
      const res = await cli(cf.base, ["--show-read-replication"]);
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toMatch(new RegExp(`^read replication: no database named ${NAME}$`, "m"));
      expect(cf.requests).toEqual([`GET /accounts/acct/d1/database?name=${NAME}`]);
      expect(cf.databases.map((d) => d.name)).toEqual([`${NAME}-staging`]);
    });

    it("refuses --show-read-replication beside --write, sending nothing", async () => {
      // A name no committed config binds, so a regression cannot write this checkout's configs.
      const other = "acme-unbound";
      const cf = await startCloudflare([{ uuid: "uuid-other", name: other }]);
      const res = await cli(cf.base, ["--show-read-replication", "--write", "--name", other]);
      expect(res.status).toBe(2);
      expect(cf.requests).toEqual([]);
    });

    it("refuses an unknown mode with usage, sending nothing", async () => {
      const cf = await startCloudflare([{ uuid: "uuid-live", name: NAME }]);
      const res = await cli(cf.base, ["--read-replication", "on"]);
      expect(res.status).toBe(2);
      expect(cf.requests).toEqual([]);
    });
  });
});
