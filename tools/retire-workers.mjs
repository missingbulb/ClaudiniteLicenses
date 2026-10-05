#!/usr/bin/env node
// Deletes retired Workers by name, printing what it deleted and what was already gone, so a deploy
// can run it every time. Cloudflare's Delete Worker endpoint, `DELETE
// /accounts/{account_id}/workers/scripts/{script_name}` (read 2026-10-05), takes `force=true` to
// delete a Worker other Workers still bind to; a name the account does not hold answers 404, which
// counts as already gone. Reads CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID from the environment.
//
//   node tools/retire-workers.mjs --name claudinite-router --name claudinite-public-key
import { parseArgs } from "node:util";

const API = "https://api.cloudflare.com/client/v4";

/**
 * @param {{ base?: string, token: string, accountId: string, names: string[] }} opts
 * @returns {Promise<{ name: string, deleted: boolean }[]>}
 */
export async function retireWorkers({ base = API, token, accountId, names }) {
  const out = [];
  for (const name of names) {
    const path = `/accounts/${accountId}/workers/scripts/${encodeURIComponent(name)}?force=true`;
    const res = await fetch(`${base}${path}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 404) {
      out.push({ name, deleted: false });
      continue;
    }
    const text = await res.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      // A successful delete has no body.
    }
    if (!res.ok || /** @type {{ success?: boolean }} */ (json).success === false) {
      const hint = res.status === 401 || res.status === 403 ? "; the CLOUDFLARE_API_TOKEN needs the Workers Scripts Edit permission on this account" : "";
      throw new Error(`DELETE ${path} answered ${res.status}: ${text.slice(0, 300)}${hint}`);
    }
    out.push({ name, deleted: true });
  }
  return out;
}

if (import.meta.filename === process.argv[1]) {
  const { values } = parseArgs({ options: { name: { type: "string", multiple: true }, base: { type: "string" } } });
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!values.name?.length || !token || !accountId) {
    console.error("usage: CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node tools/retire-workers.mjs --name <worker> [--name <worker> ...]");
    process.exitCode = 2;
  } else {
    try {
      for (const r of await retireWorkers({ base: values.base, token, accountId, names: values.name })) console.log(`${r.deleted ? "deleted" : "already gone"}: ${r.name}`);
    } catch (err) {
      console.error(`retire-workers: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  }
}
