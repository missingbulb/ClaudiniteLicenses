#!/usr/bin/env node
// Makes the Polar organization deliver every event the sync Worker reads to one endpoint at --url.
// Polar returns an endpoint's secret only in its create answer, so a new endpoint's secret is
// written to --secret-out (mode 0600) at once and never printed; an endpoint kept as found writes
// no file. --rotate replaces the endpoint, and with it the secret. Reads POLAR_API_BASE and
// POLAR_ACCESS_TOKEN.
//
//   node tools/ensure-polar-webhook.mjs --url <https url> --secret-out <file> [--rotate]
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ensureWebhookEndpoint, polarClient, POLAR_VERSION, WEBHOOK_EVENTS } from "../packages/polar/src/index.ts";

/**
 * @param {{ base: string, token: string, url: string, secretOut: string, rotate?: boolean }} opts
 * @returns {Promise<{ id: string, kept: boolean }>}
 */
export async function ensurePolarWebhook({ base, token, url, secretOut, rotate = false }) {
  const client = polarClient({ base, token, version: POLAR_VERSION, retries: 3, userAgent: "claudinite-licenses-deploy" });
  const got = await ensureWebhookEndpoint(client, { url, events: WEBHOOK_EVENTS, rotate });
  if (got.kept === false) writeFileSync(secretOut, got.secret, { mode: 0o600 });
  return { id: got.id, kept: got.kept };
}

if (import.meta.filename === process.argv[1]) {
  const { values } = parseArgs({ options: { url: { type: "string" }, "secret-out": { type: "string" }, rotate: { type: "boolean", default: false } } });
  const base = process.env.POLAR_API_BASE;
  const token = process.env.POLAR_ACCESS_TOKEN;
  if (!values.url || !values["secret-out"] || !base || !token) {
    console.error("usage: POLAR_API_BASE=... POLAR_ACCESS_TOKEN=... node tools/ensure-polar-webhook.mjs --url <https url> --secret-out <file> [--rotate]");
    process.exit(2);
  }
  try {
    const { id, kept } = await ensurePolarWebhook({ base, token, url: values.url, secretOut: values["secret-out"], rotate: values.rotate });
    console.log(`${kept ? "kept" : "created"}: ${id} for ${values.url}${kept ? "" : `; secret in ${values["secret-out"]}`}`);
  } catch (err) {
    console.error(`ensure-polar-webhook: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  }
}
