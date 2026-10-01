#!/usr/bin/env node
// Every key path, locally: the GitHub stub, the four Workers and the dev route front under one
// `wrangler dev` over a local D1 the migrations built, then, in order: a signed installation
// webhook the sync Worker writes, both web dispatches answered with check runs, both desktop
// requests, an Actions request with a token the stub's OIDC issuer signed, and a reconcile. Each
// key is verified against the dev chain's roots and must carry the issuing key its Worker holds.
// Exits 0 only when every path verifies. With --serve it stops once everything is serving and
// leaves it up, the stub included, until interrupted.
//
//   node tools/local-roundtrip.mjs [--chain .dev] [--port 8787] [--timeout-ms 90000] [--serve]
import { spawn, spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { verifyKey } from "../packages/signing/src/index.ts";
import { startStub } from "./github-stub.mjs";
import { devChain, formatDevVars, parseDevVars } from "./keys.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const WORKERS = ["router", "public-key", "key", "sync"];
const SCRATCH = join(ROOT, ".wrangler/local-roundtrip");
const PERSIST = join(SCRATCH, "state");

const { values } = parseArgs({ options: { chain: { type: "string" }, port: { type: "string" }, "timeout-ms": { type: "string" }, serve: { type: "boolean" } } });
const port = Number(values.port ?? 8787);
const deadline = Date.now() + Number(values["timeout-ms"] ?? 90_000);
const origin = `http://127.0.0.1:${port}`;
// The Workers' outbound calls go to the stub on loopback, never through a proxy.
const env = { ...process.env, WRANGLER_SEND_METRICS: "false", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" };

/** @param {number} ms */
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
/** @param {string} path */
const readJsonc = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8").replace(/^\s*\/\/.*$/gm, ""));

rmSync(SCRATCH, { recursive: true, force: true });
let chainDir = resolve(ROOT, values.chain ?? ".dev");
if (!["public-key", "router", "key", "sync"].every((w) => existsSync(join(chainDir, `${w}.dev.vars`)))) {
  chainDir = join(SCRATCH, "chain");
  await devChain(chainDir);
  console.log(`no complete dev chain at ${values.chain ?? ".dev"}; made one in ${chainDir}`);
}
const roots = ["root.pub", "standby.pub"].map((f) => readFileSync(join(chainDir, f), "utf8").trim());
/** @param {string} use */
const keyIdOf = (use) => JSON.parse(Buffer.from(JSON.parse(readFileSync(join(chainDir, `${use}.cert.json`), "utf8")).payload, "base64url").toString("utf8")).keyId;
const kids = { license: keyIdOf("license"), "license-public": keyIdOf("license-public") };
/** @type {Record<string, Record<string, string>>} */
const vars = Object.fromEntries(WORKERS.map((w) => [w, parseDevVars(readFileSync(join(chainDir, `${w}.dev.vars`), "utf8"))]));

const stub = await startStub();
const toStub = { "public-key": { GITHUB_API_BASE: stub.base }, key: { GITHUB_API_BASE: stub.base, GITHUB_WEB_BASE: stub.base, OIDC_ISSUER: stub.base }, sync: { GITHUB_API_BASE: stub.base } };
for (const w of WORKERS) writeFileSync(join(ROOT, `workers/${w}/.dev.vars`), formatDevVars({ ...vars[w], ...(toStub[/** @type {keyof typeof toStub} */ (w)] ?? {}) }), { mode: 0o600 });
const routes = WORKERS.flatMap((w) => {
  const config = readJsonc(`workers/${w}/wrangler.jsonc`);
  return (config.routes ?? []).map((/** @type {{ pattern: string }} */ r) => ({ path: r.pattern.slice(r.pattern.indexOf("/")), service: config.name }));
});
writeFileSync(join(ROOT, "tools/dev-routes/.dev.vars"), formatDevVars({ DEV_ROUTES: JSON.stringify(routes) }), { mode: 0o600 });

const migrate = spawnSync("npx", ["wrangler", "d1", "migrations", "apply", "claudinite-licenses", "--local", "-c", "db/wrangler.jsonc", "--persist-to", PERSIST], { cwd: ROOT, env, encoding: "utf8" });
if (migrate.status !== 0) {
  console.error(`local-roundtrip: the local D1 migrations failed\n${migrate.stdout}${migrate.stderr}`);
  await stub.close();
  process.exit(1);
}

const configs = ["tools/dev-routes", ...WORKERS.map((w) => `workers/${w}`)].flatMap((d) => ["-c", `${d}/wrangler.jsonc`]);
const wrangler = spawn("npx", ["wrangler", "dev", ...configs, "--persist-to", PERSIST, "--ip", "127.0.0.1", "--port", String(port), "--show-interactive-dev-session=false"], {
  cwd: ROOT,
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
  env,
});
let wranglerLog = "";
wrangler.stdout.on("data", (c) => (wranglerLog += c));
wrangler.stderr.on("data", (c) => (wranglerLog += c));

async function shutdown() {
  try {
    if (wrangler.pid) process.kill(-wrangler.pid, "SIGTERM");
  } catch {
    // already gone
  }
  await stub.close();
  for (const d of ["tools/dev-routes", ...WORKERS.map((w) => `workers/${w}`)]) rmSync(join(ROOT, d, ".dev.vars"), { force: true });
  rmSync(SCRATCH, { recursive: true, force: true });
}

/** @param {string} message @returns {Promise<never>} */
async function fail(message) {
  console.error(`local-roundtrip: ${message}`);
  console.error("--- wrangler dev output ---\n" + wranglerLog.slice(-6000));
  await shutdown();
  process.exit(1);
}

/** @param {string} path @param {RequestInit} [init] */
async function call(path, init) {
  const res = await fetch(`${origin}${path}`, init);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, text, json };
}

/** @param {string} label @param {string} key @param {keyof typeof kids} use @param {number} started */
async function verified(label, key, use, started) {
  const verdict = await verifyKey(key, { roots, now: new Date() });
  if (!verdict.ok) return fail(`${label}: the key does not verify: ${verdict.reason}`);
  const p = verdict.payload;
  if (p.kid !== kids[use]) return fail(`${label}: signed by ${p.kid}, not the ${use} issuing key ${kids[use]}`);
  console.log(`${label}: ${p.typ} key verified in ${Math.round(performance.now() - started)} ms, plan ${p.plan}, ${use} key ${p.kid}, repo ${p.repo_id}${"user_id" in p ? `, user ${p.user_id}` : ""}`);
}

/** @param {string} event @param {unknown} payload */
function webhook(event, payload) {
  const body = JSON.stringify(payload);
  const signature = "sha256=" + createHmac("sha256", vars.router.GITHUB_APP_WEBHOOK_SECRET ?? "").update(body).digest("hex");
  return call("/github-webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-GitHub-Event": event, "X-GitHub-Delivery": `local-${randomBytes(8).toString("hex")}`, "X-Hub-Signature-256": signature },
    body,
  });
}

for (;;) {
  if (Date.now() > deadline) await fail("wrangler dev did not start serving in time");
  if (wrangler.exitCode !== null) await fail(`wrangler dev exited with ${wrangler.exitCode}`);
  try {
    if ((await call("/v1/sync/health")).status === 200) break;
  } catch {
    // not listening yet
  }
  await sleep(250);
}

if (values.serve) {
  console.log(`serving every route on ${origin}, the GitHub stub on ${stub.base}; Ctrl-C stops both`);
  await new Promise((ok) => process.once("SIGINT", ok));
  await shutdown();
  process.exit(0);
}

const inst = stub.world.installations[0];
const repo = inst.repos[0];
const [userToken, user] = Object.entries(stub.world.users)[0];

// The sync Worker writes the installation's repo, reading its default branch from GitHub.
const installed = await webhook("installation", { action: "created", installation: { id: inst.id, account: inst.account }, repositories: inst.repos.map(({ id, name, full_name, private: p }) => ({ id, name, full_name, private: p })), sender: { id: user.id, login: user.login, type: "User" } });
if (installed.status !== 200) await fail(`the installation webhook answered ${installed.status}: ${installed.text}`);
const afterWebhook = (await call("/v1/sync/health")).json;
if (afterWebhook?.repos !== inst.repos.length || typeof afterWebhook.last_webhook_at !== "number") await fail(`sync health after the webhook: ${JSON.stringify(afterWebhook)}`);
console.log(`installation webhook: sync wrote ${afterWebhook.repos} repo, last_webhook_at ${afterWebhook.last_webhook_at}`);

// The web path, both Workers: a dispatch through the router, answered with a check run.
for (const [action, use] of /** @type {const} */ ([["claudinite-key", "license"], ["claudinite-key-public", "license-public"]])) {
  const nonce = randomBytes(16).toString("hex");
  const started = performance.now();
  const delivered = await webhook("repository_dispatch", {
    action,
    repository: { id: repo.id, name: repo.name, full_name: repo.full_name, private: repo.private, owner: inst.account },
    installation: { id: inst.id },
    sender: { id: user.id, login: user.login, type: "User" },
    client_payload: { nonce, engine_version: "local-roundtrip", head: HEAD },
  });
  if (delivered.status !== 201) await fail(`${action}: the router answered ${delivered.status}: ${delivered.text}`);
  let run;
  while (!(run = (stub.state.checkRuns[HEAD] ?? []).find((r) => r.external_id === nonce))) {
    if (Date.now() > deadline) await fail(`${action}: no check run carries the nonce`);
    await sleep(50);
  }
  await verified(`web ${action}`, run?.output?.text ?? "", use, started);
}

// The desktop path, both Workers: the App user token and the repo, read from GitHub as the caller.
for (const [path, use] of /** @type {const} */ ([["/v1/session-key", "license"], ["/v1/public/session-key", "license-public"]])) {
  const started = performance.now();
  const res = await call(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${userToken}` },
    body: JSON.stringify({ repo: repo.full_name, nonce: randomBytes(16).toString("hex"), engine_version: "local-roundtrip" }),
  });
  if (res.status !== 200 || typeof res.json?.key !== "string") await fail(`${path} answered ${res.status}: ${res.text}`);
  await verified(`desktop ${path}`, res.json.key, use, started);
}

// The Actions path: an OIDC token for a pinned workflow on the default branch the sync Worker read.
{
  const now = Math.floor(Date.now() / 1000);
  const token = stub.signOidcToken({
    aud: "claudinite",
    iat: now - 5,
    nbf: now - 5,
    exp: now + 300,
    repository_id: String(repo.id),
    repository_owner_id: String(inst.account.id),
    repository: repo.full_name,
    repository_owner: inst.account.login,
    repository_visibility: repo.private ? "private" : "public",
    event_name: "schedule",
    job_workflow_ref: `${repo.full_name}/.github/workflows/claudinite-scheduler.yml@refs/heads/${repo.default_branch}`,
  });
  const started = performance.now();
  const res = await call("/v1/actions-key", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ engine_version: "local-roundtrip" }) });
  if (res.status !== 200 || typeof res.json?.key !== "string") await fail(`/v1/actions-key answered ${res.status}: ${res.text}`);
  await verified("actions /v1/actions-key", res.json.key, "license", started);
}

// The reconcile, with the admin token the dev chain made.
const reconciled = await call("/v1/sync/reconcile", { method: "POST", headers: { Authorization: `Bearer ${vars.sync.SYNC_ADMIN_TOKEN}` } });
if (reconciled.status !== 200) await fail(`the reconcile answered ${reconciled.status}: ${reconciled.text}`);
const afterReconcile = (await call("/v1/sync/health")).json;
if (afterWebhook.last_reconcile_at !== null || typeof afterReconcile?.last_reconcile_at !== "number" || afterReconcile.repos !== inst.repos.length) {
  await fail(`sync health around the reconcile: before ${JSON.stringify(afterWebhook)}, after ${JSON.stringify(afterReconcile)}`);
}
console.log(`reconcile: last_reconcile_at moved from null to ${afterReconcile.last_reconcile_at}, ${afterReconcile.last_reconcile_corrections} corrections, ${afterReconcile.repos} repo`);

await shutdown();
