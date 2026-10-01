import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
  optional: boolean;
}

const WORKERS = ["public-key", "key", "sync", "router"];

function readmeSecrets(worker: string): ReadmeSecret[] {
  const text = readFileSync(join(ROOT, "workers", worker, "README.md"), "utf8");
  const section = text.split(/^## Secrets$/m)[1] ?? "";
  return [...section.matchAll(/^- `([A-Z0-9_]+)`(?:, as `([A-Z0-9_]+)`)?(.*)$/gm)].map((m) => ({ repo: m[1]!, worker: m[2] ?? m[1]!, optional: /\(optional\b/.test(m[3]!) }));
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
    cwd: ROOT,
    env: { PATH: process.env.PATH!, ...resolveEnv(job.env, secrets), ...resolveEnv(step.env, secrets), ...extra },
    encoding: "utf8",
  });
}

function runGate(secrets: Record<string, string>) {
  const out = join(mkdtempSync(join(tmpdir(), "acme-gate-")), "output");
  const res = runStep(gate, secrets, { GITHUB_OUTPUT: out });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, output: existsSync(out) ? readFileSync(out, "utf8") : "" };
}

// Runs a "Secrets for <worker>" step with an npx that keeps the file `wrangler secret bulk` was handed.
function bulkSecrets(worker: string, secrets: Record<string, string>): { bulk: Record<string, string>; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "acme-bulk-"));
  const npx = join(dir, "npx");
  writeFileSync(npx, `#!/usr/bin/env bash\ncp "$4" "${dir}/bulk.json"\n`);
  chmodSync(npx, 0o755);
  const step = steps.find((s) => s.name === `Secrets for claudinite-${worker}`)!;
  const res = runStep(step, secrets, { PATH: `${dir}:${process.env.PATH}`, RUNNER_TEMP: dir });
  expect(res.status, res.stderr).toBe(0);
  return { bulk: JSON.parse(readFileSync(join(dir, "bulk.json"), "utf8")), dir };
}

const stepAt = (pred: (s: Step) => boolean) => steps.findIndex(pred);
const deployAt = (worker: string) => stepAt((s) => s.run?.includes(`wrangler deploy -c workers/${worker}/wrangler.jsonc`) ?? false);

describe("deploy.yml", () => {
  const listed = WORKERS.flatMap(readmeSecrets);
  const secrets = [...new Set(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", ...listed.map((s) => s.repo)])];
  const optional = listed.filter((s) => s.optional).map((s) => s.repo);

  it("deploys public-key, key, sync, then the router that binds to all three", () => {
    const order = WORKERS.map(deployAt);
    expect(order.every((i) => i > -1), JSON.stringify(order)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("creates the D1 database, writes its id, and applies the migrations before any Worker deploys", () => {
    const ensure = stepAt((s) => /node tools\/ensure-d1\.mjs --name claudinite-licenses --write/.test(s.run ?? ""));
    const migrate = stepAt((s) => /wrangler d1 migrations apply claudinite-licenses --remote -c db\/wrangler\.jsonc/.test(s.run ?? ""));
    expect(ensure).toBeGreaterThan(-1);
    expect(ensure).toBeLessThan(migrate);
    const firstDeploy = stepAt((s) => /wrangler deploy\b/.test(s.run ?? ""));
    expect(migrate).toBeLessThan(firstDeploy);
  });

  const ISSUING = ["ISSUING_KEY_PRIVATE", "ISSUING_KEY_CERT", "KEY_ISSUING_KEY_PRIVATE", "KEY_ISSUING_KEY_CERT"];
  const allBut = (...names: string[]) => Object.fromEntries(secrets.filter((s) => !names.includes(s)).map((s) => [s, "set"]));

  it("skips on each missing secret the Workers' READMEs list, other than the issuing keys and the optional ones", () => {
    expect(readmeSecrets("public-key").length).toBeGreaterThanOrEqual(4);
    expect(readmeSecrets("key").length).toBeGreaterThanOrEqual(5);
    expect(readmeSecrets("sync").length).toBeGreaterThanOrEqual(2);
    expect(readmeSecrets("router").length).toBeGreaterThanOrEqual(1);
    expect(optional).toEqual(["CLAUDINITE_GITHUB_APP_CLIENT_SECRET"]);
    for (const name of secrets.filter((s) => !ISSUING.includes(s) && !optional.includes(s))) {
      for (const issuing of [[], ISSUING]) {
        const res = runGate(allBut(name, ...issuing));
        expect(res.status, name).toBe(0);
        expect(res.stdout, name).toContain(`deploy skipped: missing ${name}`);
        expect(res.output, name).toBe("skip=true\n");
      }
    }
  });

  it("proceeds without the optional secrets", () => {
    const res = runGate(allBut(...optional));
    expect(res.status).toBe(0);
    expect(res.output).toBe("skip=false\n");
  });

  it("exits clean and skips with nothing set, and proceeds with everything set", () => {
    const none = runGate({});
    expect(none.status).toBe(0);
    expect(none.output).toBe("skip=true\n");
    const all = runGate(allBut());
    expect(all.status).toBe(0);
    expect(all.stdout).not.toContain("skipped");
    expect(all.stdout).not.toContain("::warning::");
    expect(all.output).toBe("skip=false\n");
  });

  const PAIRS: { worker: string; pair: string[]; dev: string }[] = [
    { worker: "public-key", pair: ["ISSUING_KEY_PRIVATE", "ISSUING_KEY_CERT"], dev: "license-public" },
    { worker: "key", pair: ["KEY_ISSUING_KEY_PRIVATE", "KEY_ISSUING_KEY_CERT"], dev: "license" },
  ];

  for (const { worker, pair, dev } of PAIRS) {
    it(`proceeds on the committed dev ${dev} key for claudinite-${worker}, with a warning naming the Worker and ClaudiniteEngine#5, when both its issuing keys are unset`, () => {
      const res = runGate(allBut(...pair));
      expect(res.status).toBe(0);
      expect(res.output).toBe("skip=false\n");
      const warnings = res.stdout.split("\n").filter((l) => l.startsWith("::warning::"));
      expect(warnings.some((w) => w.includes(`claudinite-${worker}`) && w.includes("ClaudiniteEngine#5")), res.stdout).toBe(true);
      const { bulk } = bulkSecrets(worker, { ...allBut(...pair), [pair[0]!]: "", [pair[1]!]: "" });
      expect(bulk.ISSUING_KEY_PRIVATE).toBe(readFileSync(join(ROOT, `keys/dev/${dev}.key`), "utf8"));
      expect(bulk.ISSUING_KEY_CERT).toBe(readFileSync(join(ROOT, `keys/dev/${dev}.cert.json`), "utf8"));
    });
  }

  it("warns about both Workers when both pairs are unset", () => {
    const res = runGate(allBut(...ISSUING));
    expect(res.stdout).toMatch(/^::warning::.*claudinite-public-key.*ClaudiniteEngine#5/m);
    expect(res.stdout).toMatch(/^::warning::.*claudinite-key\b.*ClaudiniteEngine#5/m);
  });

  it("fails when only one key of a pair is set, whatever else is missing", () => {
    for (const name of ISSUING) {
      for (const also of [[], ["CLOUDFLARE_API_TOKEN"]]) {
        const res = runGate(allBut(name, ...also));
        expect(res.status, name).not.toBe(0);
        expect(res.stdout + res.stderr, name).toContain(name);
        expect(res.output, name).toBe("");
      }
    }
  });

  it("stores each repository secret as the Worker secret its README names", () => {
    const values = Object.fromEntries(secrets.map((s) => [s, `value-of-${s}`]));
    for (const worker of WORKERS) {
      const want = Object.fromEntries(readmeSecrets(worker).map((s) => [s.worker, values[s.repo]]));
      const { bulk } = bulkSecrets(worker, values);
      const { SYNC_ADMIN_TOKEN: _generated, ...stored } = bulk;
      expect(stored, worker).toEqual(want);
    }
  });

  it("leaves an unset optional secret out of the Worker's secrets", () => {
    const values = Object.fromEntries(secrets.map((s) => [s, `value-of-${s}`]));
    const { bulk } = bulkSecrets("key", { ...values, CLAUDINITE_GITHUB_APP_CLIENT_SECRET: "" });
    expect(bulk).not.toHaveProperty("GITHUB_APP_CLIENT_SECRET");
  });

  it("generates a fresh SYNC_ADMIN_TOKEN each run and leaves it only for the read-back", () => {
    const values = Object.fromEntries(secrets.map((s) => [s, `value-of-${s}`]));
    const a = bulkSecrets("sync", values);
    const b = bulkSecrets("sync", values);
    expect(a.bulk.SYNC_ADMIN_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    expect(a.bulk.SYNC_ADMIN_TOKEN).not.toBe(b.bulk.SYNC_ADMIN_TOKEN);
    expect(readFileSync(join(a.dir, "sync-admin-token"), "utf8")).toBe(a.bulk.SYNC_ADMIN_TOKEN);
    expect(statSync(join(a.dir, "sync-admin-token")).mode & 0o777).toBe(0o600);
    const readBack = steps.find((s) => s.name === "Read back the live Workers")!;
    expect(readBack.run).toContain("sync-admin-token");
  });

  it("reads back the key and sync Workers, the reconcile, and a real OIDC token refused as an unpinned workflow", () => {
    expect(workflow.jobs.deploy.permissions).toEqual({ contents: "read", "id-token": "write" });
    const run = steps.find((s) => s.name === "Read back the live Workers")!.run!;
    for (const route of ["/v1/public/health", "/v1/key/health", "/v1/sync/health", "/v1/sync/reconcile", "/v1/actions-key", "/github-webhook"]) {
      expect(run, route).toContain(`https://license.claudinite.com${route}`);
    }
    expect(run).toContain("audience=claudinite");
    expect(run).toContain("workflow-not-pinned");
  });
});
