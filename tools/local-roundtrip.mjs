#!/usr/bin/env node
// The whole web-session key path, locally: the GitHub stub, both Workers under one `wrangler dev`,
// a signed repository_dispatch webhook posted to the router, then the stub's check runs polled for
// the nonce and the key verified against the dev chain's roots. Exits 0 only when it verifies.
//
//   node tools/local-roundtrip.mjs [--chain .dev] [--port 8787] [--timeout-ms 60000]
import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { verifyKey } from "../packages/signing/src/index.ts";
import { startStub } from "./github-stub.mjs";
import { devChain, formatDevVars, parseDevVars } from "./keys.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const HEAD = "0123456789abcdef0123456789abcdef01234567";

const { values } = parseArgs({ options: { chain: { type: "string" }, port: { type: "string" }, "timeout-ms": { type: "string" } } });
const port = Number(values.port ?? 8787);
const timeoutMs = Number(values["timeout-ms"] ?? 60_000);
const deadline = Date.now() + timeoutMs;

/** @param {number} ms */
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

let chainDir = resolve(ROOT, values.chain ?? ".dev");
if (!existsSync(join(chainDir, "public-key.dev.vars"))) {
  chainDir = mkdtempSync(join(tmpdir(), "claudinite-dev-chain-"));
  await devChain(chainDir);
  console.log(`no dev chain at ${values.chain ?? ".dev"}; made one in ${chainDir}`);
}
const roots = ["root.pub", "standby.pub"].map((f) => readFileSync(join(chainDir, f), "utf8").trim());
const publicKeyVars = parseDevVars(readFileSync(join(chainDir, "public-key.dev.vars"), "utf8"));
const routerVars = parseDevVars(readFileSync(join(chainDir, "router.dev.vars"), "utf8"));

const stub = await startStub();
writeFileSync(join(ROOT, "workers/public-key/.dev.vars"), formatDevVars({ ...publicKeyVars, GITHUB_API_BASE: stub.base }), { mode: 0o600 });
writeFileSync(join(ROOT, "workers/router/.dev.vars"), formatDevVars(routerVars), { mode: 0o600 });

const wrangler = spawn(
  "npx",
  ["wrangler", "dev", "-c", "workers/router/wrangler.jsonc", "-c", "workers/public-key/wrangler.jsonc", "--ip", "127.0.0.1", "--port", String(port), "--show-interactive-dev-session=false"],
  {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    // The Workers' outbound calls go to the stub on loopback, never through a proxy.
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" },
  },
);
let wranglerLog = "";
wrangler.stdout.on("data", (c) => (wranglerLog += c));
wrangler.stderr.on("data", (c) => (wranglerLog += c));

/** @param {string} message */
async function fail(message) {
  console.error(`local-roundtrip: ${message}`);
  console.error("--- wrangler dev output ---\n" + wranglerLog.slice(-4000));
  await shutdown();
  process.exit(1);
}

async function shutdown() {
  try {
    if (wrangler.pid) process.kill(-wrangler.pid, "SIGTERM");
  } catch {
    // already gone
  }
  await stub.close();
}

const router = `http://127.0.0.1:${port}/github-webhook`;
for (;;) {
  if (Date.now() > deadline) await fail("wrangler dev did not start serving in time");
  if (wrangler.exitCode !== null) await fail(`wrangler dev exited with ${wrangler.exitCode}`);
  try {
    const res = await fetch(router);
    if (res.status === 404) break;
  } catch {
    // not listening yet
  }
  await sleep(250);
}

const nonce = randomBytes(16).toString("hex");
const body = JSON.stringify({
  action: "claudinite-key-public",
  repository: { id: 1001, name: "acme-repo", full_name: "acme-user/acme-repo", private: false, owner: { id: 2002, login: "acme-user", type: "User" } },
  installation: { id: 5005 },
  sender: { id: 3003, login: "acme-dev", type: "User" },
  client_payload: { nonce, engine_version: "local-roundtrip", head: HEAD },
});
const signature = "sha256=" + createHmac("sha256", routerVars.GITHUB_APP_WEBHOOK_SECRET ?? "").update(body).digest("hex");

const started = performance.now();
const delivered = await fetch(router, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-GitHub-Event": "repository_dispatch", "X-GitHub-Delivery": `local-${nonce}`, "X-Hub-Signature-256": signature },
  body,
});
const deliveredText = await delivered.text();
if (delivered.status !== 201) await fail(`the router answered ${delivered.status}: ${deliveredText}`);

for (;;) {
  if (Date.now() > deadline) await fail("no check run with the nonce appeared in time");
  const res = await fetch(`${stub.base}/repos/acme-user/acme-repo/commits/${HEAD}/check-runs?check_name=Claudinite%20key`);
  const { check_runs } = await res.json();
  const run = check_runs.find((/** @type {{ external_id: string }} */ r) => r.external_id === nonce);
  if (run) {
    const elapsed = Math.round(performance.now() - started);
    const verdict = await verifyKey(run.output?.text ?? "", { roots, now: new Date() });
    if (!verdict.ok) await fail(`the check run's key does not verify: ${verdict.reason}`);
    console.log(`key verified against the dev root in ${elapsed} ms (dispatch to verified key): plan ${verdict.ok && verdict.payload.plan}, user ${verdict.ok && verdict.payload.user_id}`);
    break;
  }
  await sleep(100);
}
await shutdown();
process.exit(0);
