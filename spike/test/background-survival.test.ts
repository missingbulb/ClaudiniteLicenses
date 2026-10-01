import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const HOOK = resolve(import.meta.dirname, "../background-survival.mjs");
const lines = (p: string) => (existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean) : []);

it("returns at once and leaves a heartbeat that outlives it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acme-heartbeat-"));
  const log = join(dir, ".claudinite/temp/spike-heartbeat.log");
  const input = JSON.stringify({ session_id: "acme-session", hook_event_name: "SessionStart", source: "startup" });
  const res = spawnSync(process.execPath, [HOOK], {
    input,
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, CLAUDE_SESSION_ID: "acme-session", SPIKE_HEARTBEAT_SECONDS: "5" },
    encoding: "utf8",
  });
  expect(res.status).toBe(0);
  // The hook's own work, timed inside the process, is what the 100 ms budget is for; node's
  // startup is the same for every hook and outside it.
  const took = Number(/hook returned in (\d+) ms/.exec(res.stderr)?.[1]);
  expect(took).toBeLessThan(100);

  await new Promise((ok) => setTimeout(ok, 3000));
  const seen = lines(log);
  expect(seen.length).toBeGreaterThan(1);
  const first = JSON.parse(seen[0]!);
  expect(first).toMatchObject({ source: "startup", session_id: "acme-session", env_session_id: "acme-session" });
  expect(first.pid).not.toBe(res.pid);
});
