#!/usr/bin/env node
// The web key round-trip spike, run inside a Claude Code web session in a public repo with the
// Claudinite App installed: per try it sends a repository_dispatch with a fresh nonce and times
// until a `Claudinite key` check run with that nonce as its external id is readable. With
// --verify, each visible key is verified against the trust roots (`node tools/keys.mjs
// trust-roots`, or --roots) and its plan, state, notice and issuing key id recorded; a
// `Claudinite key refused` run records its summary instead.
//
//   node spike/web-key-roundtrip.mjs --repo owner/name [--tries 50] [--event claudinite-key-public]
//     [--interval-ms 500] [--cut-ms 10000] [--max-ms 120000] [--burst] [--verify [--roots <json>]]
//     [--out docs/spikes/web-key-roundtrip.json]
//
// Uses the session's GH_TOKEN / GITHUB_TOKEN. Node's fetch ignores HTTPS_PROXY unless
// NODE_USE_ENV_PROXY=1 is set at startup, so behind the web VM's proxy the script re-runs itself
// with it.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { verifyKey } from "../packages/signing/src/index.ts";

/** @param {number} ms */
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

/**
 * @typedef {{ try: number, dispatchStatus: number, dispatchMs: number, visibleMs: number | null, hasText: boolean, senderType: string | null, failure?: string,
 *   verified?: boolean, verifyReason?: string, plan?: string, state?: string, notice?: string | null, kid?: string, refusal?: string }} Try
 */

/**
 * @param {Try[]} tries
 * @param {{ cutMs: number, verify?: boolean }} opts
 */
export function summarize(tries, { cutMs, verify = false }) {
  const visible = tries.map((t) => t.visibleMs).filter((v) => v !== null).sort((a, b) => a - b);
  const median = (/** @type {number[]} */ xs) => {
    if (xs.length === 0) return null;
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };
  /** @type {Record<string, number>} */
  const senderTypes = {};
  for (const t of tries) if (t.senderType) senderTypes[t.senderType] = (senderTypes[t.senderType] ?? 0) + 1;
  return {
    tries: tries.length,
    visible: visible.length,
    medianMs: median(visible),
    p90Ms: visible.length ? visible[Math.ceil(0.9 * visible.length) - 1] : null,
    maxMs: visible.length ? visible[visible.length - 1] : null,
    overCut: visible.filter((v) => v > cutMs).length,
    cutMs,
    dispatchMedianMs: median(tries.map((t) => t.dispatchMs)),
    senderTypes,
    failures: tries.filter((t) => t.failure).map((t) => ({ try: t.try, cause: t.failure })),
    ...(verify ? verifiedSummary(tries) : {}),
  };
}

/** @param {Try[]} tries */
function verifiedSummary(tries) {
  /** @type {Map<string, { plan: string | undefined, state: string | undefined, notice: string | null, count: number }>} */
  const seen = new Map();
  for (const t of tries) {
    if (!t.verified) continue;
    const k = JSON.stringify([t.plan, t.state, t.notice ?? null]);
    const row = seen.get(k) ?? { plan: t.plan, state: t.state, notice: t.notice ?? null, count: 0 };
    row.count++;
    seen.set(k, row);
  }
  return { verified: tries.filter((t) => t.verified).length, refusals: tries.filter((t) => t.refusal !== undefined).length, seen: [...seen.values()] };
}

/**
 * Verifies a visible check run's key, or records its refusal.
 * @param {Try} rec @param {{ output?: { title?: string, summary?: string, text?: string } }} run @param {{ roots: string[], now?: Date }} verify
 */
async function verifyRun(rec, run, verify) {
  if (run.output?.title === "Claudinite key refused") {
    rec.refusal = run.output.summary ?? "";
    return;
  }
  const v = await verifyKey(run.output?.text ?? "", { roots: verify.roots, now: verify.now ?? new Date() });
  rec.verified = v.ok;
  if (!v.ok) {
    rec.verifyReason = v.reason;
    return;
  }
  rec.plan = v.payload.plan;
  rec.state = v.payload.state;
  rec.notice = v.payload.notice ?? null;
  rec.kid = v.payload.kid;
}

/**
 * @param {{ repo: string, token: string, apiBase?: string, tries: number, event: string, intervalMs: number, cutMs: number, maxMs: number, pauseMs: number, verify?: { roots: string[], now?: Date } }} o
 */
export async function runSpike(o) {
  const base = o.apiBase ?? "https://api.github.com";
  const headers = { Authorization: `Bearer ${o.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "claudinite-web-key-spike" };
  const get = async (/** @type {string} */ path) => {
    const res = await fetch(`${base}${path}`, { headers });
    if (!res.ok) throw new Error(`GET ${path} answered ${res.status}: ${await res.text()}`);
    return res.json();
  };
  const repo = await get(`/repos/${o.repo}`);
  const head = (await get(`/repos/${o.repo}/commits/${encodeURIComponent(repo.default_branch)}`)).sha;

  /** @type {Try[]} */
  const tries = [];
  for (let i = 1; i <= o.tries; i++) {
    const nonce = randomBytes(16).toString("hex");
    const t0 = performance.now();
    const res = await fetch(`${base}/repos/${o.repo}/dispatches`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ event_type: o.event, client_payload: { nonce, engine_version: "spike", head } }),
    });
    const dispatchMs = Math.round(performance.now() - t0);
    /** @type {Try} */
    const rec = { try: i, dispatchStatus: res.status, dispatchMs, visibleMs: null, hasText: false, senderType: null };
    if (res.status !== 204) {
      const text = await res.text();
      let message = text;
      try {
        message = JSON.parse(text).message ?? text;
      } catch {
        // not JSON: keep it verbatim
      }
      rec.failure = `dispatch ${res.status}: ${message}`;
    } else {
      await res.arrayBuffer();
      for (;;) {
        const elapsed = performance.now() - t0;
        if (elapsed > o.maxMs) {
          rec.failure = `no check run within ${o.maxMs} ms`;
          break;
        }
        const { check_runs } = await get(`/repos/${o.repo}/commits/${head}/check-runs?check_name=${encodeURIComponent("Claudinite key")}&per_page=100`);
        const run = check_runs.find((/** @type {{ external_id: string }} */ r) => r.external_id === nonce);
        if (run) {
          rec.visibleMs = Math.round(performance.now() - t0);
          rec.hasText = typeof run.output?.text === "string" && run.output.text.length > 0;
          rec.senderType = /sender type (\w+)/.exec(run.output?.summary ?? "")?.[1] ?? null;
          if (o.verify) await verifyRun(rec, run, o.verify);
          break;
        }
        await sleep(o.intervalMs);
      }
    }
    tries.push(rec);
    const verdict = !o.verify || rec.failure ? "" : rec.refusal !== undefined ? `, refused ${rec.refusal}` : rec.verified ? `, verified ${rec.plan} ${rec.state}${rec.notice ? ` ${rec.notice}` : ""}` : `, not verified: ${rec.verifyReason}`;
    console.error(`try ${i}: ${rec.failure ?? `visible in ${rec.visibleMs} ms (dispatch ${dispatchMs} ms, sender ${rec.senderType})${verdict}`}`);
    if (i < o.tries && o.pauseMs > 0) await sleep(o.pauseMs);
  }
  return { ...summarize(tries, { cutMs: o.cutMs, verify: Boolean(o.verify) }), repo: o.repo, event: o.event, head, ranAt: new Date().toISOString(), triesDetail: tries };
}

/** The roots the deploy hands the key Worker, as `tools/keys.mjs trust-roots` prints them. */
function trustRoots() {
  const res = spawnSync(process.execPath, [resolve(import.meta.dirname, "../tools/keys.mjs"), "trust-roots"], { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`tools/keys.mjs trust-roots failed: ${res.stderr}`);
  return res.stdout;
}

async function main() {
  const { values } = parseArgs({
    options: {
      repo: { type: "string" },
      tries: { type: "string", default: "50" },
      event: { type: "string", default: "claudinite-key-public" },
      "interval-ms": { type: "string", default: "500" },
      "cut-ms": { type: "string", default: "10000" },
      "max-ms": { type: "string", default: "120000" },
      out: { type: "string", default: "docs/spikes/web-key-roundtrip.json" },
      burst: { type: "boolean", default: false },
      "api-base": { type: "string" },
      verify: { type: "boolean", default: false },
      roots: { type: "string" },
    },
  });
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!values.repo || !token) {
    console.error("usage: GH_TOKEN=... node spike/web-key-roundtrip.mjs --repo owner/name [--tries 50] [--burst]");
    process.exit(2);
  }
  const result = await runSpike({
    repo: values.repo,
    token,
    apiBase: values["api-base"],
    tries: Number(values.tries),
    event: values.event,
    intervalMs: Number(values["interval-ms"]),
    cutMs: Number(values["cut-ms"]),
    maxMs: Number(values["max-ms"]),
    pauseMs: values.burst ? 0 : 2000,
    verify: values.verify ? { roots: JSON.parse(values.roots ?? trustRoots()) } : undefined,
  });
  mkdirSync(dirname(values.out), { recursive: true });
  writeFileSync(values.out, JSON.stringify(result, null, 2) + "\n");
  const { triesDetail: _detail, ...summary } = result;
  console.log(JSON.stringify(summary, null, 2));
}

if (import.meta.filename === process.argv[1]) {
  if (process.env.HTTPS_PROXY && process.env.NODE_USE_ENV_PROXY !== "1") {
    const child = spawnSync(process.execPath, process.argv.slice(1), { stdio: "inherit", env: { ...process.env, NODE_USE_ENV_PROXY: "1" } });
    process.exit(child.status ?? 1);
  }
  main().catch((err) => {
    console.error(`web-key-roundtrip: ${err.message}`);
    process.exit(1);
  });
}
