#!/usr/bin/env node
// Makes the license server's D1 database exist and prints its id. With --write it also sets that
// id in the wrangler configs that bind the database, in this checkout only: the committed value
// is a placeholder, which `wrangler deploy --dry-run` accepts. Reads CLOUDFLARE_API_TOKEN and
// CLOUDFLARE_ACCOUNT_ID from the environment.
//
//   node tools/ensure-d1.mjs --name claudinite-licenses [--write]
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

export const PLACEHOLDER_ID = "00000000-0000-0000-0000-000000000000";
/** Every config that binds the database, relative to the repo root. */
export const D1_CONFIGS = ["db/wrangler.jsonc", "workers/key/wrangler.jsonc", "workers/sync/wrangler.jsonc"];

/**
 * @param {{ base?: string, token: string, accountId: string, name: string }} opts
 * @returns {Promise<{ created: boolean, id: string }>}
 */
export async function ensureD1({ base = "https://api.cloudflare.com/client/v4", token, accountId, name }) {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  /** @param {string} method @param {string} path @param {unknown} [body] */
  const call = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.success === false) throw new Error(`${method} ${path} answered ${res.status}: ${JSON.stringify(json.errors ?? json)}`);
    return json.result;
  };
  const path = `/accounts/${accountId}/d1/database`;
  const found = (await call("GET", `${path}?name=${encodeURIComponent(name)}`)).find((/** @type {{ name: string }} */ d) => d.name === name);
  if (found) return { created: false, id: found.uuid };
  const made = await call("POST", path, { name });
  return { created: true, id: made.uuid };
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
  const { values } = parseArgs({ options: { name: { type: "string" }, write: { type: "boolean", default: false }, base: { type: "string" } } });
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!values.name || !token || !accountId) {
    console.error("usage: CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node tools/ensure-d1.mjs --name <database> [--write]");
    process.exit(2);
  }
  try {
    const { created, id } = await ensureD1({ base: values.base, token, accountId, name: values.name });
    console.log(`${created ? "created" : "already held"}: ${values.name} ${id}`);
    if (values.write) console.log(`database_id set in ${writeDatabaseId(resolve(import.meta.dirname, ".."), values.name, id).join(", ")}`);
  } catch (err) {
    console.error(`ensure-d1: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  }
}
