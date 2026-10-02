#!/usr/bin/env node
// Pushes one incident message onto a Cloudflare Queue by the queue's name, through the Queues REST
// API, so the deploy can prove the writes queue's consumer, and request a reconcile from it, from
// outside without a producer binding. Reads CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID from the environment, and prints
// the message it sent as its one JSON line.
//
//   node tools/push-queue-message.mjs --queue claudinite-licenses-writes --marker deploy-read-back --detail "<text>" [--at <unix s>]
//
// Cloudflare's API reference, Queues > Messages > Push Message (read 2026-10-02):
// `POST /accounts/{account_id}/queues/{queue_id}/messages`, accepted permissions Queues Write or
// Workers Scripts Write, body `{ body, content_type: "json", delay_seconds? }` (or `"text"` with a
// string body), answering `{ success, errors, messages, result: { metadata: { metrics } } }`.
import { parseArgs } from "node:util";
import { isWriteMessage } from "../packages/licensing/src/index.ts";
import { listQueues, queuesCall } from "./ensure-queue.mjs";

/**
 * @param {{ base?: string, token: string, accountId: string, queue: string, body: unknown }} opts
 * @returns {Promise<{ queue_id: string, metrics: unknown }>}
 */
export async function pushQueueMessage({ base, token, accountId, queue, body }) {
  const held = await listQueues({ base, token, accountId });
  const found = held.find((q) => q.queue_name === queue);
  if (!found) throw new Error(`no queue named ${queue} on this account; it holds: ${held.map((q) => q.queue_name).join(", ") || "none"}`);
  const json = await queuesCall({ base, token })("POST", `/accounts/${accountId}/queues/${found.queue_id}/messages`, { body, content_type: "json" });
  return { queue_id: found.queue_id, metrics: json.result?.metadata?.metrics ?? null };
}

/** @returns {Promise<number>} the exit status */
async function main() {
  const { values } = parseArgs({ options: { queue: { type: "string" }, marker: { type: "string" }, detail: { type: "string" }, at: { type: "string" }, base: { type: "string" } } });
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!values.queue || !values.marker || !token || !accountId) {
    console.error('usage: CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node tools/push-queue-message.mjs --queue <name> --marker <marker> [--detail "<text>"] [--at <unix s>]');
    return 2;
  }
  const message = { v: 1, kind: "incident", at: values.at === undefined ? Math.floor(Date.now() / 1000) : Number(values.at), marker: values.marker, ...(values.detail === undefined ? {} : { detail: values.detail }) };
  if (!isWriteMessage(message)) {
    console.error(`push-queue-message: the consumer would refuse ${JSON.stringify(message)}: the marker must be one of INCIDENT_MARKERS, the detail at most 200 characters and --at whole seconds`);
    return 2;
  }
  try {
    await pushQueueMessage({ base: values.base, token, accountId, queue: values.queue, body: message });
  } catch (err) {
    console.error(`push-queue-message: ${err instanceof Error ? err.message : err}`);
    return 1;
  }
  console.log(JSON.stringify(message));
  return 0;
}

if (import.meta.filename === process.argv[1]) process.exitCode = await main();
