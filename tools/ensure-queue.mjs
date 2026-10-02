#!/usr/bin/env node
// Makes a Cloudflare Queue exist, and with --dlq its dead-letter queue `<name>-dlq` too, creating
// what is missing and printing what already exists. Reads CLOUDFLARE_API_TOKEN and
// CLOUDFLARE_ACCOUNT_ID from the environment.
//
//   node tools/ensure-queue.mjs --name claudinite-licenses-writes [--dlq]
import { parseArgs } from "node:util";

const API = "https://api.cloudflare.com/client/v4";

/**
 * One call to Cloudflare's API, throwing on a refusal; a 401 or 403 names the permission the token lacks.
 * @param {{ base?: string, token: string }} opts
 * @returns {(method: string, path: string, body?: unknown) => Promise<any>}
 */
export function queuesCall({ base = API, token }) {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  return async (method, path, body) => {
    const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.success === false) {
      const hint = res.status === 401 || res.status === 403 ? "; the CLOUDFLARE_API_TOKEN needs the Queues Edit (or Workers Scripts Edit) permission on this account" : "";
      throw new Error(`${method} ${path} answered ${res.status}: ${JSON.stringify(json.errors ?? json)}${hint}`);
    }
    return json;
  };
}

/**
 * Every queue the account holds, read page by page: the name→id lookup.
 * @param {{ base?: string, token: string, accountId: string }} opts
 * @returns {Promise<{ queue_id: string, queue_name: string }[]>}
 */
export async function listQueues({ base = API, token, accountId }) {
  const call = queuesCall({ base, token });
  const path = `/accounts/${accountId}/queues`;
  /** @type {{ queue_id: string, queue_name: string }[]} */
  const held = [];
  for (let page = 1; ; page++) {
    const json = await call("GET", `${path}?page=${page}&per_page=100`);
    held.push(...(json.result ?? []));
    const pages = json.result_info?.total_pages ?? 1;
    if (page >= pages || (json.result ?? []).length === 0) break;
  }
  return held;
}

/**
 * @param {{ base?: string, token: string, accountId: string, names: string[] }} opts
 * @returns {Promise<{ name: string, created: boolean, id: string }[]>}
 */
export async function ensureQueues({ base = API, token, accountId, names }) {
  const call = queuesCall({ base, token });
  const path = `/accounts/${accountId}/queues`;
  const held = await listQueues({ base, token, accountId });
  const out = [];
  for (const name of names) {
    const found = held.find((q) => q.queue_name === name);
    if (found) {
      out.push({ name, created: false, id: found.queue_id });
      continue;
    }
    const made = (await call("POST", path, { queue_name: name })).result;
    out.push({ name, created: true, id: made.queue_id });
  }
  return out;
}

if (import.meta.filename === process.argv[1]) {
  const { values } = parseArgs({ options: { name: { type: "string" }, dlq: { type: "boolean", default: false }, base: { type: "string" } } });
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!values.name || !token || !accountId) {
    console.error("usage: CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node tools/ensure-queue.mjs --name <queue> [--dlq]");
    process.exit(2);
  }
  try {
    const names = values.dlq ? [values.name, `${values.name}-dlq`] : [values.name];
    for (const q of await ensureQueues({ base: values.base, token, accountId, names })) console.log(`${q.created ? "created" : "already held"}: ${q.name} ${q.id}`);
  } catch (err) {
    console.error(`ensure-queue: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  }
}
