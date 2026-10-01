#!/usr/bin/env node
// Every key path, locally: the GitHub and Polar stubs, the four Workers and the dev route front
// under one `wrangler dev` over a local D1 the migrations built, then, in order: a signed
// installation webhook the sync Worker writes, both web dispatches answered with check runs, both
// desktop requests, an Actions request with a token the stub's OIDC issuer signed, and a reconcile;
// then the paid path on a private repo: a grace key with its checkout link, a signed Polar
// subscription delivery, seats taken through the writes queue up to the headroom and past it, the
// Actions key, an item grant and the Polar reconcile; then the alerts: none on the fresh set, an
// incident queued from a key whose Polar call ran out of time, the polar-unreachable alert firing
// once three such keys have been asked for and clearing once those incidents are an hour old, an
// account the App no longer covers firing and clearing across two reconciles, and the outside probe
// passing against the local set. Each key is verified against the dev chain's roots and must carry
// the issuing key its Worker holds. Exits 0 only when every key and the grant verify, every stamp
// moved and every alert came and went. With --serve it stops once everything is serving and leaves
// it up, the stubs included, until interrupted.
//
//   node tools/local-roundtrip.mjs [--chain .dev] [--port 8787] [--timeout-ms 180000] [--serve]
import { execFile, spawn, spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ensureWebhookEndpoint, polarClient, POLAR_VERSION, WEBHOOK_EVENTS } from "../packages/polar/src/index.ts";
import { verifyKey } from "../packages/signing/src/index.ts";
import { DEFAULT_WORLD, startStub } from "./github-stub.mjs";
import { devChain, formatDevVars, parseDevVars } from "./keys.mjs";
import { desiredProducts, readPlans } from "./polar-products.mjs";
import { startPolarStub } from "./polar-stub.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const WORKERS = ["router", "public-key", "key", "sync"];
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

// The default world, plus a private repo on the same account and four users who each take a seat.
const PRIVATE = { id: 1002, name: "acme-private", full_name: "acme-user/acme-private", private: true, default_branch: "main" };
const SEAT_USERS = ["a", "b", "c", "d"].map((x, i) => [`ghu_acme_${x}`, { id: 3101 + i, login: `acme-${x}`, type: "User" }]);
const world = {
  installations: DEFAULT_WORLD.installations.map((inst, i) => (i === 0 ? { ...inst, repos: [...inst.repos, PRIVATE] } : inst)),
  users: { ...DEFAULT_WORLD.users, ...Object.fromEntries(SEAT_USERS) },
};
const stub = await startStub({ world });
const polar = await startPolarStub();
for (const d of desiredProducts(readPlans())) polar.addProduct({ name: d.name, metadata: d.metadata, recurring_interval: d.interval, prices: [d.price] });
const endpoint = await ensureWebhookEndpoint(polarClient({ base: polar.base, token: polar.token, version: POLAR_VERSION }), { url: `${origin}/v1/sync/polar-webhook`, events: WEBHOOK_EVENTS });
if (endpoint.kept) throw new Error("the Polar stub already held an endpoint");
const toPolar = { POLAR_API_BASE: polar.base, POLAR_ACCESS_TOKEN: polar.token };
const toStub = {
  "public-key": { GITHUB_API_BASE: stub.base },
  key: { GITHUB_API_BASE: stub.base, GITHUB_WEB_BASE: stub.base, OIDC_ISSUER: stub.base, ...toPolar, TRUST_ROOTS: JSON.stringify(roots) },
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
  return { status: res.status, text, json };
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
  const extra = [p.state !== "ok" || p.seats ? `state ${p.state}` : "", p.seats ? `seats ${p.seats.counted}/${p.seats.paid}+${p.seats.headroom}` : "", p.checkout_url ? "checkout link" : "", p.portal_url ? "portal link" : "", p.issue ? `issue ${p.issue}` : ""].filter(Boolean);
  console.log(`${label}: ${p.typ} key verified in ${Math.round(performance.now() - started)} ms, plan ${p.plan}, ${use} key ${p.kid}, repo ${p.repo_id}${"user_id" in p ? `, user ${p.user_id}` : ""}${extra.length ? `, ${extra.join(", ")}` : ""}`);
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

/** @param {string} label @param {string} token @param {number} repoId @param {Record<string, unknown>} want */
async function desktopKey(label, token, repoId, want) {
  const target = world.installations.flatMap((i) => i.repos).find((r) => r.id === repoId);
  const started = performance.now();
  const res = await call("/v1/session-key", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ repo: target?.full_name, nonce: randomBytes(16).toString("hex"), engine_version: "local-roundtrip" }),
  });
  if (res.status !== 200 || typeof res.json?.key !== "string") return fail(`${label}: /v1/session-key answered ${res.status}: ${res.text}`);
  return verified(label, res.json.key, "license", started, want);
}

/** An OIDC token from the stub's issuer for the scheduler on `target`'s default branch. @param {WorldRepoLike} target */
function oidcFor(target) {
  const now = Math.floor(Date.now() / 1000);
  const inst = world.installations[0];
  return stub.signOidcToken({
    aud: "claudinite",
    iat: now - 5,
    nbf: now - 5,
    exp: now + 300,
    repository_id: String(target.id),
    repository_owner_id: String(inst.account.id),
    repository: target.full_name,
    repository_owner: inst.account.login,
    repository_visibility: target.private ? "private" : "public",
    event_name: "schedule",
    job_workflow_ref: `${target.full_name}/.github/workflows/claudinite-scheduler.yml@refs/heads/${target.default_branch}`,
  });
}
/** @typedef {{ id: number, full_name: string, private: boolean, default_branch: string }} WorldRepoLike */

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
  console.log(`serving every route on ${origin}, the GitHub stub on ${stub.base}, the Polar stub on ${polar.base}; Ctrl-C stops all three`);
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
  const token = oidcFor(repo);
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

// The paid path, on the private repo. Seat rows are counted across licensees: user A takes one under
// the repo while it has no plan, then each of A to D one under the owner once it pays.
const [[tokenA], [tokenB], [tokenC], [tokenD]] = SEAT_USERS;
const checkoutLink = new RegExp(`^${polar.linkOrigin}/checkout/`);

// No plan: a Private repo key in grace, with the checkout link, and the grace clock started.
await desktopKey("private repo, no plan, user A", tokenA, PRIVATE.id, { plan: "private-repo", state: "grace", seats: { paid: 0, counted: 1, headroom: 0 }, checkout_url: checkoutLink, portal_url: null });
const graceSeat = await healthUntil("the first seat", (h) => h.seats === 1 && typeof h.last_queue_at === "number");
console.log(`queue: seats ${graceSeat.seats}, last_queue_at ${graceSeat.last_queue_at}, queue_lag_s ${graceSeat.queue_lag_s}`);

// The owner buys Personal for 2 seats; Polar's signed delivery reaches the sync Worker.
const sub = polar.createSubscription({ externalId: String(inst.account.id), plan: "personal", seats: 2 });
const status = await polar.deliver("subscription.created", sub, { endpointId: endpoint.id });
if (status !== 200 && status !== 204) await fail(`the subscription.created delivery answered ${status}`);
const subscribed = await healthUntil("the subscription row", (h) => h.subscriptions === 1 && typeof h.last_polar_webhook_at === "number");
console.log(`polar webhook: subscription.created written, subscriptions ${subscribed.subscriptions}, last_polar_webhook_at ${subscribed.last_polar_webhook_at}`);

// Two users within the 2 paid seats: ok, and A's key asks for the grace clock to be cleared.
// Each key waits for the one before it to be consumed, since a seat counts once the queue writes it.
await desktopKey("personal, user A", tokenA, PRIVATE.id, { plan: "personal", state: "ok", seats: { paid: 2, counted: 1, headroom: 1 } });
await healthUntil("the seat for A under the owner", (h) => h.seats === 2);
await desktopKey("personal, user B", tokenB, PRIVATE.id, { plan: "personal", state: "ok", seats: { paid: 2, counted: 2, headroom: 1 } });
const seated = await healthUntil("the seat for B", (h) => h.seats === 3);
console.log(`queue: seats ${seated.seats} (A under the repo, A and B under the owner)`);

// The third user is within the headroom: ok, with the notice and the links.
await desktopKey("personal, user C", tokenC, PRIVATE.id, { plan: "personal", state: "ok", seats: { paid: 2, counted: 3, headroom: 1 }, checkout_url: checkoutLink, portal_url: new RegExp(`^${polar.linkOrigin}/portal/`) });
await healthUntil("the seat for C", (h) => h.seats === 4);

// The fourth is beyond it. The grace started without a plan was spent less than 30 days ago, so no
// new grace starts: the seated keep their seats and D is refused one.
await desktopKey("personal, user D", tokenD, PRIVATE.id, { plan: "personal", state: "degraded", features: [], seats: { paid: 2, counted: 4, headroom: 1 } });
await healthUntil("the seat for D", (h) => h.seats === 5);

// The Actions key takes its licensee's state; an item grant carries it with the work item's issue.
const actionsStarted = performance.now();
const actions = await call("/v1/actions-key", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${oidcFor(PRIVATE)}` }, body: JSON.stringify({ engine_version: "local-roundtrip" }) });
if (actions.status !== 200 || typeof actions.json?.key !== "string") await fail(`/v1/actions-key for the private repo answered ${actions.status}: ${actions.text}`);
await verified("actions, private repo", actions.json.key, "license", actionsStarted, { typ: "actions", plan: "personal", state: "degraded" });
const grantStarted = performance.now();
const granted = await call("/v1/item-grant", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${actions.json.key}` }, body: JSON.stringify({ issue: 42 }) });
if (granted.status !== 200 || typeof granted.json?.grant !== "string") await fail(`/v1/item-grant answered ${granted.status}: ${granted.text}`);
await verified("item grant", granted.json.grant, "license", grantStarted, { typ: "grant", issue: 42, plan: "personal", state: "degraded" });

// The Polar reconcile, with the admin token.
const beforePolar = (await call("/v1/sync/health")).json;
const polarReconciled = await call("/v1/sync/polar-reconcile", { method: "POST", headers: { Authorization: `Bearer ${vars.sync.SYNC_ADMIN_TOKEN}` } });
if (polarReconciled.status !== 200) await fail(`the Polar reconcile answered ${polarReconciled.status}: ${polarReconciled.text}`);
const afterPolar = (await call("/v1/sync/health")).json;
if (beforePolar?.last_polar_reconcile_at !== null || typeof afterPolar?.last_polar_reconcile_at !== "number" || afterPolar.subscriptions !== 1) {
  await fail(`sync health around the Polar reconcile: before ${JSON.stringify(beforePolar)}, after ${JSON.stringify(afterPolar)}`);
}
console.log(`polar reconcile: last_polar_reconcile_at moved from null to ${afterPolar.last_polar_reconcile_at}, ${afterPolar.last_polar_reconcile_corrections} corrections, ${afterPolar.subscriptions} subscription`);

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

// A second account installs the App on a private repo it has no plan for; the reconcile writes it.
// Polar holds every answer past the key Worker's 3-second deadline, and a link Polar did not give is
// never cached, so each key there asks again: its grace key still verifies, with no checkout link,
// and its one polar-unreachable incident reaches D1 through the queue, below the threshold.
const OTHER = { id: 1003, name: "acme-other-private", full_name: "acme-other/acme-other-private", private: true, default_branch: "main" };
world.installations.push({ id: 6006, account: { id: 2004, login: "acme-other", type: "User" }, repos: [OTHER] });
const withOther = await call("/v1/sync/reconcile", { method: "POST", headers: { Authorization: `Bearer ${vars.sync.SYNC_ADMIN_TOKEN}` } });
if (withOther.status !== 200 || withOther.json?.repos !== 3) await fail(`the reconcile with a second installation answered ${withOther.status}: ${withOther.text}`);
polar.slow(10_000);
const slowKey = () => desktopKey("private repo of a second account, Polar too slow", tokenA, OTHER.id, { plan: "private-repo", state: "grace", checkout_url: null, portal_url: null });
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
const dropped = await call("/v1/sync/reconcile", { method: "POST", headers: { Authorization: `Bearer ${vars.sync.SYNC_ADMIN_TOKEN}` } });
if (dropped.status !== 200) await fail(`the reconcile without the repos answered ${dropped.status}: ${dropped.text}`);
const uncovered = (await call("/v1/sync/health")).json;
if (uncovered?.paying_uncovered !== 1) await fail(`paying_uncovered after the App left: ${JSON.stringify(uncovered)}`);
const firing = await alerts();
if (firing.status !== 503 || JSON.stringify(firing.ids) !== JSON.stringify(["paying-uncovered"])) await fail(`the alerts with an uncovered account: ${firing.status} ${JSON.stringify(firing.ids)}`);
console.log("coverage: the App left the account's repos, paying_uncovered 1, alerts 503 paying-uncovered");

// The repos return: the next reconcile covers the account and the endpoint clears.
inst.repos = keptRepos;
const restored = await call("/v1/sync/reconcile", { method: "POST", headers: { Authorization: `Bearer ${vars.sync.SYNC_ADMIN_TOKEN}` } });
if (restored.status !== 200) await fail(`the reconcile with the repos back answered ${restored.status}: ${restored.text}`);
const covered = (await call("/v1/sync/health")).json;
const cleared = await alerts();
if (covered?.paying_uncovered !== 0 || cleared.status !== 200 || cleared.ids.length !== 0) await fail(`after the repos returned: health ${JSON.stringify(covered)}, alerts ${cleared.status} ${JSON.stringify(cleared.ids)}`);
console.log("coverage: the repos returned, paying_uncovered 0, alerts 200");

// The outside probe, as the schedule runs it, against the local set: no issue, no OIDC token.
const probed = await new Promise((ok) => {
  const child = spawn(process.execPath, ["tools/probe.mjs", "--base", origin], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  child.on("close", (code) => ok({ code, out }));
});
const { code: probeCode, out: probeOut } = /** @type {{ code: number | null, out: string }} */ (probed);
if (probeCode !== 0) await fail(`the outside probe exited ${probeCode}:\n${probeOut}`);
console.log(`probe: exit 0, ${probeOut.split("\n").filter((l) => l.startsWith("ok ")).length} checks passed`);

await shutdown();
