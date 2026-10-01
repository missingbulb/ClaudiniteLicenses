#!/usr/bin/env node
// A SessionStart hook for the background-survival work note: it starts a detached heartbeat that
// appends one JSON line a second to .claudinite/temp/spike-heartbeat.log for 150 seconds, then
// returns at once. Reading the log after three minutes shows whether a process started by a web
// SessionStart hook outlives the hook, and a resume shows up as a second start with its source.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const logPath = join(projectDir, ".claudinite/temp/spike-heartbeat.log");

async function heartbeat(source, sessionId, seconds) {
  mkdirSync(dirname(logPath), { recursive: true });
  const started = Date.now();
  for (let i = 0; i < seconds; i++) {
    appendFileSync(logPath, JSON.stringify({ t: new Date().toISOString(), elapsed_s: Math.round((Date.now() - started) / 1000), pid: process.pid, source, session_id: sessionId, env_session_id: process.env.CLAUDE_SESSION_ID ?? null }) + "\n");
    await new Promise((ok) => setTimeout(ok, 1000));
  }
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

if (process.argv[2] === "--heartbeat") {
  await heartbeat(process.argv[3], process.argv[4], Number(process.env.SPIKE_HEARTBEAT_SECONDS ?? 150));
} else {
  const t0 = performance.now();
  let input = {};
  try {
    input = JSON.parse((await readStdin()) || "{}");
  } catch {
    // a malformed payload still starts the heartbeat; the log then shows nulls
  }
  const child = spawn(process.execPath, [process.argv[1], "--heartbeat", input.source ?? "unknown", input.session_id ?? "unknown"], { detached: true, stdio: "ignore" });
  child.unref();
  console.error(`background-survival: heartbeat pid ${child.pid} writing ${logPath}; hook returned in ${Math.round(performance.now() - t0)} ms`);
}
