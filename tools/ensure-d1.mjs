#!/usr/bin/env node
// Makes the license server's D1 database exist and prints its id. With --write it also sets that
// id in the wrangler configs that bind the database, in this checkout only: the committed value
// is a placeholder, which `wrangler deploy --dry-run` accepts. Reads CLOUDFLARE_API_TOKEN and
// CLOUDFLARE_ACCOUNT_ID from the environment.
//
// It also reads and sets the database's read replication mode. Cloudflare's D1 read replication
// page (developers.cloudflare.com/d1/best-practices/read-replication/, read 2026-10-02): `PUT
// /accounts/{account_id}/d1/database/{database_id}` with `{"read_replication":{"mode":"auto"}}`
// turns it on and `"disabled"` off, both needing D1 Edit, and the `GET` of the same path reports
// it as `result.read_replication.mode`. A database whose answer carries no such field reads as
// null, an unknown, never as disabled.
//
//   node tools/ensure-d1.mjs --name claudinite-licenses [--write] [--read-replication auto|disabled | --show-read-replication, which looks up and never creates]
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

export const PLACEHOLDER_ID = "00000000-0000-0000-0000-000000000000";
/** Every config that binds the database, relative to the repo root. */
export const D1_CONFIGS = ["db/wrangler.jsonc", "workers/key/wrangler.jsonc", "workers/sync/wrangler.jsonc"];

/** The modes the D1 API names for read replication. */
export const REPLICATION_MODES = ["auto", "disabled"];
const API = "https://api.cloudflare.com/client/v4";

/** @param {string} base @param {string} token */
function caller(base, token) {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  /** @param {string} method @param {string} path @param {unknown} [body] */
  return async (method, path, body) => {
    const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.success === false) {
      const hint = res.status === 401 || res.status === 403 ? "; the CLOUDFLARE_API_TOKEN needs the D1 Edit permission on this account" : "";
      throw new Error(`${method} ${path} answered ${res.status}: ${JSON.stringify(json.errors ?? json)}${hint}`);
    }
    return json.result;
  };
}

/**
 * The id of the database named `name`, or null when there is none; it never creates one.
 * @param {{ base?: string, token: string, accountId: string, name: string }} opts
 * @returns {Promise<string | null>}
 */
export async function findD1({ base = API, token, accountId, name }) {
  const listed = await caller(base, token)("GET", `/accounts/${accountId}/d1/database?name=${encodeURIComponent(name)}`);
  return listed.find((/** @type {{ name: string }} */ d) => d.name === name)?.uuid ?? null;
}

/**
 * @param {{ base?: string, token: string, accountId: string, name: string }} opts
 * @returns {Promise<{ created: boolean, id: string }>}
 */
export async function ensureD1({ base = API, token, accountId, name }) {
  const found = await findD1({ base, token, accountId, name });
  if (found) return { created: false, id: found };
  const made = await caller(base, token)("POST", `/accounts/${accountId}/d1/database`, { name });
  return { created: true, id: made.uuid };
}

/**
 * The database's read replication mode as the API reports it, or null when the answer names none.
 * @param {{ base?: string, token: string, accountId: string, id: string }} opts
 * @returns {Promise<string | null>}
 */
export async function readReplication({ base = API, token, accountId, id }) {
  const result = await caller(base, token)("GET", `/accounts/${accountId}/d1/database/${id}`);
  const mode = result?.read_replication?.mode;
  return typeof mode === "string" ? mode : null;
}

/**
 * Gives the database `mode`, sending the PUT only when its mode differs, and reads it back.
 * @param {{ base?: string, token: string, accountId: string, id: string, mode: string }} opts
 * @returns {Promise<{ changed: boolean, mode: string }>}
 */
export async function setReadReplication({ base = API, token, accountId, id, mode }) {
  if (!REPLICATION_MODES.includes(mode)) throw new Error(`read replication mode ${JSON.stringify(mode)} is not ${REPLICATION_MODES.join(" or ")}`);
  const before = await readReplication({ base, token, accountId, id });
  if (before === mode) return { changed: false, mode };
  await caller(base, token)("PUT", `/accounts/${accountId}/d1/database/${id}`, { read_replication: { mode } });
  const after = await readReplication({ base, token, accountId, id });
  if (after !== mode) throw new Error(`asked for ${mode} read replication on ${id}, but it reads ${after ?? "no mode"} after the PUT`);
  return { changed: true, mode };
}

/**
 * Sets database_id on the entry naming `name` in each of D1_CONFIGS under `root`, touching
 * nothing else in the file. Returns the configs it changed.
 * @param {string} root @param {string} name @param {string} id
 */
export function writeDatabaseId(root, name, id) {
  const entry = new RegExp(`\\{[^{}]*"database_name"\\s*:\\s*"${name.replace(/[-.]/g, "\\$&")}"[^{}]*\\}`, "g");
  const written = [];
  for (const rel of D1_CONFIGS) {
    const path = join(root, rel);
    const text = readFileSync(path, "utf8");
    const next = text.replace(entry, (obj) => obj.replace(/("database_id"\s*:\s*)"[^"]*"/, `$1"${id}"`));
    if (next === text && !text.includes(`"${id}"`)) throw new Error(`${rel} has no d1_databases entry for ${name}`);
    writeFileSync(path, next);
    written.push(rel);
  }
  return written;
}

if (import.meta.filename === process.argv[1]) {
  const { values } = parseArgs({
    options: {
      name: { type: "string" },
      write: { type: "boolean", default: false },
      base: { type: "string" },
      "read-replication": { type: "string" },
      "show-read-replication": { type: "boolean", default: false },
    },
  });
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const mode = values["read-replication"];
  const show = values["show-read-replication"];
  const badMode = (mode !== undefined && (!REPLICATION_MODES.includes(mode) || show)) || (show && values.write);
  if (!values.name || !token || !accountId || badMode) {
    console.error(
      "usage: CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node tools/ensure-d1.mjs --name <database> [--write] [--read-replication auto|disabled | --show-read-replication, which looks up and never creates]",
    );
    process.exit(2);
  }
  try {
    if (show) {
      // Looks up only: the read-back runs this after promotion, where creating a database would be wrong.
      const id = await findD1({ base: values.base, token, accountId, name: values.name });
      console.log(`read replication: ${id ? ((await readReplication({ base: values.base, token, accountId, id })) ?? "unreported") : `no database named ${values.name}`}`);
    } else {
      const { created, id } = await ensureD1({ base: values.base, token, accountId, name: values.name });
      console.log(`${created ? "created" : "already held"}: ${values.name} ${id}`);
      if (values.write) console.log(`database_id set in ${writeDatabaseId(resolve(import.meta.dirname, ".."), values.name, id).join(", ")}`);
      if (mode !== undefined) {
        const set = await setReadReplication({ base: values.base, token, accountId, id, mode });
        console.log(`read replication: ${set.mode} (${set.changed ? "changed" : "unchanged"})`);
      }
    }
  } catch (err) {
    console.error(`ensure-d1: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  }
}
