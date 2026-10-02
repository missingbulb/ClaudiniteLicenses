#!/usr/bin/env node
// Stages a Worker's versions for the deploy, non-interactively: uploads a version without serving
// it, reads the active deployment, splits traffic between the live version and a new one, promotes
// one version to all of it, rolls back to a named one, applies the config's routes and crons, and
// reads the tag a version was uploaded with.
// Each command runs wrangler with `-y` wherever it would prompt, prints wrangler's own output on
// stderr, and prints one JSON object as its last stdout line (also written to --json); it exits 1
// with wrangler's output when wrangler fails, and 2 on a usage error before calling wrangler.
//
//   node tools/stage.mjs upload   --config <wrangler.jsonc> --tag <tag> --message <msg> [--var K:V]... [--secrets-file <path>]
//   node tools/stage.mjs status   --config <wrangler.jsonc>
//   node tools/stage.mjs split    --config <wrangler.jsonc> --new <id> --percent <1-50>
//   node tools/stage.mjs promote  --config <wrangler.jsonc> --id <id>
//   node tools/stage.mjs rollback --config <wrangler.jsonc> --id <id>
//   node tools/stage.mjs triggers --config <wrangler.jsonc>
//   node tools/stage.mjs tag      --config <wrangler.jsonc> --id <id>
//   (every command takes [--json <path>])
//
// A rollback deploys the named version at 100% rather than running `wrangler rollback`, whose
// default target is the version before the latest upload, not necessarily the one that was live.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { parseArgs } from "node:util";

const ROOT = resolve(import.meta.dirname, "..");

export class StageError extends Error {
  /** @param {string} message @param {number} [code] */
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

/**
 * Runs wrangler: a `wrangler` earlier on PATH wins, else the repo's own.
 * @param {string[]} args @returns {{ status: number | null, stdout: string, stderr: string }}
 */
function wrangler(args) {
  const res = spawnSync("wrangler", args, {
    cwd: ROOT,
    env: { ...process.env, PATH: `${process.env.PATH ?? ""}${delimiter}${resolve(ROOT, "node_modules/.bin")}`, WRANGLER_SEND_METRICS: "false" },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? (res.error ? String(res.error) : "") };
  process.stderr.write(out.stdout + out.stderr);
  return out;
}

/** @param {string[]} args */
function must(args) {
  const res = wrangler(args);
  if (res.status !== 0) throw new StageError(`wrangler ${args.slice(0, 2).join(" ")} failed (exit ${res.status}):\n${res.stdout}${res.stderr}`);
  return res;
}

const stripAnsi = (/** @type {string} */ s) => s.replace(/\u001b\[[0-9;]*m/g, "");

/** @param {{ config: string, tag: string, message: string, vars?: string[], secretsFile?: string }} o */
export function upload({ config, tag, message, vars = [], secretsFile }) {
  const args = ["versions", "upload", "-c", config, "--tag", tag, "--message", message, ...vars.flatMap((v) => ["--var", v]), ...(secretsFile ? ["--secrets-file", secretsFile] : [])];
  const res = must(args);
  const id = /Worker Version ID:\s*([0-9a-f-]{36})/i.exec(stripAnsi(res.stdout + res.stderr))?.[1];
  if (!id) throw new StageError(`wrangler versions upload printed no Worker Version ID:\n${res.stdout}${res.stderr}`);
  return { version_id: id };
}

/** @param {{ config: string }} o @returns {{ versions: { id: string, percentage: number }[] }} */
export function status({ config }) {
  const res = wrangler(["deployments", "status", "--json", "-c", config]);
  if (res.status !== 0) {
    if (/has no deployments|does not exist/i.test(stripAnsi(res.stdout + res.stderr))) return { versions: [] };
    throw new StageError(`wrangler deployments status failed (exit ${res.status}):\n${res.stdout}${res.stderr}`);
  }
  const text = stripAnsi(res.stdout);
  const at = text.indexOf("{");
  let parsed;
  try {
    parsed = JSON.parse(text.slice(at));
  } catch {
    throw new StageError(`wrangler deployments status printed no JSON deployment:\n${res.stdout}`);
  }
  if (!Array.isArray(parsed?.versions)) throw new StageError(`wrangler deployments status printed a deployment without versions:\n${res.stdout}`);
  return { versions: parsed.versions.map((/** @type {{ version_id: string, percentage: number }} */ v) => ({ id: v.version_id, percentage: v.percentage })) };
}

/** @param {string} config @param {{ id: string, percentage: number }[]} specs */
function deploy(config, specs) {
  return wrangler(["versions", "deploy", ...specs.map((s) => `${s.id}@${s.percentage}%`), "-y", "-c", config]);
}

/**
 * Serves `newId` to `percent` of requests beside the one live version. A Worker with no deployment
 * gets the new version at 100%; a split already standing is refused, never stacked on; a split the
 * account refuses falls back to the new version at 100%, which the canary then judges at full share.
 * @param {{ config: string, newId: string, percent: number }} o
 */
export function split({ config, newId, percent }) {
  const live = status({ config }).versions;
  if (live.length > 1) {
    throw new StageError(
      `a split is already standing (${live.map((v) => `${v.id}@${v.percentage}%`).join(" ")}); roll it back by hand first with node tools/stage.mjs rollback --config ${config} --id <the version that should be live>`,
    );
  }
  const previous = live[0]?.id ?? null;
  if (!previous) {
    const full = [{ id: newId, percentage: 100 }];
    const res = deploy(config, full);
    if (res.status !== 0) throw new StageError(`wrangler versions deploy failed (exit ${res.status}):\n${res.stdout}${res.stderr}`);
    return { deployed: full, previous };
  }
  const specs = [
    { id: previous, percentage: 100 - percent },
    { id: newId, percentage: percent },
  ];
  const res = deploy(config, specs);
  if (res.status === 0) return { deployed: specs, previous };
  const why = stripAnsi(`${res.stdout}${res.stderr}`).trim().split("\n").at(-1) ?? "";
  console.log(`::warning::the ${percent}% split of ${config} was refused (${why}); deploying ${newId} at 100% instead, still judged by the canary and rolled back to ${previous} on a failure`);
  const full = [{ id: newId, percentage: 100 }];
  const fallback = deploy(config, full);
  if (fallback.status !== 0) throw new StageError(`wrangler versions deploy failed (exit ${fallback.status}):\n${fallback.stdout}${fallback.stderr}`);
  return { deployed: full, previous, fallback: true };
}

/** Deploys one version at 100%: a promotion, or a rollback to the version that was live. @param {{ config: string, id: string }} o */
export function only({ config, id }) {
  const specs = [{ id, percentage: 100 }];
  const res = deploy(config, specs);
  if (res.status !== 0) throw new StageError(`wrangler versions deploy failed (exit ${res.status}):\n${res.stdout}${res.stderr}`);
  return { deployed: specs };
}

/** Applies the config's routes and crons, which a version upload does not. @param {{ config: string }} o */
export function triggers({ config }) {
  must(["triggers", "deploy", "-c", config]);
  return { ok: true };
}

/** The `--tag` a version was uploaded with, or null when it carries none. @param {{ config: string, id: string }} o @returns {{ tag: string | null }} */
export function tag({ config, id }) {
  const res = must(["versions", "view", id, "--json", "-c", config]);
  const text = stripAnsi(res.stdout);
  let parsed;
  try {
    parsed = JSON.parse(text.slice(text.indexOf("{")));
  } catch {
    throw new StageError(`wrangler versions view printed no JSON version:\n${res.stdout}`);
  }
  const t = parsed?.annotations?.["workers/tag"];
  return { tag: typeof t === "string" && t.length > 0 ? t : null };
}

/** @param {string[]} argv */
function run(argv) {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      config: { type: "string", short: "c" },
      json: { type: "string" },
      tag: { type: "string" },
      message: { type: "string" },
      var: { type: "string", multiple: true },
      "secrets-file": { type: "string" },
      new: { type: "string" },
      percent: { type: "string" },
      id: { type: "string" },
    },
  });
  const need = (/** @type {string} */ name) => {
    const v = /** @type {Record<string, unknown>} */ (values)[name];
    if (typeof v !== "string" || v.length === 0) throw new StageError(`${command} needs --${name}`, 2);
    return v;
  };
  const config = need("config");
  let out;
  switch (command) {
    case "upload":
      out = upload({ config, tag: need("tag"), message: need("message"), vars: values.var ?? [], secretsFile: values["secrets-file"] });
      break;
    case "status":
      out = status({ config });
      break;
    case "split": {
      const percent = need("percent");
      if (!/^\d+$/.test(percent) || Number(percent) < 1 || Number(percent) > 50) throw new StageError(`split --percent must be a whole number from 1 to 50, not ${percent}`, 2);
      out = split({ config, newId: need("new"), percent: Number(percent) });
      break;
    }
    case "promote":
    case "rollback":
      out = only({ config, id: need("id") });
      break;
    case "triggers":
      out = triggers({ config });
      break;
    case "tag":
      out = tag({ config, id: need("id") });
      break;
    default:
      throw new StageError(`unknown command ${JSON.stringify(command)} (want upload, status, split, promote, rollback, triggers or tag)`, 2);
  }
  console.log(JSON.stringify(out));
  if (values.json) writeFileSync(values.json, JSON.stringify(out) + "\n");
}

if (import.meta.filename === process.argv[1]) {
  try {
    run(process.argv.slice(2));
  } catch (err) {
    console.error(`stage: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = err instanceof StageError ? err.code : 1;
  }
}
