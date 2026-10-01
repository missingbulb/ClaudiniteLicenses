import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// A workflow cannot run here; these read deploy.yml and run its step scripts the way Actions would,
// resolving `${{ secrets.NAME }}` in the job's and the step's env from a stand-in secrets store.
const ROOT = resolve(import.meta.dirname, "../..");
const workflow = parse(readFileSync(join(ROOT, ".github/workflows/deploy.yml"), "utf8"));
type Step = { id?: string; name?: string; run?: string; env?: Record<string, string> };
const job: { env?: Record<string, string>; steps: Step[] } = workflow.jobs.deploy;
const steps = job.steps;
const gate = steps.find((s) => s.id === "gate")!;

interface ReadmeSecret {
  repo: string;
  worker: string;
}

function readmeSecrets(worker: string): ReadmeSecret[] {
  const text = readFileSync(join(ROOT, "workers", worker, "README.md"), "utf8");
  const section = text.split(/^## Secrets$/m)[1] ?? "";
  return [...section.matchAll(/^- `([A-Z0-9_]+)`(?:, as `([A-Z0-9_]+)`)?/gm)].map((m) => ({ repo: m[1]!, worker: m[2] ?? m[1]! }));
}

function resolveEnv(env: Record<string, string> | undefined, secrets: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    const m = /^\$\{\{\s*secrets\.([A-Z0-9_]+)\s*\}\}$/.exec(String(v));
    out[k] = m ? (secrets[m[1]!] ?? "") : String(v);
  }
  return out;
}

function runStep(step: Step, secrets: Record<string, string>, extra: Record<string, string> = {}) {
  return spawnSync("bash", ["-e", "-c", step.run!], {
    env: { PATH: process.env.PATH!, ...resolveEnv(job.env, secrets), ...resolveEnv(step.env, secrets), ...extra },
    encoding: "utf8",
  });
}

function runGate(secrets: Record<string, string>) {
  const out = join(mkdtempSync(join(tmpdir(), "acme-gate-")), "output");
  const res = runStep(gate, secrets, { GITHUB_OUTPUT: out });
  return { status: res.status, stdout: res.stdout, output: readFileSync(out, "utf8") };
}

// Runs a "Secrets for <worker>" step with an npx that keeps the file `wrangler secret bulk` was handed.
function bulkSecrets(worker: string, secrets: Record<string, string>): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "acme-bulk-"));
  const npx = join(dir, "npx");
  writeFileSync(npx, `#!/usr/bin/env bash\ncp "$4" "${dir}/bulk.json"\n`);
  chmodSync(npx, 0o755);
  const step = steps.find((s) => s.name === `Secrets for claudinite-${worker}`)!;
  const res = runStep(step, secrets, { PATH: `${dir}:${process.env.PATH}`, RUNNER_TEMP: dir });
  expect(res.status, res.stderr).toBe(0);
  return JSON.parse(readFileSync(join(dir, "bulk.json"), "utf8"));
}

describe("deploy.yml", () => {
  const listed = [...readmeSecrets("public-key"), ...readmeSecrets("router")];
  const secrets = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", ...listed.map((s) => s.repo)];

  it("deploys the public key Worker before the router that binds to it", () => {
    const deployAt = (worker: string) => steps.findIndex((s) => s.run?.includes(`wrangler deploy -c workers/${worker}/wrangler.jsonc`));
    expect(deployAt("public-key")).toBeGreaterThan(-1);
    expect(deployAt("public-key")).toBeLessThan(deployAt("router"));
  });

  it("gates on every secret the Workers' READMEs list", () => {
    expect(readmeSecrets("public-key").length).toBeGreaterThanOrEqual(4);
    expect(readmeSecrets("router").length).toBeGreaterThanOrEqual(1);
    for (const name of secrets) {
      const res = runGate(Object.fromEntries(secrets.filter((s) => s !== name).map((s) => [s, "set"])));
      expect(res.status, name).toBe(0);
      expect(res.stdout, name).toContain(`deploy skipped: missing ${name}`);
      expect(res.output, name).toBe("skip=true\n");
    }
  });

  it("exits clean and skips with nothing set, and proceeds with everything set", () => {
    const none = runGate({});
    expect(none.status).toBe(0);
    expect(none.output).toBe("skip=true\n");
    const all = runGate(Object.fromEntries(secrets.map((s) => [s, "set"])));
    expect(all.status).toBe(0);
    expect(all.stdout).not.toContain("skipped");
    expect(all.output).toBe("skip=false\n");
  });

  it("cites ClaudiniteEngine#5 only when an issuing key is what is missing", () => {
    const without = (...names: string[]) => runGate(Object.fromEntries(secrets.filter((s) => !names.includes(s)).map((s) => [s, "set"]))).stdout;
    expect(without("ISSUING_KEY_PRIVATE")).toContain("ClaudiniteEngine#5");
    expect(without("ISSUING_KEY_CERT", "CLOUDFLARE_API_TOKEN")).toContain("ClaudiniteEngine#5");
    expect(without("CLOUDFLARE_API_TOKEN")).not.toContain("#");
  });

  it("stores each repository secret as the Worker secret its README names", () => {
    const values = Object.fromEntries(secrets.map((s) => [s, `value-of-${s}`]));
    for (const worker of ["public-key", "router"]) {
      const want = Object.fromEntries(readmeSecrets(worker).map((s) => [s.worker, values[s.repo]]));
      expect(bulkSecrets(worker, values), worker).toEqual(want);
    }
  });
});
