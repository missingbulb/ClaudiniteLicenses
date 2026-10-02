#!/usr/bin/env node
// Reads the key counts back out of the `claudinite_key_counts` Workers Analytics Engine dataset,
// the one point per authenticated key request both key Workers write, through the Analytics Engine
// SQL API. Reads CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID from the environment.
//
//   node tools/key-counts.mjs [--since <unix s | ISO | 7d | 24h | 90m>] [--until …] [--repo-id <n>]
//     [--engine-version <v>] [--group plan,outcome,path] [--probe] [--json | --markdown]
//     [--base <API base URL; tests point it at a stand-in>]
//
// A token without the read permission is an expected state, not an error: the answer is
// `unavailable` naming the permission, and the CLI exits 0 printing it.
//
// Cloudflare's pages, read 2026-10-02:
// - SQL API (developers.cloudflare.com/analytics/analytics-engine/sql-api/): `POST
//   https://api.cloudflare.com/client/v4/accounts/<account_id>/analytics_engine/sql`, "An
//   `Authorization: Bearer <token>` header must be supplied", "Submit the query text in the body of a
//   `POST` request", the token permission "Account | Account Analytics | Read", `SHOW TABLES`, and
//   the columns `dataset`, `timestamp`, `_sample_interval`, `index1`, `blob1`…`blob20`,
//   `double1`…`double20`.
// - SQL reference, statements: `SELECT … [FORMAT JSON|JSONEachRow|TabSeparated]`, `SHOW TABLES
//   [FORMAT <format>]`; `JSON` answers `{ meta: [{ name, type }], data: [{ <column>: <value> }], rows }`.
// - SQL reference, date and time functions: `toDateTime(355924804) -- unix timestamp`, so a
//   whole-second integer is interpolated bare.
// - Sampling: "Count events in a dataset | `count()` | `sum(_sample_interval)`"; a count here is
//   always the latter.
// - Limits: "Data written to Workers Analytics Engine is stored for three months."
// - API token permissions (developers.cloudflare.com/fundamentals/api/reference/permissions/):
//   "Account Analytics Read | Grants read access to account analytics".
//
// The SQL API takes no bound parameters, so every value written into a query is checked by shape
// first and the rest of the text comes from KEY_COUNT_BLOBS and fixed words.
import { parseArgs } from "node:util";
import { KEY_COUNT_BLOBS } from "../packages/licensing/src/index.ts";

export const API = "https://api.cloudflare.com/client/v4";
export const DATASET = "claudinite_key_counts";
export const PERMISSION = "Account Analytics: Read";
const RETRY_DELAYS_MS = [1000, 3000, 9000];
const ENGINE_VERSION = /^[A-Za-z0-9._-]{1,64}$/;

/** @param {number} ms */
const realSleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

/**
 * @typedef {{ available: false, reason: "forbidden", status: number, permission: string }} Unavailable
 * @typedef {{ base?: string, token: string, accountId: string, sleep?: (ms: number) => Promise<void> }} Conn
 */

/**
 * One query. A 401 or 403 answers unavailable; a 5xx or a network error is retried three times and
 * then thrown; any other non-2xx is thrown naming the body.
 * @param {Conn & { sql: string }} opts
 * @returns {Promise<{ available: true, meta: { name: string, type: string }[], data: Record<string, unknown>[], rows: number } | Unavailable>}
 */
export async function querySql({ base = API, token, accountId, sql, sleep = realSleep }) {
  const url = `${base}/accounts/${accountId}/analytics_engine/sql`;
  for (let attempt = 0; ; attempt++) {
    /** @type {Response | null} */
    let res = null;
    let failure = "";
    try {
      res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/plain" }, body: sql });
    } catch (err) {
      failure = `POST ${url} failed: ${err instanceof Error ? err.message : err}`;
    }
    if (res && (res.status === 401 || res.status === 403)) return { available: false, reason: "forbidden", status: res.status, permission: PERMISSION };
    const text = res ? await res.text() : "";
    if (res && res.ok) {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`POST ${url} answered ${res.status} with a body that is not JSON: ${text.slice(0, 300)}`);
      }
      return { available: true, meta: parsed.meta ?? [], data: parsed.data ?? [], rows: parsed.rows ?? (parsed.data ?? []).length };
    }
    if (res && res.status < 500) throw new Error(`POST ${url} answered ${res.status}: ${text.slice(0, 500)}`);
    if (res) failure = `POST ${url} answered ${res.status}: ${text.slice(0, 300)}`;
    if (attempt >= RETRY_DELAYS_MS.length) throw new Error(failure);
    await sleep(RETRY_DELAYS_MS[attempt]);
  }
}

/**
 * @param {Conn} opts
 * @returns {Promise<{ available: true, tables: string[], hasKeyCounts: boolean } | Unavailable>}
 */
export async function probeAvailability(opts) {
  const res = await querySql({ ...opts, sql: "SHOW TABLES FORMAT JSON" });
  if (!res.available) return res;
  const tables = res.data.map((row) => String(row.dataset ?? row.name ?? Object.values(row)[0] ?? ""));
  return { available: true, tables, hasKeyCounts: tables.includes(DATASET) };
}

/** @param {unknown} v @param {string} name */
function wholeSeconds(v, name) {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new Error(`${name} must be whole unix seconds, got ${JSON.stringify(v)}`);
  return v;
}

/**
 * The query for the key counts between `since` and `until`, grouped by `groupBy`, throwing on any
 * value whose shape is not the one it is written into the SQL as.
 * @param {{ since: unknown, until: unknown, repoId?: unknown, engineVersion?: unknown, groupBy?: unknown }} q
 */
export function keyCountsSql({ since, until, repoId, engineVersion, groupBy = ["plan", "outcome", "path"] }) {
  const from = wholeSeconds(since, "since");
  const to = wholeSeconds(until, "until");
  if (from >= to) throw new Error(`since (${from}) must be before until (${to})`);
  if (repoId !== undefined && (typeof repoId !== "string" || !/^\d{1,20}$/.test(repoId))) throw new Error(`repoId must be digits, got ${JSON.stringify(repoId)}`);
  if (engineVersion !== undefined && (typeof engineVersion !== "string" || !ENGINE_VERSION.test(engineVersion))) throw new Error(`engineVersion must match ${ENGINE_VERSION}, got ${JSON.stringify(engineVersion)}`);
  /** @type {readonly string[]} */
  const names = KEY_COUNT_BLOBS;
  if (!Array.isArray(groupBy) || groupBy.length === 0 || !groupBy.every((g) => names.includes(g)) || new Set(groupBy).size !== groupBy.length) {
    throw new Error(`groupBy must be distinct names from ${names.join(", ")}, got ${JSON.stringify(groupBy)}`);
  }
  /** @param {string} name */
  const blob = (name) => `blob${names.indexOf(name) + 1}`;
  const where = [`timestamp >= toDateTime(${from})`, `timestamp < toDateTime(${to})`];
  if (repoId !== undefined) where.push(`index1 = '${repoId}'`);
  if (engineVersion !== undefined) where.push(`${blob("engineVersion")} = '${engineVersion}'`);
  const select = groupBy.map((g) => `${blob(g)} AS ${g}`).join(", ");
  return `SELECT ${select}, sum(_sample_interval) AS requests FROM ${DATASET} WHERE ${where.join(" AND ")} GROUP BY ${groupBy.join(", ")} ORDER BY requests DESC FORMAT JSON`;
}

/**
 * @param {Conn & { since: number, until?: number, repoId?: string, engineVersion?: string, groupBy?: string[] }} opts
 * @returns {Promise<{ available: true, since: number, until: number, groupBy: string[], rows: Record<string, string | number>[], total: number } | Unavailable>}
 */
export async function keyCounts({ since, until = Math.floor(Date.now() / 1000), repoId, engineVersion, groupBy = ["plan", "outcome", "path"], ...conn }) {
  const sql = keyCountsSql({ since, until, repoId, engineVersion, groupBy });
  const res = await querySql({ ...conn, sql });
  if (!res.available) return res;
  const rows = res.data.map((row) => {
    const requests = Number(row.requests);
    if (!Number.isFinite(requests)) throw new Error(`a row's requests is not a number: ${JSON.stringify(row)}`);
    return { ...Object.fromEntries(groupBy.map((g) => [g, String(row[g] ?? "")])), requests };
  });
  return { available: true, since, until, groupBy, rows, total: rows.reduce((n, r) => n + r.requests, 0) };
}

/**
 * A CLI time: whole unix seconds, an ISO date, or a span back from `nowS` in days, hours or minutes.
 * @param {string} value @param {number} nowS
 */
export function parseTime(value, nowS) {
  const span = /^(\d{1,6})([dhm])$/.exec(value);
  if (span) return nowS - Number(span[1]) * { d: 86400, h: 3600, m: 60 }[/** @type {"d"|"h"|"m"} */ (span[2])];
  if (/^\d{1,12}$/.test(value)) return Number(value);
  if (/^\d{4}-\d\d-\d\d([T ][\d:.]+(Z|[+-]\d\d:?\d\d)?)?$/.test(value)) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  }
  throw new Error(`${JSON.stringify(value)} is not unix seconds, an ISO date, or a span like 7d, 24h or 90m`);
}

/** @param {Unavailable} u */
const unavailableLine = (u) => `key counts: unavailable (${u.status}; the CLOUDFLARE_API_TOKEN needs the ${u.permission} permission on this account)`;

const USAGE =
  "usage: CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node tools/key-counts.mjs [--since <unix s | ISO | 7d | 24h | 90m>] [--until …] [--repo-id <n>] [--engine-version <v>] [--group plan,outcome,path] [--probe] [--json | --markdown] [--base <API base URL; tests point it at a stand-in>]";

/** @returns {Promise<number>} the exit status */
async function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        since: { type: "string" },
        until: { type: "string" },
        "repo-id": { type: "string" },
        "engine-version": { type: "string" },
        group: { type: "string" },
        probe: { type: "boolean" },
        json: { type: "boolean" },
        markdown: { type: "boolean" },
        base: { type: "string" },
      },
    }));
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : err}\n${USAGE}`);
    return 2;
  }
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const nowS = Math.floor(Date.now() / 1000);
  /** @type {{ since: number, until: number, groupBy: string[] }} */
  let range;
  try {
    if (!token || !accountId || (values.json && values.markdown)) throw new Error("");
    range = {
      since: parseTime(String(values.since ?? "7d"), nowS),
      until: values.until === undefined ? nowS : parseTime(String(values.until), nowS),
      groupBy: String(values.group ?? "plan,outcome,path").split(","),
    };
  } catch (err) {
    console.error(`${err instanceof Error && err.message ? `${err.message}\n` : ""}${USAGE}`);
    return 2;
  }
  const conn = { base: values.base === undefined ? undefined : String(values.base), token, accountId };
  try {
    if (values.probe) {
      const res = await probeAvailability(conn);
      if (values.json) console.log(JSON.stringify(res));
      else console.log(res.available ? `key counts: available, dataset ${DATASET} ${res.hasKeyCounts ? "present" : "absent"}` : unavailableLine(res));
      return 0;
    }
    const res = await keyCounts({
      ...conn,
      ...range,
      repoId: values["repo-id"] === undefined ? undefined : String(values["repo-id"]),
      engineVersion: values["engine-version"] === undefined ? undefined : String(values["engine-version"]),
    });
    if (values.json) {
      console.log(JSON.stringify(res));
    } else if (!res.available) {
      console.log(unavailableLine(res));
    } else if (values.markdown) {
      console.log(`| ${[...res.groupBy, "requests"].join(" | ")} |`);
      console.log(`| ${[...res.groupBy, "requests"].map(() => "---").join(" | ")} |`);
      for (const r of res.rows) console.log(`| ${[...res.groupBy.map((g) => r[g]), r.requests].join(" | ")} |`);
      console.log(`| total | ${res.groupBy.slice(1).map(() => "").join(" | ")}${res.groupBy.length > 1 ? " | " : ""}${res.total} |`);
    } else {
      console.log(`key counts: ${res.rows.length} rows, ${res.total} requests since ${new Date(res.since * 1000).toISOString()}`);
      const cells = res.rows.map((r) => [...res.groupBy.map((g) => String(r[g])), String(r.requests)]);
      const widths = cells.reduce((w, row) => row.map((c, i) => Math.max(w[i] ?? 0, c.length)), /** @type {number[]} */ ([]));
      for (const row of cells) console.log(row.map((c, i) => (i === row.length - 1 ? c : c.padEnd(widths[i] ?? 0))).join("  "));
    }
    return 0;
  } catch (err) {
    console.error(`key-counts: ${err instanceof Error ? err.message : err}`);
    return 1;
  }
}

if (import.meta.filename === process.argv[1]) process.exitCode = await main();
