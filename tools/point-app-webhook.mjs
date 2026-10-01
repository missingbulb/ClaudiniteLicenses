#!/usr/bin/env node
// Points the Claudinite App's webhook at the license server and confirms GitHub holds it.
// Reads GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY (the App's PEM) from the environment.
//
//   node tools/point-app-webhook.mjs --url https://license.claudinite.com/github-webhook
import { parseArgs } from "node:util";
import { appJwt } from "../workers/public-key/src/github.ts";

/**
 * @param {{ base?: string, appId: string, privateKey: string, url: string }} opts
 * @returns {Promise<{ url: string, content_type: string, insecure_ssl: string }>}
 */
export async function pointAppWebhook({ base = "https://api.github.com", appId, privateKey, url }) {
  const jwt = await appJwt(appId, privateKey, Math.floor(Date.now() / 1000));
  const headers = { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "claudinite-licenses-tools" };
  const want = { url, content_type: "json", insecure_ssl: "0" };
  const patch = await fetch(`${base}/app/hook/config`, { method: "PATCH", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(want) });
  if (!patch.ok) throw new Error(`PATCH /app/hook/config answered ${patch.status}: ${await patch.text()}`);
  const get = await fetch(`${base}/app/hook/config`, { headers });
  if (!get.ok) throw new Error(`GET /app/hook/config answered ${get.status}: ${await get.text()}`);
  const held = await get.json();
  for (const [k, v] of Object.entries(want)) {
    if (held[k] !== v) throw new Error(`GitHub holds ${k}=${JSON.stringify(held[k])}, not ${JSON.stringify(v)}: ${JSON.stringify(held)}`);
  }
  return held;
}

if (import.meta.filename === process.argv[1]) {
  const { values } = parseArgs({ options: { url: { type: "string" }, base: { type: "string" } } });
  const { GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY } = process.env;
  if (!values.url || !GITHUB_APP_ID || !GITHUB_APP_PRIVATE_KEY) {
    console.error("usage: GITHUB_APP_ID=... GITHUB_APP_PRIVATE_KEY=... node tools/point-app-webhook.mjs --url <https://...>");
    process.exit(2);
  }
  pointAppWebhook({ base: values.base, appId: GITHUB_APP_ID, privateKey: GITHUB_APP_PRIVATE_KEY, url: values.url }).then(
    (held) => console.log(`GitHub holds: ${JSON.stringify(held)}`),
    (err) => {
      console.error(`point-app-webhook: ${err.message}`);
      process.exit(1);
    },
  );
}
