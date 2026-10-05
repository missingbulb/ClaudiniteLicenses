#!/usr/bin/env node
// Every key path, locally: the GitHub and Polar stubs, the two Workers and the dev route front under
// one `wrangler dev` over a local D1 the migrations built, then, in order: a signed installation
// webhook the sync Worker writes, an Actions request with a token the stub's OIDC issuer signed, and
// a reconcile requested on the writes queue, as the deploy requests it; then the fleets: a User's
// private repo answered Public with the Personal fleet's checkout, a signed Polar subscription
// delivery, the owner's Personal key and the Polar reconcile, and an Organization answered Public
// with the Organization fleet's checkout, then Organization once it subscribes; then the alerts:
// none on the fresh set, a polar-unreachable incident from a key whose Polar call ran out of time
// reaching D1 and the alert firing at three and clearing an hour later, an account the App no longer
// covers firing and clearing across two reconciles; then what stands in front of the costly calls:
// an unsigned App delivery and an unsigned Polar delivery refused, an Actions body over 16 KiB
// refused before the OIDC issuer is asked, and where the key Worker's D1 read was served; the
// outside probe passing against the local set with all six checks; and last, since it spends the
// address's budget for a minute, the 301st health read in a minute answered 429. Each key is
// verified against the dev chain's roots and must carry the license issuing key. Exits 0 only when
// every key verifies, every stamp moved and every alert came and went. With --serve it stops once
// everything is serving and leaves it up, the stubs included, until interrupted.
//
//   node tools/local-roundtrip.mjs [--chain .dev] [--port 8787] [--timeout-ms 180000] [--serve]
import { execFile, spawn, spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ensureWebhookEndpoint, polarClient, POLAR_VERSION, WEBHOOK_EVENTS } from "../packages/polar/src/index.ts";
import { verifyKey } from "../packages/signing/src/index.ts";
import { IP_LIMIT_PERIOD_S } from "../packages/http/src/index.ts";
import { VERSION_HEADER } from "../packages/version/src/index.ts";
import { DEFAULT_WORLD, startStub } from "./github-stub.mjs";
import { devChain, formatDevVars, parseDevVars } from "./keys.mjs";
import { desiredProducts, readPlans } from "./polar-products.mjs";
import { startPolarStub } from "./polar-stub.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const WORKERS = ["key", "sync"];
const SCRATCH = join(ROOT, ".wrangler/local-roundtrip");
const PERSIST = join(SCRATCH, "state");

const { values } = parseArgs({ options: { chain: { type: "string" }, port: { type: "string" }, "timeout-ms": { type: "string" }, serve: { type: "boolean" } } });
const port = Number(values.port ?? 8787);
const deadline = Date.now() + Number(values["timeout-ms"] ?? 180_000);
const origin = `http://127.0.0.1:${port}`;
// The Workers' outbound calls go to the stub on loopback, never through a proxy.
const env = { ...process.env, WRANGLER_SEND_METRICS: "false", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" };

/** @param {number} ms */
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
/** @param {string} path */
const readJsonc = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8").replace(/^\s*\/\/.*$/gm, ""));

rmSync(SCRATCH, { recursive: true, force: true });
let chainDir = resolve(ROOT, values.chain ?? ".dev");
if (!WORKERS.every((w) => existsSync(join(chainDir, `${w}.dev.vars`)))) {
  chainDir = join(SCRATCH, "chain");
  await devChain(chainDir);
  console.log(`no complete dev chain at ${values.chain ?? ".dev"}; made one in ${chainDir}`);
}
const roots = ["root.pub", "standby.pub"].map((f) => readFileSync(join(chainDir, f), "utf8").trim());
/** @param {string} use */
const keyIdOf = (use) => JSON.parse(Buffer.from(JSON.parse(readFileSync(join(chainDir, `${use}.cert.json`), "utf8")).payload, "base64url").toString("utf8")).keyId;
const kids = { license: keyIdOf("license") };
/** @type {Record<string, Record<string, string>>} */
const vars = Object.fromEntries(WORKERS.map((w) => [w, parseDevVars(readFileSync(join(chainDir, `${w}.dev.vars`), "utf8"))]));

// The default world, plus a private repo on the same account.
const PRIVATE = { id: 1002, name: "acme-private", full_name: "acme-user/acme-private", private: true, default_branch: "main" };
const world = {
  installations: DEFAULT_WORLD.installations.map((inst, i) => (i === 0 ? { ...inst, repos: [...inst.repos, PRIVATE] } : inst)),
};
const stub = await startStub({ world });
const polar = await startPolarStub();
for (const d of desiredProducts(readPlans())) polar.addProduct({ name: d.name, metadata: d.metadata, recurring_interval: d.interval, prices: [d.price] });
const endpoint = await ensureWebhookEndpoint(polarClient({ base: polar.base, token: polar.token, version: POLAR_VERSION }), { url: `${origin}/v1/sync/polar-webhook`, events: WEBHOOK_EVENTS });
if (endpoint.kept) throw new Error("the Polar stub already held an endpoint");
const toPolar = { POLAR_API_BASE: polar.base, POLAR_ACCESS_TOKEN: polar.token };
const toStub = {
  key: { OIDC_ISSUER: stub.base, ...toPolar },
  sync: { GITHUB_API_BASE: stub.base, ...toPolar, POLAR_WEBHOOK_SECRET: endpoint.secret },
};
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
  await polar.close();
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
  await polar.close();
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
  return { status: res.status, text, json, version: res.headers.get(VERSION_HEADER) };
}

/**
 * @param {string} label @param {string} key @param {keyof typeof kids} use @param {number} started
 * @param {Partial<Record<string, unknown>>} [want] payload fields the key must hold
 */
async function verified(label, key, use, started, want = {}) {
  const verdict = await verifyKey(key, { roots, now: new Date() });
  if (!verdict.ok) return fail(`${label}: the key does not verify: ${verdict.reason}`);
  const p = verdict.payload;
  if (p.kid !== kids[use]) return fail(`${label}: signed by ${p.kid}, not the ${use} issuing key ${kids[use]}`);
  for (const [k, v] of Object.entries(want)) {
    const got = /** @type {Record<string, unknown>} */ (p)[k];
    const ok = v instanceof RegExp ? typeof got === "string" && v.test(got) : JSON.stringify(got) === JSON.stringify(v);
    if (!ok) return fail(`${label}: ${k} is ${JSON.stringify(got)}, want ${v instanceof RegExp ? v : JSON.stringify(v)}`);
  }
  const extra = [`state ${p.state}`, `notice ${JSON.stringify(p.notice ?? null)}`, p.checkout_url ? "checkout link" : "", p.portal_url ? "portal link" : ""].filter(Boolean);
  console.log(`${label}: ${p.typ} key verified in ${Math.round(performance.now() - started)} ms, plan ${p.plan}, ${use} key ${p.kid}, repo ${p.repo_id}${extra.length ? `, ${extra.join(", ")}` : ""}`);
  return p;
}

/** Polls the sync Worker's health until `ok` holds, the queue's consumer having run. @param {string} label @param {(h: any) => boolean} ok */
async function healthUntil(label, ok) {
  let h;
  for (;;) {
    h = (await call("/v1/sync/health")).json;
    if (h && ok(h)) return h;
    if (Date.now() > deadline) return fail(`${label}: sync health never matched: ${JSON.stringify(h)}`);
    await sleep(250);
  }
}

/**
 * Requests a reconcile as the deploy does, by a marker on the writes queue, in a second after the
 * last one stamped, and waits for its stamp to reach the request.
 * @param {"reconcile-now" | "polar-reconcile-now"} marker @returns {Promise<{ before: any, after: any }>}
 */
async function requestReconcile(marker) {
  const field = marker === "reconcile-now" ? "last_reconcile_at" : "last_polar_reconcile_at";
  const before = (await call("/v1/sync/health")).json;
  while (Math.floor(Date.now() / 1000) <= (before?.[field] ?? -1)) await sleep(100);
  const at = Math.floor(Date.now() / 1000);
  const pushed = await call("/__dev/writes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ v: 1, kind: "incident", at, marker, detail: "local-roundtrip" }) });
  if (pushed.status !== 202) await fail(`pushing ${marker} answered ${pushed.status}: ${pushed.text}`);
  const after = await healthUntil(`${marker} at ${at}`, (h) => typeof h[field] === "number" && h[field] >= at);
  return { before, after };
}

/** An OIDC token from the stub's issuer for the scheduler on `target`'s default branch. @param {WorldRepoLike} target @param {{ id: number, login: string }} [owner] */
function oidcFor(target, owner = world.installations[0].account) {
  const now = Math.floor(Date.now() / 1000);
  return stub.signOidcToken({
    aud: "claudinite",
    iat: now - 5,
    nbf: now - 5,
    exp: now + 300,
    repository_id: String(target.id),
    repository_owner_id: String(owner.id),
    repository: target.full_name,
    repository_owner: owner.login,
    repository_visibility: target.private ? "private" : "public",
    event_name: "schedule",
    job_workflow_ref: `${target.full_name}/.github/workflows/claudinite-scheduler.yml@refs/heads/${target.default_branch}`,
  });
}
/** @typedef {{ id: number, full_name: string, private: boolean, default_branch: string }} WorldRepoLike */

/** Asks for an Actions key with a token for `target` and verifies it. @param {string} label @param {WorldRepoLike} target @param {Record<string, unknown>} want @param {{ id: number, login: string }} [owner] */
async function actionsKey(label, target, want, owner) {
  const started = performance.now();
  const res = await call("/v1/actions-key", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${oidcFor(target, owner)}` }, body: JSON.stringify({ engine_version: "local-roundtrip" }) });
  if (res.status !== 200 || typeof res.json?.key !== "string") return fail(`${label}: /v1/actions-key answered ${res.status}: ${res.text}`);
  const p = await verified(label, res.json.key, "license", started, want);
  for (const k of ["plan", "state", "notice", "checkout_url", "portal_url"]) {
    if (JSON.stringify(res.json[k] ?? null) !== JSON.stringify(/** @type {Record<string, unknown>} */ (p)[k] ?? null)) return fail(`${label}: the answer's ${k} ${JSON.stringify(res.json[k])} is not the key's ${JSON.stringify(/** @type {Record<string, unknown>} */ (p)[k])}`);
  }
  return p;
}

/** @param {string} event @param {unknown} payload */
function webhook(event, payload) {
  const body = JSON.stringify(payload);
  const signature = "sha256=" + createHmac("sha256", vars.sync.GITHUB_APP_WEBHOOK_SECRET ?? "").update(body).digest("hex");
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
  console.log(`serving every route on ${origin}, the GitHub stub on ${stub.base}, the Polar stub on ${polar.base}; Ctrl-C stops all three`);
  await new Promise((ok) => process.once("SIGINT", ok));
  await shutdown();
  process.exit(0);
}

const inst = stub.world.installations[0];
const repo = inst.repos[0];

// The sync Worker writes the installation's repo, reading its default branch from GitHub.
const installed = await webhook("installation", { action: "created", installation: { id: inst.id, account: inst.account }, repositories: inst.repos.map(({ id, name, full_name, private: p }) => ({ id, name, full_name, private: p })), sender: { id: 3003, login: "acme-dev", type: "User" } });
if (installed.status !== 200) await fail(`the installation webhook answered ${installed.status}: ${installed.text}`);
const afterWebhook = (await call("/v1/sync/health")).json;
if (afterWebhook?.repos !== inst.repos.length || typeof afterWebhook.last_webhook_at !== "number") await fail(`sync health after the webhook: ${JSON.stringify(afterWebhook)}`);
console.log(`installation webhook: sync wrote ${afterWebhook.repos} repo, last_webhook_at ${afterWebhook.last_webhook_at}`);

// Every Worker names its version on every answer, and each health body the same id.
for (const [worker, path, init] of /** @type {const} */ ([["key", "/v1/key/health", undefined], ["sync", "/v1/sync/health", undefined], ["sync", "/github-webhook", { method: "POST", body: "{}" }]])) {
  const res = await call(path, init);
  if (!res.version) await fail(`${worker}: ${path} answered ${res.status} without ${VERSION_HEADER}`);
  if (res.json && "version" in res.json && res.json.version !== res.version) await fail(`${worker}: ${path} names version ${res.json.version} in its body and ${res.version} in its header`);
  console.log(`version: ${worker} ${path} ${res.status}, ${VERSION_HEADER} ${res.version}`);
}

// The Actions path: an OIDC token for a pinned workflow on the default branch the sync Worker read.
const HTTPS = /^https:\/\//;
await actionsKey("actions, public repo, no fleet", repo, { typ: "actions", plan: "public", state: "ok", notice: null, checkout_url: HTTPS, portal_url: null });
const userCheckout = polar.state.checkouts.at(-1)?.body;
if (userCheckout?.metadata?.claudinite_plan !== "personal" || userCheckout.external_customer_id !== String(inst.account.id)) await fail(`a User with no fleet was offered ${JSON.stringify(userCheckout)}`);
console.log(`checkout: a User with no fleet is offered the Personal fleet, products ${userCheckout.products.join(", ")}`);

// The reconcile, requested on the writes queue as the deploy requests it.
const { after: afterReconcile } = await requestReconcile("reconcile-now");
if (afterWebhook.last_reconcile_at !== null || typeof afterReconcile?.last_reconcile_at !== "number" || afterReconcile.repos !== inst.repos.length) {
  await fail(`sync health around the reconcile: before ${JSON.stringify(afterWebhook)}, after ${JSON.stringify(afterReconcile)}`);
}
console.log(`reconcile: last_reconcile_at moved from null to ${afterReconcile.last_reconcile_at}, ${afterReconcile.last_reconcile_corrections} corrections, ${afterReconcile.repos} repo`);

// A private repo is free as well: one repo needs no plan, whatever its visibility.
await actionsKey("actions, private repo, no fleet", PRIVATE, { typ: "actions", plan: "public", state: "ok", notice: null, checkout_url: HTTPS });

// The owner buys Personal; Polar's signed delivery reaches the sync Worker.
const sub = polar.createSubscription({ externalId: String(inst.account.id), plan: "personal", seats: 1 });
const status = await polar.deliver("subscription.created", sub, { endpointId: endpoint.id });
if (status !== 200 && status !== 204) await fail(`the subscription.created delivery answered ${status}`);
const subscribed = await healthUntil("the subscription row", (h) => h.subscriptions === 1 && typeof h.last_polar_webhook_at === "number");
console.log(`polar webhook: subscription.created written, subscriptions ${subscribed.subscriptions}, last_polar_webhook_at ${subscribed.last_polar_webhook_at}`);

// Every repo of the owner now takes the fleet plan, with no seat and no link on the key.
await actionsKey("actions, private repo, Personal", PRIVATE, { typ: "actions", plan: "personal", state: "ok", seats: null, notice: null, checkout_url: null, portal_url: null });
await actionsKey("actions, public repo, Personal", repo, { typ: "actions", plan: "personal", state: "ok", seats: null, notice: null, checkout_url: null, portal_url: null });

// The consumer stamps the version that wrote each batch; no cron has run here, so its stamps are null.
const stamped = await call("/v1/sync/health");
if (!stamped.version || stamped.json?.last_queue_version !== stamped.version) await fail(`sync health's last_queue_version is ${stamped.json?.last_queue_version}, its ${VERSION_HEADER} ${stamped.version}`);
if (stamped.json.last_cron_at !== null || stamped.json.last_cron !== null || stamped.json.last_cron_version !== null) await fail(`sync health reports a cron before any ran: ${JSON.stringify(stamped.json)}`);
if ("seats" in stamped.json) await fail(`sync health still reports seats: ${JSON.stringify(stamped.json)}`);
console.log(`queue: last_queue_version ${stamped.json.last_queue_version}, the sync Worker's own; last_cron_at, last_cron and last_cron_version null before any cron`);

// The Polar reconcile, requested on the writes queue.
const { before: beforePolar, after: afterPolar } = await requestReconcile("polar-reconcile-now");
if (beforePolar?.last_polar_reconcile_at !== null || typeof afterPolar?.last_polar_reconcile_at !== "number" || afterPolar.subscriptions !== 1) {
  await fail(`sync health around the Polar reconcile: before ${JSON.stringify(beforePolar)}, after ${JSON.stringify(afterPolar)}`);
}
console.log(`polar reconcile: last_polar_reconcile_at moved from null to ${afterPolar.last_polar_reconcile_at}, ${afterPolar.last_polar_reconcile_corrections} corrections, ${afterPolar.subscriptions} subscription`);

// An Organization installs the App: with no fleet it is offered the Organization fleet, and once it
// subscribes, with Polar's seats, its repo takes the Organization plan.
const ORG = { id: 1004, name: "acme-org-repo", full_name: "acme-org/acme-org-repo", private: true, default_branch: "main" };
const orgAccount = { id: 2005, login: "acme-org", type: "Organization" };
world.installations.push({ id: 7007, account: orgAccount, repos: [ORG] });
const { after: withOrg } = await requestReconcile("reconcile-now");
if (withOrg.repos !== 3) await fail(`the reconcile with the Organization's installation left: ${JSON.stringify(withOrg)}`);
await actionsKey("actions, Organization repo, no fleet", ORG, { typ: "actions", plan: "public", state: "ok", owner_type: "Organization", checkout_url: HTTPS, portal_url: null }, orgAccount);
const orgCheckout = polar.state.checkouts.at(-1)?.body;
if (orgCheckout?.metadata?.claudinite_plan !== "organization" || orgCheckout.metadata.github_owner_type !== "Organization" || orgCheckout.external_customer_id !== String(orgAccount.id)) await fail(`an Organization with no fleet was offered ${JSON.stringify(orgCheckout)}`);
console.log(`checkout: an Organization with no fleet is offered the Organization fleet, products ${orgCheckout.products.join(", ")}`);
const orgSub = polar.createSubscription({ externalId: String(orgAccount.id), plan: "organization", seats: 3, ownerType: "Organization" });
const orgStatus = await polar.deliver("subscription.created", orgSub, { endpointId: endpoint.id });
if (orgStatus !== 200 && orgStatus !== 204) await fail(`the Organization's subscription.created delivery answered ${orgStatus}`);
await healthUntil("the Organization's subscription row", (h) => h.subscriptions === 2);
await actionsKey("actions, Organization repo, Organization", ORG, { typ: "actions", plan: "organization", state: "ok", seats: null, checkout_url: null, portal_url: null }, orgAccount);

/** The alerts endpoint's answer. */
async function alerts() {
  const res = await call("/v1/sync/alerts");
  if (!Array.isArray(res.json?.alerts)) return fail(`/v1/sync/alerts answered ${res.status} without the alerts shape: ${res.text}`);
  return { status: res.status, ids: /** @type {{ id: string }[]} */ (res.json.alerts).map((a) => a.id).sort() };
}

/** Polls the alerts until `ok` holds. @param {string} label @param {(a: { status: number, ids: string[] }) => boolean} ok */
async function alertsUntil(label, ok) {
  let a;
  for (;;) {
    a = await alerts();
    if (ok(a)) return a;
    if (Date.now() > deadline) return fail(`${label}: the alerts never matched: ${a.status} ${JSON.stringify(a.ids)}`);
    await sleep(250);
  }
}

/** Runs one statement on the local D1 beside the running Workers, as an operator would. @param {string} sql @returns {Promise<any[]>} */
function localSql(sql) {
  return new Promise((ok, no) =>
    execFile("npx", ["wrangler", "d1", "execute", "claudinite-licenses", "--local", "-c", "db/wrangler.jsonc", "--persist-to", PERSIST, "--json", "--command", sql], { cwd: ROOT, env, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) return no(new Error(`wrangler d1 execute failed: ${stderr || err.message}`));
      try {
        ok(JSON.parse(stdout)[0]?.results ?? []);
      } catch {
        no(new Error(`wrangler d1 execute printed no JSON: ${stdout}`));
      }
    }),
  );
}

/** The local D1's polar-unreachable incidents, read directly. */
async function polarIncidents() {
  try {
    return await localSql("SELECT marker, at, detail FROM incidents WHERE marker = 'polar-unreachable' ORDER BY id");
  } catch (err) {
    return fail(String(err));
  }
}

// A fresh set has nothing to say: the stale-reconcile alerts stay silent on a database just reconciled.
const fresh = await alerts();
if (fresh.status !== 200 || fresh.ids.length !== 0) await fail(`the alerts on the fresh set: ${fresh.status} ${JSON.stringify(fresh.ids)}`);
console.log("alerts: 200, none on the fresh set");

// A third account, a User with no fleet, installs the App. Polar holds every answer past the key
// Worker's 3-second deadline, and a link Polar did not give is never cached, so each key there asks
// again: its Public key still verifies, with no checkout link, and its one polar-unreachable
// incident reaches D1 through the queue, below the threshold.
const OTHER = { id: 1003, name: "acme-other-private", full_name: "acme-other/acme-other-private", private: true, default_branch: "main" };
const otherAccount = { id: 2004, login: "acme-other", type: "User" };
world.installations.push({ id: 6006, account: otherAccount, repos: [OTHER] });
const { after: withOther } = await requestReconcile("reconcile-now");
if (withOther.repos !== 4) await fail(`the reconcile with a third installation left: ${JSON.stringify(withOther)}`);
polar.slow(10_000);
const slowKey = () => actionsKey("actions, a third account, Polar too slow", OTHER, { typ: "actions", plan: "public", state: "ok", checkout_url: null, portal_url: null }, otherAccount);
await slowKey();
let incidentRows;
while ((incidentRows = await polarIncidents()).length === 0) {
  if (Date.now() > deadline) await fail("no polar-unreachable incident reached D1");
  await sleep(500);
}
const under = await alerts();
if (under.status !== 200 || under.ids.length !== 0) await fail(`one polar-unreachable must stay under the threshold: ${under.status} ${JSON.stringify(under.ids)}`);
console.log(`incident: ${incidentRows.length} polar-unreachable row in D1 (${incidentRows.map((/** @type {any} */ r) => r.detail).join(", ")}), alerts still 200`);

// Two more such keys put it over the threshold of three in the hour.
await slowKey();
await slowKey();
polar.slow(0);
await alertsUntil("polar-unreachable firing", (a) => a.status === 503 && a.ids.includes("polar-unreachable"));
console.log(`alerts: 503 polar-unreachable after three slow keys, ${(await polarIncidents()).length} incidents`);

// An hour later the window has passed them: aged by hand here, the alert clears on its own.
try {
  await localSql("UPDATE incidents SET at = at - 3700 WHERE marker = 'polar-unreachable'");
} catch (err) {
  await fail(String(err));
}
await alertsUntil("polar-unreachable clearing", (a) => a.status === 200 && a.ids.length === 0);
console.log("alerts: 200 again once the polar-unreachable incidents are an hour old");

// The App leaves the account's repos: Personal needs it on at least one, so the account is uncovered.
const keptRepos = inst.repos;
inst.repos = [];
await requestReconcile("reconcile-now");
// The coverage audit runs after the reconcile's stamp.
await healthUntil("paying_uncovered after the App left", (h) => h.paying_uncovered === 1);
const firing = await alerts();
if (firing.status !== 503 || JSON.stringify(firing.ids) !== JSON.stringify(["paying-uncovered"])) await fail(`the alerts with an uncovered account: ${firing.status} ${JSON.stringify(firing.ids)}`);
console.log("coverage: the App left the account's repos, paying_uncovered 1, alerts 503 paying-uncovered");

// The repos return: the next reconcile covers the account and the endpoint clears.
inst.repos = keptRepos;
await requestReconcile("reconcile-now");
const covered = await healthUntil("paying_uncovered after the repos returned", (h) => h.paying_uncovered === 0);
const cleared = await alerts();
if (covered?.paying_uncovered !== 0 || cleared.status !== 200 || cleared.ids.length !== 0) await fail(`after the repos returned: health ${JSON.stringify(covered)}, alerts ${cleared.status} ${JSON.stringify(cleared.ids)}`);
console.log("coverage: the repos returned, paying_uncovered 0, alerts 200");

// An unsigned Polar post is refused signature-missing and records no incident.
const refusedBefore = (await localSql("SELECT COUNT(*) AS n FROM incidents WHERE marker = 'polar-webhook-refused'").catch((err) => fail(String(err))))[0].n;
const unsigned = await call("/v1/sync/polar-webhook", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
if (unsigned.status !== 401 || unsigned.text.trim() !== "signature-missing" || !unsigned.version) await fail(`the unsigned Polar delivery answered ${unsigned.status} ${unsigned.text}`);
const refusedAfter = (await localSql("SELECT COUNT(*) AS n FROM incidents WHERE marker = 'polar-webhook-refused'").catch((err) => fail(String(err))))[0].n;
if (refusedAfter !== refusedBefore) await fail(`one unsigned post wrote ${refusedAfter - refusedBefore} incidents`);
console.log("polar webhook: an unsigned post refused 401 signature-missing, no incident recorded");

// An unsigned App delivery is refused before anything is written.
const reposBefore = (await call("/v1/sync/health")).json?.repos;
const unsignedApp = await call("/github-webhook", { method: "POST", headers: { "Content-Type": "application/json", "X-GitHub-Event": "installation" }, body: "{}" });
if (unsignedApp.status !== 401 || unsignedApp.text.trim() !== "bad-signature" || !unsignedApp.version) await fail(`the unsigned App delivery answered ${unsignedApp.status} ${unsignedApp.text}`);
if ((await call("/v1/sync/health")).json?.repos !== reposBefore) await fail("an unsigned App delivery changed the repos");
console.log("app webhook: an unsigned post refused 401 bad-signature, nothing written");

// An Actions body over 16 KiB is refused before the OIDC issuer is asked for its keys.
const callsBefore = stub.state.requests.length;
const oversized = await call("/v1/actions-key", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${oidcFor(repo)}` }, body: JSON.stringify({ engine_version: "local-roundtrip", pad: "a".repeat(16 * 1024) }) });
if (oversized.status !== 413 || oversized.json?.refused !== "body-too-large" || stub.state.requests.length !== callsBefore) await fail(`a 16 KiB + 1 Actions body answered ${oversized.status} ${oversized.text} after ${stub.state.requests.length - callsBefore} GitHub calls`);
console.log("body cap: an Actions body over 16 KiB refused 413 body-too-large, the GitHub stub never asked");

const keyHealth = (await call("/v1/key/health")).json;
if (!keyHealth || "fail_open" in keyHealth || "trust_roots" in keyHealth) await fail(`the key health still reports a retired field: ${JSON.stringify(keyHealth)}`);
// The local runtime may leave a field null; the keys must be there.
const servedFields = ["d1_served_by_primary", "d1_served_by_region", "d1_ms"];
if (!servedFields.every((f) => f in keyHealth)) await fail(`the key health's served-by fields: ${JSON.stringify(keyHealth)}`);
console.log(`key health: ${servedFields.map((f) => `${f} ${JSON.stringify(keyHealth[f])}`).join(", ")}`);

// The outside probe, as the deploy runs it, against the local set: no issue, an OIDC token from the
// stub's issuer for a workflow the pin refuses.
const probeOidc = stub.signOidcToken({ ...JSON.parse(Buffer.from(oidcFor(repo).split(".")[1], "base64url").toString("utf8")), job_workflow_ref: `${repo.full_name}/.github/workflows/deploy.yml@refs/heads/${repo.default_branch}` });
const probed = await new Promise((ok) => {
  const child = spawn(process.execPath, ["tools/probe.mjs", "--base", origin, "--oidc-token-env", "PROBE_OIDC", "--json", join(SCRATCH, "probe.json")], { cwd: ROOT, env: { ...env, PROBE_OIDC: probeOidc }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  child.on("close", (code) => ok({ code, out }));
});
const { code: probeCode, out: probeOut } = /** @type {{ code: number | null, out: string }} */ (probed);
if (probeCode !== 0) await fail(`the outside probe exited ${probeCode}:\n${probeOut}`);
const probeChecks = /** @type {{ name: string, version: string | null }[]} */ (JSON.parse(readFileSync(join(SCRATCH, "probe.json"), "utf8")).checks);
if (probeChecks.length !== 6) await fail(`the outside probe ran ${probeChecks.length} checks, want 6:\n${probeOut}`);
const unversioned = probeChecks.filter((c) => !c.version).map((c) => c.name);
if (unversioned.length > 0) await fail(`the outside probe read no version on ${unversioned.join(", ")}`);
console.log(`probe: exit 0, ${probeChecks.length} checks passed, each a Worker answered naming its version (${[...new Set(probeChecks.map((c) => c.version).filter(Boolean))].length} versions)`);

// The per-address cap, last: the 300th health read in a minute answers, the 301st is 429 with the
// version header. Reads already spent this minute count, so the walk stops at the first 429. The
// local limiter's windows are aligned to the wall clock, so a walk that crosses into the next one
// starts counting again: it begins only with ten seconds or more of its window left.
const windowLeftMs = IP_LIMIT_PERIOD_S * 1000 - (Date.now() % (IP_LIMIT_PERIOD_S * 1000));
if (windowLeftMs < 10_000) await sleep(windowLeftMs + 100);
let capped = 0;
for (let i = 1; i <= 400; i++) {
  const res = await call("/v1/key/health");
  if (res.status === 429) {
    if (!res.version || res.json?.refused !== "rate-limited") await fail(`the 429 after ${i} health reads: ${res.text}, version ${res.version}`);
    capped = i;
    break;
  }
  if (res.status !== 200) await fail(`health read ${i} answered ${res.status}: ${res.text}`);
}
if (!capped) await fail("400 health reads in a minute met no 429");
console.log(`ip cap: health read ${capped} answered 429 rate-limited with the version header, every read before it 200`);

await shutdown();
