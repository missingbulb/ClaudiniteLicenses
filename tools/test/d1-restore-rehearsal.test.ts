import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REHEARSAL_DATABASE } from "../d1-restore-rehearsal.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
let server: Server | undefined;

afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

interface Db {
  uuid: string;
  name: string;
  version: string;
  mode: string;
  rows: { name: string; seq: number }[];
}

// The Cloudflare API's D1 routes, plus two the stand-in npx calls to read a bookmark and restore to one.
async function startCloudflare(opts: { existing?: string[]; version?: string; restoreWorks?: boolean; replicationFails?: boolean } = {}) {
  const dbs: Db[] = (opts.existing ?? []).map((name, i) => ({ uuid: `uuid-old-${i}`, name, version: "production", mode: "disabled", rows: [] }));
  const requests: string[] = [];
  let seq = 0;
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url!, "http://x");
      requests.push(`${req.method} ${url.pathname}`);
      const ok = (result: unknown) => res.end(JSON.stringify({ success: true, result }));
      if (url.pathname.startsWith("/__stub/")) {
        const db = dbs.find((d) => d.name === url.searchParams.get("db"))!;
        if (url.pathname === "/__stub/bookmark") return ok({ bookmark: `bm-${String(seq).padStart(4, "0")}` });
        const at = Number(url.searchParams.get("bookmark")!.slice(3));
        if (opts.restoreWorks !== false) db.rows = db.rows.filter((r) => r.seq <= at);
        return ok({ bookmark: `bm-${at}`, previous_bookmark: `bm-${seq}` });
      }
      if (req.headers.authorization !== "Bearer t") {
        res.statusCode = 403;
        return res.end(JSON.stringify({ success: false, errors: [{ message: "bad token" }] }));
      }
      const path = url.pathname.replace(/^\/accounts\/acct\/d1\/database/, "");
      if (path === "" && req.method === "GET") return ok(dbs.filter((d) => d.name === url.searchParams.get("name")).map(({ uuid, name }) => ({ uuid, name })));
      if (path === "" && req.method === "POST") {
        const db = { uuid: `uuid-${dbs.length + 1}`, name: JSON.parse(body).name, version: opts.version ?? "production", mode: "disabled", rows: [] };
        dbs.push(db);
        return ok({ uuid: db.uuid, name: db.name });
      }
      const db = dbs.find((d) => path.startsWith(`/${d.uuid}`));
      if (db && path === `/${db.uuid}` && req.method === "GET") return ok({ uuid: db.uuid, name: db.name, version: db.version, read_replication: { mode: db.mode } });
      if (db && path === `/${db.uuid}` && req.method === "PUT") {
        if (opts.replicationFails) {
          res.statusCode = 500;
          return res.end(JSON.stringify({ success: false, errors: [{ message: "acme replication outage" }] }));
        }
        db.mode = (JSON.parse(body) as { read_replication: { mode: string } }).read_replication.mode;
        return ok({ uuid: db.uuid, name: db.name, read_replication: { mode: db.mode } });
      }
      if (db && path === `/${db.uuid}` && req.method === "DELETE") {
        dbs.splice(dbs.indexOf(db), 1);
        return ok(null);
      }
      if (db && path === `/${db.uuid}/query` && req.method === "POST") {
        const { sql, params } = JSON.parse(body) as { sql: string; params?: unknown[] };
        if (/^INSERT INTO sync_state \(name, at\) VALUES \(\?, \?\)$/.test(sql)) {
          db.rows.push({ name: String(params![0]), seq: ++seq });
          return ok([{ results: [], success: true }]);
        }
        if (/^SELECT name FROM sync_state/.test(sql)) return ok([{ results: db.rows.map((r) => ({ name: r.name })), success: true }]);
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ success: false, errors: [{ message: `no route ${req.method} ${url.pathname}` }] }));
    });
  });
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
  const { port } = server!.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, requests, dbs };
}

// A stand-in npx answering the three wrangler commands the rehearsal runs, recording each argv.
function standInNpx(base: string) {
  const dir = mkdtempSync(join(tmpdir(), "acme-rehearsal-"));
  writeFileSync(
    join(dir, "npx"),
    `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(dir, "argv.log"))}, JSON.stringify(args) + "\\n");
const words = args.slice(0, 4).join(" ");
const go = async () => {
  if (words === "wrangler d1 migrations apply") {
    const config = fs.readFileSync(args[args.indexOf("-c") + 1], "utf8");
    fs.writeFileSync(${JSON.stringify(join(dir, "config.json"))}, config);
    console.log("Migrations applied");
    return;
  }
  if (words === "wrangler d1 time-travel info") {
    const r = await (await fetch(${JSON.stringify(base)} + "/__stub/bookmark?db=" + args[4])).json();
    console.log(JSON.stringify(r.result, null, 2));
    return;
  }
  if (words === "wrangler d1 time-travel restore") {
    const bookmark = args.find((a) => a.startsWith("--bookmark=")).slice(11);
    const r = await (await fetch(${JSON.stringify(base)} + "/__stub/restore?db=" + args[4] + "&bookmark=" + bookmark)).json();
    console.log(JSON.stringify(r.result, null, 2));
    return;
  }
  process.exitCode = 9;
};
go();
`,
  );
  chmodSync(join(dir, "npx"), 0o755);
  return dir;
}

function rehearse(base: string, npxDir: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((ok) => {
    const child = spawn(process.execPath, ["tools/d1-restore-rehearsal.mjs", "--base", base], {
      cwd: ROOT,
      env: { PATH: `${npxDir}:${process.env.PATH}`, CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "acct", NO_PROXY: "127.0.0.1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (status) => ok({ status, stdout, stderr }));
  });
}

const argv = (dir: string) => readFileSync(join(dir, "argv.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);

describe("tools/d1-restore-rehearsal.mjs", () => {
  it("creates, turns read replication on, migrates, inserts, reads a bookmark, inserts, restores, asserts and deletes, in that order", async () => {
    const cf = await startCloudflare();
    const npx = standInNpx(cf.base);
    const res = await rehearse(cf.base, npx);
    expect(res.status, res.stderr + res.stdout).toBe(0);
    expect(res.stdout.split("\n").filter(Boolean).map((l) => l.split(" ")[0])).toEqual(["create", "backend", "replication", "migrate", "insert", "bookmark", "insert", "restore", "assert", "delete"]);
    expect(cf.dbs).toEqual([]);
    const calls = argv(npx);
    expect(calls.map((c) => c.slice(0, 5).join(" "))).toEqual([
      `wrangler d1 migrations apply ${REHEARSAL_DATABASE}`,
      `wrangler d1 time-travel info ${REHEARSAL_DATABASE}`,
      `wrangler d1 time-travel restore ${REHEARSAL_DATABASE}`,
    ]);
    expect(calls[0]).toContain("--remote");
    expect(JSON.parse(readFileSync(join(npx, "config.json"), "utf8")).d1_databases[0]).toMatchObject({ database_name: REHEARSAL_DATABASE, database_id: "uuid-1", migrations_dir: join(ROOT, "db/migrations") });
    expect(res.stdout).toMatch(/^replication auto$/m);
    expect(cf.requests.filter((r) => !r.startsWith("GET /__stub") && !r.startsWith("GET /accounts/acct/d1/database/uuid-1"))).toEqual([
      "GET /accounts/acct/d1/database",
      "POST /accounts/acct/d1/database",
      "PUT /accounts/acct/d1/database/uuid-1",
      "POST /accounts/acct/d1/database/uuid-1/query",
      "POST /accounts/acct/d1/database/uuid-1/query",
      "POST /accounts/acct/d1/database/uuid-1/query",
      "DELETE /accounts/acct/d1/database/uuid-1",
    ]);
  });

  it("turns replication on after the create and before the first migration, so the restore runs on a replicated database", async () => {
    const cf = await startCloudflare();
    const res = await rehearse(cf.base, standInNpx(cf.base));
    expect(res.status, res.stderr + res.stdout).toBe(0);
    const lines = res.stdout.split("\n").filter(Boolean);
    expect(lines.findIndex((l) => l.startsWith("create "))).toBeLessThan(lines.indexOf("replication auto"));
    expect(lines.indexOf("replication auto")).toBeLessThan(lines.indexOf("migrate db/migrations"));
  });

  it("fails when turning replication on fails, before any migration, and still deletes the database", async () => {
    const cf = await startCloudflare({ replicationFails: true });
    const npx = standInNpx(cf.base);
    const res = await rehearse(cf.base, npx);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/PUT .*500/);
    expect(res.stdout).not.toMatch(/^migrate /m);
    expect(res.stdout).toMatch(/^delete /m);
    expect(cf.dbs).toEqual([]);
  });

  it("fails when the restore leaves the second row, and still deletes the database", async () => {
    const cf = await startCloudflare({ restoreWorks: false });
    const res = await rehearse(cf.base, standInNpx(cf.base));
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/second row/);
    expect(res.stdout).toMatch(/^delete /m);
    expect(cf.dbs).toEqual([]);
  });

  it("refuses a rehearsal database that already exists, never reusing or deleting it", async () => {
    const cf = await startCloudflare({ existing: [REHEARSAL_DATABASE] });
    const res = await rehearse(cf.base, standInNpx(cf.base));
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/already exists/);
    expect(cf.requests).toEqual(["GET /accounts/acct/d1/database"]);
    expect(cf.dbs.map((d) => d.name)).toEqual([REHEARSAL_DATABASE]);
  });

  it("refuses a database that is not on the production backend Time Travel needs, and deletes it", async () => {
    const cf = await startCloudflare({ version: "alpha" });
    const res = await rehearse(cf.base, standInNpx(cf.base));
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/production/);
    expect(cf.dbs).toEqual([]);
  });
});
