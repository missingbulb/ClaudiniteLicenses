#!/usr/bin/env node
// The outside probe: checks the license server from outside Cloudflare the way a customer meets it,
// one named check each — the three health routes, the alerts endpoint, the router's signature check,
// the desktop path reaching GitHub, and, with an OIDC token, the Actions path's verifier and pin.
// It prints one line per check, writes a JSON summary with --json, and exits 1 when any check
// fails. With --issue it keeps one standing issue, titled and labelled below: a failing run opens
// it or comments on the open one, a passing run closes it. The schedule and the deploy both run it.
//
//   node tools/probe.mjs --base <url> [--oidc-token-env NAME] [--issue --repo owner/name --token-env GITHUB_TOKEN] [--json <path>] [--attempts N]
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

export const ISSUE_TITLE = "License server probe";
export const ISSUE_LABEL = "probe";
const TIMEOUT_MS = 20_000;
const RETRY_DELAY_MS = 5_000;

/**
 * @typedef {{ status: number | null, body: any, text: string, error?: string, latency_ms: number }} Answer
 * @typedef {{ name: string, ok: boolean, status: number | null, latency_ms: number, alerts?: { id: string, since?: number | null, detail?: string | null }[], detail?: string }} Check
 */

/** @param {string} url @param {RequestInit} [init] @returns {Promise<Answer>} */
async function ask(url, init = {}) {
  const started = performance.now();
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      // A plain-text answer, such as the router's refusal.
    }
    return { status: res.status, body, text, latency_ms: Math.round(performance.now() - started) };
  } catch (err) {
    return { status: null, body: null, text: "", error: String(err instanceof Error && err.cause ? err.cause : err), latency_ms: Math.round(performance.now() - started) };
  }
}

/**
 * The checks in order, each a request and what its answer must be.
 * @param {string} base @param {string | null} oidc
 * @returns {{ name: string, request: () => Promise<Answer>, judge: (a: Answer) => string | null }[]}
 */
function checks(base, oidc) {
  const status = (/** @type {number} */ want) => (/** @type {Answer} */ a) => (a.status === want ? null : `want ${want}`);
  const list = [
    { name: "public-health", request: () => ask(`${base}/v1/public/health`), judge: status(200) },
    {
      name: "key-health",
      request: () => ask(`${base}/v1/key/health`),
      judge: (/** @type {Answer} */ a) => {
        if (a.status !== 200) return "want 200";
        const b = a.body ?? {};
        const wrong = Object.entries({ d1: "ok", queue: "bound", polar: "configured", trust_roots: "ok" })
          .filter(([k, v]) => b[k] !== v)
          .map(([k, v]) => `${k} is ${JSON.stringify(b[k])}, want ${JSON.stringify(v)}`);
        return wrong.length ? wrong.join("; ") : null;
      },
    },
    { name: "sync-health", request: () => ask(`${base}/v1/sync/health`), judge: status(200) },
    { name: "sync-alerts", request: () => ask(`${base}/v1/sync/alerts`), judge: status(200) },
    {
      name: "router-signature",
      request: () => ask(`${base}/github-webhook`, { method: "POST", headers: { "Content-Type": "application/json", "X-GitHub-Event": "ping" }, body: "{}" }),
      judge: status(401),
    },
    {
      // The key Worker asks GitHub who `probe` is and GitHub refuses: the desktop path's upstream answers.
      name: "session-key-upstream",
      request: () =>
        ask(`${base}/v1/session-key`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer probe" },
          body: JSON.stringify({ repo: "missingbulb/probe", nonce: randomBytes(16).toString("hex"), engine_version: "probe" }),
        }),
      judge: (/** @type {Answer} */ a) => (a.status === 401 && a.body?.refused === "token-invalid" ? null : "want 401 token-invalid"),
    },
  ];
  if (oidc) {
    list.push({
      // A real token through the JWKS fetch, the verifier and the repos read; the pin refuses it.
      name: "actions-key-oidc",
      request: () =>
        ask(`${base}/v1/actions-key`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${oidc}` }, body: JSON.stringify({ engine_version: "probe" }) }),
      judge: (/** @type {Answer} */ a) => (a.status === 403 && a.body?.refused === "workflow-not-pinned" ? null : "want 403 workflow-not-pinned"),
    });
  }
  return list;
}

/**
 * Runs every check, retrying a failing one up to `attempts` times in all.
 * @param {{ base: string, oidc?: string | null, attempts?: number, retryDelayMs?: number }} opts
 * @returns {Promise<{ base: string, checked_at: string, ok: boolean, checks: Check[] }>}
 */
export async function runProbe({ base, oidc = null, attempts = 1, retryDelayMs = RETRY_DELAY_MS }) {
  /** @type {Check[]} */
  const results = [];
  for (const c of checks(base.replace(/\/$/, ""), oidc)) {
    let a;
    let wrong;
    for (let i = 1; ; i++) {
      a = await c.request();
      wrong = a.error ? a.error : c.judge(a);
      if (!wrong || i >= attempts) break;
      await new Promise((ok) => setTimeout(ok, retryDelayMs));
    }
    /** @type {Check} */
    const check = { name: c.name, ok: !wrong, status: a.status, latency_ms: a.latency_ms };
    if (Array.isArray(a.body?.alerts) && a.body.alerts.length > 0) check.alerts = a.body.alerts;
    if (wrong) check.detail = `${wrong}; got ${a.status ?? "no answer"} ${a.text.slice(0, 200)}`.trim();
    results.push(check);
  }
  return { base, checked_at: new Date().toISOString(), ok: results.every((c) => c.ok), checks: results };
}

/** @param {Check} c */
function lines(c) {
  const head = `${c.ok ? "ok" : "FAIL"} ${c.name} ${c.status ?? "-"} ${c.latency_ms} ms${c.detail ? `: ${c.detail}` : ""}`;
  return [head, ...(c.alerts ?? []).map((a) => `  alert ${typeof a === "string" ? a : `${a.id}${a.detail ? `: ${a.detail}` : ""}`}`)];
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
    },
  });
  if (!values.base) {
    console.error("probe: --base is required");
    process.exitCode = 2;
  } else if (values.issue && !values.repo) {
    console.error("probe: --issue needs --repo owner/name");
    process.exitCode = 2;
  } else {
    const oidcName = values["oidc-token-env"];
    const oidc = oidcName ? process.env[oidcName] || null : null;
    if (oidcName && !oidc) console.log(`probe: ${oidcName} is empty, so the Actions check is skipped`);
    const summary = await runProbe({ base: values.base, oidc, attempts: Number(values.attempts ?? 1) });
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
