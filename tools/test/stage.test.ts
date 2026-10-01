import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const CONFIG = "workers/acme/wrangler.jsonc";

type Answer = { status?: number; stdout?: string; stderr?: string };

// A stand-in wrangler on PATH: records each argv as a JSON line and answers by its first two words,
// an array answering successive calls in turn.
function stage(args: string[], answers: Record<string, Answer | Answer[]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "acme-stage-"));
  writeFileSync(join(dir, "answers.json"), JSON.stringify(answers));
  writeFileSync(
    join(dir, "wrangler"),
    `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const log = ${JSON.stringify(join(dir, "argv.log"))};
fs.appendFileSync(log, JSON.stringify(args) + "\\n");
const cmd = args.slice(0, 2).join(" ");
let a = JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, "answers.json"))}, "utf8"))[cmd] ?? {};
if (Array.isArray(a)) {
  const n = fs.readFileSync(log, "utf8").trim().split("\\n").filter((l) => JSON.parse(l).slice(0, 2).join(" ") === cmd).length;
  a = a[Math.min(n, a.length) - 1];
}
process.stdout.write(a.stdout ?? "");
process.stderr.write(a.stderr ?? "");
process.exitCode = a.status ?? 0;
`,
  );
  chmodSync(join(dir, "wrangler"), 0o755);
  const res = spawnSync(process.execPath, ["tools/stage.mjs", ...args], { cwd: ROOT, env: { PATH: `${dir}:${process.env.PATH}` }, encoding: "utf8" });
  const log = existsSync(join(dir, "argv.log")) ? readFileSync(join(dir, "argv.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]) : [];
  let out: unknown = null;
  try {
    out = JSON.parse(res.stdout.trim().split("\n").at(-1) ?? "");
  } catch {
    // No JSON line: the run failed.
  }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, calls: log, out, dir };
}

const deployment = (versions: [string, number][]) => ({
  stdout: `${JSON.stringify({ id: "dep-1", source: "wrangler", strategy: "percentage", author_email: "acme@example.test", created_on: "2026-10-01T00:00:00Z", annotations: {}, versions: versions.map(([version_id, percentage]) => ({ version_id, percentage })) }, null, 2)}\n`,
});
const ONE = deployment([["v-old", 100]]);
const TWO = deployment([["v-old", 90], ["v-stuck", 10]]);
const NONE = { status: 1, stderr: "✘ [ERROR] The Worker claudinite-acme has no deployments.\n" };
const UPLOADED = { stdout: "Total Upload: 12.00 KiB / gzip: 3.00 KiB\nUploaded claudinite-acme (1.23 sec)\nWorker Version ID: 0b7d1d6e-1111-4222-8333-444455556666\n" };

describe("tools/stage.mjs upload", () => {
  it("passes the config, tag, message, every --var and the secrets file through, and prints the version id", () => {
    const res = stage(["upload", "--config", CONFIG, "--tag", "abc1234", "--message", "https://github.test/run/1", "--var", "TRUST_ROOTS:[\"r\"]", "--var", "A:b:c", "--secrets-file", "/tmp/acme.json"], { "versions upload": UPLOADED });
    expect(res.status, res.stderr).toBe(0);
    expect(res.calls).toEqual([["versions", "upload", "-c", CONFIG, "--tag", "abc1234", "--message", "https://github.test/run/1", "--var", "TRUST_ROOTS:[\"r\"]", "--var", "A:b:c", "--secrets-file", "/tmp/acme.json"]]);
    expect(res.out).toEqual({ version_id: "0b7d1d6e-1111-4222-8333-444455556666" });
  });

  it("exits 1 with wrangler's output on its stderr when wrangler fails, and when no id is printed", () => {
    const failed = stage(["upload", "--config", CONFIG, "--tag", "t", "--message", "m"], { "versions upload": { status: 1, stdout: "partial\n", stderr: "✘ [ERROR] Authentication error [code: 10000]\n" } });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("Authentication error [code: 10000]");
    expect(failed.stderr).toContain("partial");
    expect(failed.out).toBeNull();
    const silent = stage(["upload", "--config", CONFIG, "--tag", "t", "--message", "m"], { "versions upload": { stdout: "Uploaded\n" } });
    expect(silent.status).toBe(1);
    expect(silent.stderr).toMatch(/Worker Version ID/);
  });

  it("refuses an upload without its tag and message, before calling wrangler", () => {
    const res = stage(["upload", "--config", CONFIG]);
    expect(res.status).toBe(2);
    expect(res.calls).toEqual([]);
  });
});

describe("tools/stage.mjs status", () => {
  it("reads the active deployment's versions, one or two, and none for a Worker that has never deployed", () => {
    expect(stage(["status", "--config", CONFIG], { "deployments status": ONE }).out).toEqual({ versions: [{ id: "v-old", percentage: 100 }] });
    expect(stage(["status", "--config", CONFIG], { "deployments status": TWO }).out).toEqual({ versions: [{ id: "v-old", percentage: 90 }, { id: "v-stuck", percentage: 10 }] });
    const none = stage(["status", "--config", CONFIG], { "deployments status": NONE });
    expect(none.status).toBe(0);
    expect(none.out).toEqual({ versions: [] });
    expect(none.calls).toEqual([["deployments", "status", "--json", "-c", CONFIG]]);
  });

  it("fails on any other wrangler failure rather than reading it as undeployed", () => {
    const res = stage(["status", "--config", CONFIG], { "deployments status": { status: 1, stderr: "✘ [ERROR] Authentication error\n" } });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("Authentication error");
  });
});

describe("tools/stage.mjs split", () => {
  it("serves the new version to the given share beside the live one, and names the live one as previous", () => {
    const res = stage(["split", "--config", CONFIG, "--new", "v-new", "--percent", "10"], { "deployments status": ONE });
    expect(res.status, res.stderr).toBe(0);
    expect(res.calls).toEqual([
      ["deployments", "status", "--json", "-c", CONFIG],
      ["versions", "deploy", "v-old@90%", "v-new@10%", "-y", "-c", CONFIG],
    ]);
    expect(res.out).toEqual({ deployed: [{ id: "v-old", percentage: 90 }, { id: "v-new", percentage: 10 }], previous: "v-old" });
  });

  it("refuses to stack on a split an interrupted run left behind, deploying nothing", () => {
    const res = stage(["split", "--config", CONFIG, "--new", "v-new", "--percent", "10"], { "deployments status": TWO });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/v-old@90%.*v-stuck@10%/);
    expect(res.stderr).toMatch(/stage\.mjs rollback/);
    expect(res.calls.filter((c) => c[1] === "deploy")).toEqual([]);
  });

  it("deploys the new version at 100% on a Worker with no deployment, with no previous", () => {
    const res = stage(["split", "--config", CONFIG, "--new", "v-new", "--percent", "10"], { "deployments status": NONE });
    expect(res.status, res.stderr).toBe(0);
    expect(res.calls.at(-1)).toEqual(["versions", "deploy", "v-new@100%", "-y", "-c", CONFIG]);
    expect(res.out).toEqual({ deployed: [{ id: "v-new", percentage: 100 }], previous: null });
  });

  it("refuses a share outside 1 to 50, before calling wrangler", () => {
    for (const percent of ["0", "51", "100", "ten", "12.5"]) {
      const res = stage(["split", "--config", CONFIG, "--new", "v-new", "--percent", percent], { "deployments status": ONE });
      expect(res.status, percent).toBe(2);
      expect(res.calls, percent).toEqual([]);
    }
  });

  it("falls back to the new version at 100% with a warning when wrangler refuses the split", () => {
    const res = stage(["split", "--config", CONFIG, "--new", "v-new", "--percent", "10"], {
      "deployments status": ONE,
      "versions deploy": [{ status: 1, stderr: "✘ [ERROR] Gradual deployments are not available on this plan.\n" }, {}],
    });
    expect(res.status, res.stderr).toBe(0);
    expect(res.calls.slice(1)).toEqual([
      ["versions", "deploy", "v-old@90%", "v-new@10%", "-y", "-c", CONFIG],
      ["versions", "deploy", "v-new@100%", "-y", "-c", CONFIG],
    ]);
    expect(res.stdout).toMatch(/^::warning::.*split.*refused.*100%/m);
    expect(res.out).toEqual({ deployed: [{ id: "v-new", percentage: 100 }], previous: "v-old", fallback: true });
  });
});

describe("tools/stage.mjs promote, rollback and triggers", () => {
  it("promote and rollback both deploy the one id at 100%, never through wrangler rollback", () => {
    for (const cmd of ["promote", "rollback"]) {
      const res = stage([cmd, "--config", CONFIG, "--id", "v-x"]);
      expect(res.status, res.stderr).toBe(0);
      expect(res.calls).toEqual([["versions", "deploy", "v-x@100%", "-y", "-c", CONFIG]]);
      expect(res.out).toEqual({ deployed: [{ id: "v-x", percentage: 100 }] });
    }
  });

  it("applies the config's routes and crons through triggers deploy", () => {
    const res = stage(["triggers", "--config", CONFIG]);
    expect(res.status, res.stderr).toBe(0);
    expect(res.calls).toEqual([["triggers", "deploy", "-c", CONFIG]]);
    expect(res.out).toEqual({ ok: true });
  });

  it("writes the printed object to --json, accepts -c for --config, and refuses an unknown command", () => {
    const res = stage(["promote", "-c", CONFIG, "--id", "v-x", "--json", "out.json"]);
    expect(res.status, res.stderr).toBe(0);
    // --json is relative to the tool's working directory, the repo root.
    const path = join(ROOT, "out.json");
    try {
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ deployed: [{ id: "v-x", percentage: 100 }] });
    } finally {
      spawnSync("rm", ["-f", path]);
    }
    expect(stage(["stack", "--config", CONFIG]).status).toBe(2);
    expect(stage(["promote", "--id", "v-x"]).status).toBe(2);
  });

  it("never runs versions deploy without -y", () => {
    const runs = [
      stage(["split", "--config", CONFIG, "--new", "v-new", "--percent", "10"], { "deployments status": ONE }),
      stage(["split", "--config", CONFIG, "--new", "v-new", "--percent", "10"], { "deployments status": NONE }),
      stage(["promote", "--config", CONFIG, "--id", "v-x"]),
      stage(["rollback", "--config", CONFIG, "--id", "v-x"]),
    ];
    const deploys = runs.flatMap((r) => r.calls).filter((c) => c[0] === "versions" && c[1] === "deploy");
    expect(deploys).toHaveLength(4);
    for (const d of deploys) expect(d).toContain("-y");
  });
});
