#!/usr/bin/env node
// Rehearses a D1 Time Travel restore on a throwaway database, so the command d1-restore.yml runs
// against the real one is known to work before anyone needs it: creates the rehearsal database,
// checks it is on the production backend Time Travel needs, turns read replication on so the
// restore is proven on the shape the deploy gives production, applies the migrations, writes a row,
// reads a bookmark, writes a second row, runs RESTORE_COMMAND with that bookmark, asserts the first
// row survived and the second is gone, and deletes the database, printing one line per step. A
// rehearsal database that already exists is refused, never reused. Reads CLOUDFLARE_API_TOKEN and
// CLOUDFLARE_ACCOUNT_ID from the environment.
//
//   node tools/d1-restore-rehearsal.mjs [--base <cloudflare api>]
//
// `--json` is part of the command because without it wrangler asks "OK to proceed (y/N)" first,
// and answers its default, no, off a terminal (wrangler 4.145's d1 time-travel restore handler).
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { setReadReplication } from "./ensure-d1.mjs";

/** The restore d1-restore.yml runs, with {database} and {bookmark} filled in; the rehearsal runs exactly this. */
export const RESTORE_COMMAND = "npx wrangler d1 time-travel restore {database} --bookmark={bookmark} --json -c db/wrangler.jsonc";
export const REHEARSAL_DATABASE = "claudinite-licenses-rehearsal";

const ROOT = resolve(import.meta.dirname, "..");
const FIRST = "rehearsal-before-bookmark";
const SECOND = "rehearsal-after-bookmark";

/** @param {string} database @param {string} bookmark @returns {string[]} the command's argv */
export function restoreArgv(database, bookmark) {
  return RESTORE_COMMAND.split(" ").map((w) => w.replace("{database}", database).replace("{bookmark}", bookmark));
}

/** @param {string[]} argv */
function run(argv) {
  const [cmd, ...args] = argv;
  const res = spawnSync(/** @type {string} */ (cmd), args, { cwd: ROOT, encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
  if (res.status !== 0) throw new Error(`${argv.slice(0, 5).join(" ")} failed (exit ${res.status}):\n${res.stdout ?? ""}${res.stderr ?? String(res.error ?? "")}`);
  return res.stdout;
}

/** @param {string} text */
function lastJson(text) {
  const at = text.indexOf("{");
  if (at < 0) throw new Error(`no JSON in wrangler's output:\n${text}`);
  return JSON.parse(text.slice(at));
}

/** @param {{ base?: string, token: string, accountId: string, log?: (line: string) => void }} o */
export async function rehearse({ base = "https://api.cloudflare.com/client/v4", token, accountId, log = console.log }) {
  /** @param {string} method @param {string} path @param {unknown} [body] */
  const call = async (method, path, body) => {
    const res = await fetch(`${base}/accounts/${accountId}/d1/database${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.success === false) throw new Error(`${method} d1/database${path} answered ${res.status}: ${JSON.stringify(json.errors ?? json)}`);
    return json.result;
  };
  const existing = await call("GET", `?name=${encodeURIComponent(REHEARSAL_DATABASE)}`);
  if (existing.some((/** @type {{ name: string }} */ d) => d.name === REHEARSAL_DATABASE)) {
    throw new Error(`${REHEARSAL_DATABASE} already exists; a rehearsal never reuses a database, so delete it by hand after checking it holds nothing`);
  }
  const { uuid } = await call("POST", "", { name: REHEARSAL_DATABASE });
  log(`create ${REHEARSAL_DATABASE} ${uuid}`);
  const dir = mkdtempSync(join(tmpdir(), "d1-rehearsal-"));
  try {
    const { version } = await call("GET", `/${uuid}`);
    if (version !== "production") throw new Error(`${REHEARSAL_DATABASE} is on the ${version} backend; Time Travel needs production`);
    log(`backend ${version}`);
    const { mode } = await setReadReplication({ base, token, accountId, id: uuid, mode: "auto" });
    log(`replication ${mode}`);

    const config = join(dir, "wrangler.json");
    writeFileSync(
      config,
      JSON.stringify({ name: "claudinite-licenses-rehearsal", compatibility_date: "2026-08-15", d1_databases: [{ binding: "DB", database_name: REHEARSAL_DATABASE, database_id: uuid, migrations_dir: join(ROOT, "db/migrations") }] }),
    );
    run(["npx", "wrangler", "d1", "migrations", "apply", REHEARSAL_DATABASE, "--remote", "-c", config]);
    log("migrate db/migrations");

    const insert = (/** @type {string} */ name) => call("POST", `/${uuid}/query`, { sql: "INSERT INTO sync_state (name, at) VALUES (?, ?)", params: [name, Math.floor(Date.now() / 1000)] });
    await insert(FIRST);
    log(`insert ${FIRST}`);
    const { bookmark } = lastJson(run(["npx", "wrangler", "d1", "time-travel", "info", REHEARSAL_DATABASE, "--json", "-c", "db/wrangler.jsonc"]));
    if (typeof bookmark !== "string" || !bookmark) throw new Error("time-travel info printed no bookmark");
    log(`bookmark ${bookmark}`);
    await insert(SECOND);
    log(`insert ${SECOND}`);

    run(restoreArgv(REHEARSAL_DATABASE, bookmark));
    log(`restore ${bookmark}`);

    const [{ results }] = await call("POST", `/${uuid}/query`, { sql: "SELECT name FROM sync_state ORDER BY name" });
    const names = results.map((/** @type {{ name: string }} */ r) => r.name);
    if (!names.includes(FIRST)) throw new Error(`the restore lost the first row, written before the bookmark (rows: ${JSON.stringify(names)})`);
    if (names.includes(SECOND)) throw new Error(`the restore left the second row, written after the bookmark (rows: ${JSON.stringify(names)})`);
    log(`assert ${FIRST} kept, ${SECOND} gone`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await call("DELETE", `/${uuid}`);
    log(`delete ${REHEARSAL_DATABASE} ${uuid}`);
  }
}

if (import.meta.filename === process.argv[1]) {
  const { values } = parseArgs({ options: { base: { type: "string" } } });
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !accountId) {
    console.error("usage: CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node tools/d1-restore-rehearsal.mjs [--base <url>]");
    process.exitCode = 2;
  } else {
    try {
      await rehearse({ base: values.base, token, accountId });
    } catch (err) {
      console.error(`d1-restore-rehearsal: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  }
}
