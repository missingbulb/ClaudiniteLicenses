#!/usr/bin/env node
// The outside probe: checks the license server from outside Cloudflare the way a customer meets it,
// ten named checks: the three health routes, the alerts endpoint, the router's signature check, the
// desktop path reaching GitHub, the token refresh refusing a body with no token, Polar's webhook
// refusing an unsigned delivery, the service-binding-only paths answered by no Worker, and, with an
// OIDC token, the Actions path's verifier and pin. Unpinned, each sends one request (the private
// paths two); the deploy's read-back proves the per-address cap. A pinned walk can send dozens from
// one address, so an answer of 429 `rate-limited` is the cap, not the check's verdict: the probe
// waits out the cap's period and asks again, up to CAP_WAITS times per request, and the row
// reports `cap_waits`.
// It prints one line per check, writes a JSON summary with --json, and exits 1 when any check
// fails. With --issue it keeps one standing issue, titled and labelled below: a failing run opens
// it or comments on the open one, a passing run closes it. The schedule and the deploy both run it.
//
// Every check reports the version that answered it, read from the Worker's version header. With
// --expect-version, a check answered by a named Worker is pinned to that version id: the deploy's
// canary probe judges a new version while it serves one tenth of requests. A pinned request carries
// Cloudflare's version-affinity header, `Cloudflare-Workers-Version-Key`, whose value the platform
// hashes against the deployment's percentages so one key always lands on one version
// (developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/version-affinity/,
// read 2026-10-01); the probe walks keys canary-1, canary-2, ... until the answer names the id.
//
// A check answered by a Worker fails when the answer names no version: every version deployed since
// ClaudiniteLicenses#16 sets the header on every answer, so a versionless one did not come from the
// Worker the deploy judged. Such a row keeps the answer's raw headers. The two versionless rows of
// run 36927209537 (router-signature, actions-key-oidc) came 10 to 26 seconds into the promotion,
// on the first attempt, with answers only the versions before #16 give, which set no header: those
// versions were still serving some requests while the promotion spread (ClaudiniteLicenses#18).
//
//   node tools/probe.mjs --base <url> [--oidc-token-env NAME] [--issue --repo owner/name --token-env GITHUB_TOKEN] [--json <path>] [--attempts N]
//                        [--expect-version <worker>=<id>[,<worker>=<id>...]] [--cap-wait-ms N]
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { VERSION_HEADER } from "../packages/version/src/index.ts";

export const ISSUE_TITLE = "License server probe";
export const ISSUE_LABEL = "probe";
const TIMEOUT_MS = 20_000;
const RETRY_DELAY_MS = 5_000;
export const AFFINITY_HEADER = "Cloudflare-Workers-Version-Key";
/** One key in ten lands on a 10% version, so missing it in this many keys is a 0.2% event. */
export const VERSION_KEYS = 60;
export const WORKERS = ["public-key", "key", "sync", "router"];
/** The per-address cap's period, 60 seconds, and a second of slack. */
export const CAP_WAIT_MS = 61_000;
export const CAP_WAITS = 2;

/**
 * @typedef {{ status: number | null, body: any, text: string, version: string | null, headers: Record<string, string>, error?: string, latency_ms: number }} Answer
 * @typedef {{ name: string, ok: boolean, status: number | null, version: string | null, latency_ms: number, cap_waits?: number, alerts?: { id: string, since?: number | null, detail?: string | null }[], detail?: string, headers?: Record<string, string> }} Check
 * @typedef {(extra?: Record<string, string>) => Promise<Answer>} Request
 */

/** @param {string} url @param {RequestInit & { headers?: Record<string, string> }} [init] @param {Record<string, string>} [extra] @returns {Promise<Answer>} */
async function ask(url, init = {}, extra = {}) {
  const started = performance.now();
  try {
    const res = await fetch(url, { ...init, headers: { ...init.headers, ...extra }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      // A plain-text answer, such as the router's refusal.
    }
    return { status: res.status, body, text, version: res.headers.get(VERSION_HEADER), headers: Object.fromEntries(res.headers), latency_ms: Math.round(performance.now() - started) };
  } catch (err) {
    return { status: null, body: null, text: "", version: null, headers: {}, error: String(err instanceof Error && err.cause ? err.cause : err), latency_ms: Math.round(performance.now() - started) };
  }
}

/**
 * The checks in order, each a request and what its answer must be.
 * @param {string} base @param {string | null} oidc
 * `worker` is the Worker that answers, or null for a check no Worker may answer.
 * @returns {{ name: string, worker: string | null, request: Request, judge: (a: Answer) => string | null }[]}
 */
function checks(base, oidc) {
  const status = (/** @type {number} */ want) => (/** @type {Answer} */ a) => (a.status === want ? null : `want ${want}`);
  // A 200 whose body carries each field as given. `ip_limit: "counted"` is the per-address cap counting
  // that very read, so a version without its binding fails the canary rather than the read-back.
  const healthy = (/** @type {Record<string, unknown>} */ fields) => (/** @type {Answer} */ a) => {
    if (a.status !== 200) return "want 200";
    const b = a.body ?? {};
    const wrong = Object.entries(fields)
      .filter(([k, v]) => b[k] !== v)
      .map(([k, v]) => `${k} is ${JSON.stringify(b[k])}, want ${JSON.stringify(v)}`);
    return wrong.length ? wrong.join("; ") : null;
  };
  const list = [
    { name: "public-health", worker: "public-key", request: (extra) => ask(`${base}/v1/public/health`, {}, extra), judge: healthy({ ip_limit: "counted" }) },
    {
      name: "key-health",
      worker: "key",
      request: (extra) => ask(`${base}/v1/key/health`, {}, extra),
      judge: healthy({ d1: "ok", queue: "bound", polar: "configured", trust_roots: "ok", ip_limit: "counted" }),
    },
    { name: "sync-health", worker: "sync", request: (extra) => ask(`${base}/v1/sync/health`, {}, extra), judge: status(200) },
    { name: "sync-alerts", worker: "sync", request: (extra) => ask(`${base}/v1/sync/alerts`, {}, extra), judge: status(200) },
    {
      name: "router-signature",
      worker: "router",
      request: (extra) => ask(`${base}/github-webhook`, { method: "POST", headers: { "Content-Type": "application/json", "X-GitHub-Event": "ping" }, body: "{}" }, extra),
      judge: status(401),
    },
    {
      // The key Worker asks GitHub who `probe` is and GitHub refuses: the desktop path's upstream answers.
      name: "session-key-upstream",
      worker: "key",
      request: (extra) =>
        ask(
          `${base}/v1/session-key`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: "Bearer probe" },
            body: JSON.stringify({ repo: "missingbulb/probe", nonce: randomBytes(16).toString("hex"), engine_version: "probe" }),
          },
          extra,
        ),
      judge: (/** @type {Answer} */ a) => (a.status === 401 && a.body?.refused === "token-invalid" ? null : "want 401 token-invalid"),
    },
    {
      // A body with no refresh token is refused before the Worker calls GitHub.
      name: "login-refresh-unauthenticated",
      worker: "key",
      request: (extra) => ask(`${base}/v1/login/refresh`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }, extra),
      judge: (/** @type {Answer} */ a) => (a.status === 400 && a.body?.refused === "no-refresh-token" ? null : "want 400 no-refresh-token"),
    },
    {
      // secret-unset would mean the live Worker lost POLAR_WEBHOOK_SECRET.
      name: "polar-webhook-unsigned",
      worker: "sync",
      request: (extra) => ask(`${base}/v1/sync/polar-webhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }, extra),
      judge: (/** @type {Answer} */ a) => (a.status === 401 && a.text.trim() === "signature-missing" ? null : "want 401 signature-missing"),
    },
    {
      // /webhook is reached only over a service binding, so no Worker answers it from outside; the
      // key Worker's route prefix reaches /v1/key/webhook, where its router must answer 404.
      name: "private-paths-unrouted",
      worker: null,
      request: async (extra) => {
        const bare = await ask(`${base}/webhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }, extra);
        const prefixed = await ask(`${base}/v1/key/webhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }, extra);
        const wrong = [
          bare.error ? `/webhook: ${bare.error}` : null,
          bare.version ? `/webhook answered by version ${bare.version}` : null,
          bare.status !== null && bare.status < 400 ? `/webhook answered ${bare.status}` : null,
          prefixed.error ? `/v1/key/webhook: ${prefixed.error}` : null,
          prefixed.status !== null && prefixed.status !== 404 ? `/v1/key/webhook answered ${prefixed.status}, want 404` : null,
        ].filter(Boolean);
        return { ...bare, body: { wrong }, text: `/webhook ${bare.status ?? "-"}, /v1/key/webhook ${prefixed.status ?? "-"}`, latency_ms: bare.latency_ms + prefixed.latency_ms };
      },
      judge: (/** @type {Answer} */ a) => (a.body.wrong.length ? a.body.wrong.join("; ") : null),
    },
  ];
  if (oidc) {
    list.push({
      // A real token through the JWKS fetch, the verifier and the repos read; the pin refuses it.
      name: "actions-key-oidc",
      worker: "key",
      request: (extra) =>
        ask(`${base}/v1/actions-key`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${oidc}` }, body: JSON.stringify({ engine_version: "probe" }) }, extra),
      judge: (/** @type {Answer} */ a) => (a.status === 403 && a.body?.refused === "workflow-not-pinned" ? null : "want 403 workflow-not-pinned"),
    });
  }
  return list;
}

/**
 * Parses `<worker>=<id>[,<worker>=<id>...]`, each Worker named once and answering some check.
 * @param {string} spec @returns {Record<string, string>}
 */
export function parseExpectVersion(spec) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const part of spec.split(",")) {
    const m = /^([a-z-]+)=(\S+)$/.exec(part.trim());
    if (!m) throw new Error(`--expect-version: ${JSON.stringify(part)} is not <worker>=<id>`);
    if (!WORKERS.includes(m[1])) throw new Error(`--expect-version: no check is answered by ${m[1]} (want one of ${WORKERS.join(", ")})`);
    if (m[1] in out) throw new Error(`--expect-version: ${m[1]} is named twice`);
    out[m[1]] = m[2];
  }
  return out;
}

/**
 * One answer from `id`: the request sent with version keys canary-1, canary-2, ... until the answer
 * names it, or the last answer and why when no key in the budget reached it.
 * @param {Request} request @param {string} id @returns {Promise<{ answer: Answer, wrong: string | null }>}
 */
async function reachVersion(request, id) {
  /** @type {Answer} */
  let answer = { status: null, body: null, text: "", version: null, headers: {}, latency_ms: 0 };
  for (let k = 1; k <= VERSION_KEYS; k++) {
    answer = await request({ [AFFINITY_HEADER]: `canary-${k}` });
    if (answer.version === id) return { answer, wrong: null };
  }
  return { answer, wrong: `version ${id} not reached in ${VERSION_KEYS} keys` };
}

/** @param {Answer} a */
const capped = (a) => a.status === 429 && a.body?.refused === "rate-limited";

/**
 * `request`, waiting `waitMs` and asking again whenever the per-address cap answers, at most
 * CAP_WAITS times per call; `waits.count` counts the waits.
 * @param {Request} request @param {number} waitMs @param {{ count: number }} waits @returns {Request}
 */
function throughCap(request, waitMs, waits) {
  return async (extra) => {
    for (let w = 0; ; w++) {
      const a = await request(extra);
      if (!capped(a) || w >= CAP_WAITS) return a;
      waits.count++;
      await new Promise((ok) => setTimeout(ok, waitMs));
    }
  };
}

/**
 * Runs every check, retrying a failing one up to `attempts` times in all. A check whose Worker has
 * an id in `expect` is judged on that version's answer only.
 * @param {{ base: string, oidc?: string | null, attempts?: number, retryDelayMs?: number, capWaitMs?: number, expect?: Record<string, string> }} opts
 * @returns {Promise<{ base: string, checked_at: string, ok: boolean, checks: Check[] }>}
 */
export async function runProbe({ base, oidc = null, attempts = 1, retryDelayMs = RETRY_DELAY_MS, capWaitMs = CAP_WAIT_MS, expect = {} }) {
  /** @type {Check[]} */
  const results = [];
  for (const c of checks(base.replace(/\/$/, ""), oidc)) {
    const pin = c.worker ? (expect[c.worker] ?? null) : null;
    const waits = { count: 0 };
    const request = throughCap(c.request, capWaitMs, waits);
    /** @param {Answer} a */
    const judged = (a) => (a.error ? a.error : (c.judge(a) ?? (c.worker && !a.version ? "version header missing" : null)));
    let a;
    let wrong;
    for (let i = 1; ; i++) {
      if (pin) {
        const reached = await reachVersion(request, pin);
        a = reached.answer;
        wrong = reached.wrong ?? judged(a);
        if (wrong && !reached.wrong) wrong = `version ${pin}: ${wrong}`;
      } else {
        a = await request();
        wrong = judged(a);
      }
      if (!wrong || i >= attempts) break;
      await new Promise((ok) => setTimeout(ok, retryDelayMs));
    }
    /** @type {Check} */
    const check = { name: c.name, ok: !wrong, status: a.status, version: a.version, latency_ms: a.latency_ms };
    if (waits.count > 0) check.cap_waits = waits.count;
    if (Array.isArray(a.body?.alerts) && a.body.alerts.length > 0) check.alerts = a.body.alerts;
    if (c.worker && !a.version && a.status !== null) check.headers = a.headers;
    if (wrong) check.detail = `${wrong}; got ${a.status ?? "no answer"} ${a.text.slice(0, 200)}`.trim();
    results.push(check);
  }
  return { base, checked_at: new Date().toISOString(), ok: results.every((c) => c.ok), checks: results };
}

/** @param {Check} c */
function lines(c) {
  const head = `${c.ok ? "ok" : "FAIL"} ${c.name} ${c.status ?? "-"} ${c.latency_ms} ms${c.version ? ` ${c.version}` : ""}${c.cap_waits ? ` (waited out the per-address cap ${c.cap_waits}x)` : ""}${c.detail ? `: ${c.detail}` : ""}`;
  return [head, ...(c.alerts ?? []).map((a) => `  alert ${typeof a === "string" ? a : `${a.id}${a.detail ? `: ${a.detail}` : ""}`}`), ...(c.headers ? [`  headers ${JSON.stringify(c.headers)}`] : [])];
}

/** @param {{ ok: boolean, checks: Check[] }} summary @param {string} run */
function report(summary, run) {
  const failing = summary.checks.filter((c) => !c.ok || c.alerts);
  return [`The license server probe failed in ${run}.`, "", "```", ...failing.flatMap(lines), "```"].join("\n");
}

/**
 * Keeps the one standing issue: opened or commented on by a failing run, closed by a passing one.
 * Its guard is the title and the label on an open issue, never a run or a date.
 * @param {{ api: string, repo: string, token: string, summary: { ok: boolean, checks: Check[] }, run: string }} o
 * @returns {Promise<string>} what it did
 */
export async function keepIssue({ api, repo, token, summary, run }) {
  /** @param {string} method @param {string} path @param {unknown} [body] */
  const gh = async (method, path, body) => {
    const res = await fetch(`${api}/repos/${repo}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "claudinite-probe", "X-GitHub-Api-Version": "2022-11-28", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 404 && method === "GET") return null;
    if (!res.ok) throw new Error(`GitHub ${method} ${path} answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.status === 204 ? {} : res.json();
  };
  const listed = /** @type {{ number: number, title: string, pull_request?: unknown }[]} */ ((await gh("GET", `/issues?state=open&labels=${ISSUE_LABEL}&per_page=100`)) ?? []);
  const open = listed.find((i) => i.title === ISSUE_TITLE && !i.pull_request);
  if (summary.ok) {
    if (!open) return "no open issue";
    await gh("POST", `/issues/${open.number}/comments`, { body: `Passing again in ${run}.` });
    await gh("PATCH", `/issues/${open.number}`, { state: "closed", state_reason: "completed" });
    return `closed #${open.number}`;
  }
  if (open) {
    await gh("POST", `/issues/${open.number}/comments`, { body: report(summary, run) });
    return `commented on #${open.number}`;
  }
  if (!(await gh("GET", `/labels/${ISSUE_LABEL}`))) await gh("POST", "/labels", { name: ISSUE_LABEL, color: "b60205", description: "The outside probe's standing issue" });
  const made = await gh("POST", "/issues", { title: ISSUE_TITLE, labels: [ISSUE_LABEL], body: report(summary, run) });
  return `opened #${made.number}`;
}

if (import.meta.filename === process.argv[1]) {
  const { values } = parseArgs({
    options: {
      base: { type: "string" },
      "oidc-token-env": { type: "string" },
      issue: { type: "boolean" },
      repo: { type: "string" },
      "token-env": { type: "string" },
      json: { type: "string" },
      attempts: { type: "string" },
      "expect-version": { type: "string" },
      "cap-wait-ms": { type: "string" },
    },
  });
  /** @type {Record<string, string>} */
  let expect = {};
  let badPin = null;
  try {
    if (values["expect-version"] !== undefined) expect = parseExpectVersion(values["expect-version"]);
  } catch (err) {
    badPin = err instanceof Error ? err.message : String(err);
  }
  if (badPin) {
    console.error(`probe: ${badPin}`);
    process.exitCode = 2;
  } else if (!values.base) {
    console.error("probe: --base is required");
    process.exitCode = 2;
  } else if (values.issue && !values.repo) {
    console.error("probe: --issue needs --repo owner/name");
    process.exitCode = 2;
  } else {
    const oidcName = values["oidc-token-env"];
    const oidc = oidcName ? process.env[oidcName] || null : null;
    if (oidcName && !oidc) console.log(`probe: ${oidcName} is empty, so the Actions check is skipped`);
    const summary = await runProbe({ base: values.base, oidc, attempts: Number(values.attempts ?? 1), capWaitMs: values["cap-wait-ms"] === undefined ? CAP_WAIT_MS : Number(values["cap-wait-ms"]), expect });
    for (const c of summary.checks) for (const l of lines(c)) console.log(l);
    console.log(JSON.stringify(summary));
    if (values.json) writeFileSync(values.json, JSON.stringify(summary, null, 2) + "\n");
    if (values.issue && values.repo) {
      const env = process.env;
      const run = env.GITHUB_RUN_ID && env.GITHUB_REPOSITORY ? `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : "a run outside Actions";
      const token = env[values["token-env"] ?? "GITHUB_TOKEN"] ?? "";
      try {
        console.log(`probe issue: ${await keepIssue({ api: env.GITHUB_API_URL ?? "https://api.github.com", repo: values.repo, token, summary, run })}`);
      } catch (err) {
        console.error(`probe issue: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    }
    if (!summary.ok) process.exitCode = 1;
  }
}
