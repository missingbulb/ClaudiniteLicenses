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

  it("makes the writes queue and its dead-letter queue exist after the migrations and before the key and sync Workers deploy", () => {
    const queue = stepAt((s) => /node tools\/ensure-queue\.mjs --name claudinite-licenses-writes --dlq/.test(s.run ?? ""));
    const migrate = stepAt((s) => /wrangler d1 migrations apply/.test(s.run ?? ""));
    expect(queue).toBeGreaterThan(migrate);
    expect(queue).toBeLessThan(deployAt("key"));
    expect(queue).toBeLessThan(deployAt("sync"));
  });

  const webhookStep = () => steps.find((s) => /node tools\/ensure-polar-webhook\.mjs/.test(s.run ?? ""))!;

  it("makes the Polar webhook endpoint exist before the sync Worker's secrets, on the sandbox API both Workers point at", () => {
    const at = steps.indexOf(webhookStep());
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(stepAt((s) => s.name === "Secrets for claudinite-sync"));
    expect(webhookStep().run).toContain("--url https://license.claudinite.com/v1/sync/polar-webhook");
    expect(webhookStep().env).toMatchObject({ POLAR_ACCESS_TOKEN: "${{ secrets.POLAR_SANDBOX_TOKEN }}" });
    const parseJsonc = (w: string) => JSON.parse(readFileSync(join(ROOT, `workers/${w}/wrangler.jsonc`), "utf8").replace(/^\s*\/\/.*$/gm, ""));
    for (const w of ["key", "sync"]) expect(parseJsonc(w).vars.POLAR_API_BASE, w).toBe(webhookStep().env!.POLAR_API_BASE);
    expect(workflow.on.workflow_dispatch.inputs.rotate_polar_webhook).toMatchObject({ type: "boolean", default: false });
  });

  // Runs the webhook step with a curl answering the live health and a node that records the tool's arguments.
  function webhookArgs(health: string, rotate: string): string {
    const dir = mkdtempSync(join(tmpdir(), "acme-webhook-"));
    writeFileSync(join(dir, "curl"), `#!/usr/bin/env bash\nprintf '%s' '${health}'\n`);
    writeFileSync(join(dir, "node"), `#!/usr/bin/env bash\nif [ "$1" = tools/ensure-polar-webhook.mjs ]; then echo "$@" > "${dir}/args"; else exec "${process.execPath}" "$@"; fi\n`);
    chmodSync(join(dir, "curl"), 0o755);
    chmodSync(join(dir, "node"), 0o755);
    const res = runStep({ ...webhookStep(), env: { ...webhookStep().env, ROTATE: rotate } }, { POLAR_SANDBOX_TOKEN: "t" }, { PATH: `${dir}:${process.env.PATH}`, RUNNER_TEMP: dir });
    expect(res.status, res.stderr).toBe(0);
    return readFileSync(join(dir, "args"), "utf8").trim();
  }

  it("rotates the endpoint when the live sync Worker reports no secret or the dispatch input asks, and keeps it otherwise", () => {
    expect(webhookStep().env!.ROTATE).toBe("${{ inputs.rotate_polar_webhook }}");
    expect(webhookArgs('{"polar_webhook_secret":true}', "")).not.toContain("--rotate");
    expect(webhookArgs('{"polar_webhook_secret":false}', "")).toMatch(/--rotate$/);
    expect(webhookArgs('{"ok":true}', "")).toMatch(/--rotate$/);
    expect(webhookArgs("not json", "")).toMatch(/--rotate$/);
    expect(webhookArgs('{"polar_webhook_secret":true}', "true")).toMatch(/--rotate$/);
    expect(webhookArgs('{"polar_webhook_secret":true}', "false")).toMatch(/--secret-out \S+polar-webhook-secret$/);
  });

  it("stores POLAR_WEBHOOK_SECRET only when the webhook step wrote its file", () => {
    const values = Object.fromEntries(secrets.map((s) => [s, `value-of-${s}`]));
    expect(bulkSecrets("sync", values).bulk).not.toHaveProperty("POLAR_WEBHOOK_SECRET");
    const dir = mkdtempSync(join(tmpdir(), "acme-bulk-"));
    writeFileSync(join(dir, "npx"), `#!/usr/bin/env bash\ncp "$4" "${dir}/bulk.json"\n`);
    chmodSync(join(dir, "npx"), 0o755);
    writeFileSync(join(dir, "polar-webhook-secret"), "whsec_acme");
    const res = runStep(steps.find((s) => s.name === "Secrets for claudinite-sync")!, values, { PATH: `${dir}:${process.env.PATH}`, RUNNER_TEMP: dir });
    expect(res.status, res.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "bulk.json"), "utf8")).POLAR_WEBHOOK_SECRET).toBe("whsec_acme");
    expect(existsSync(join(dir, "polar-webhook-secret"))).toBe(false);
  });

  it("deploys the key Worker with TRUST_ROOTS from tools/keys.mjs trust-roots", () => {
    const dir = mkdtempSync(join(tmpdir(), "acme-deploy-"));
    writeFileSync(join(dir, "npx"), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${dir}/args"\n`);
    chmodSync(join(dir, "npx"), 0o755);
    const res = runStep(steps[deployAt("key")]!, {}, { PATH: `${dir}:${process.env.PATH}` });
    expect(res.status, res.stderr).toBe(0);
    const args = readFileSync(join(dir, "args"), "utf8").trim().split("\n");
    const v = args[args.indexOf("--var") + 1]!;
    expect(v.split(":")[0]).toBe("TRUST_ROOTS");
    expect(JSON.parse(v.slice("TRUST_ROOTS:".length))).toEqual([readFileSync(join(ROOT, "keys/dev/roots/root.pub"), "utf8").trim()]);
  });

  it("reads back the queue, Polar, the Polar reconcile and a live checkout whose checkout.created delivery reaches the sync Worker", () => {
    const step = steps.find((s) => s.name === "Read back the live Workers")!;
    const run = step.run!;
    expect(run).toContain('b.queue==="bound"');
    expect(run).toContain('b.polar==="configured"');
    expect(run).toContain("b.polar_webhook_secret===true");
    expect(run).toContain("https://license.claudinite.com/v1/sync/polar-reconcile");
    expect(run).toContain("b.last_polar_reconcile_at>=$started");
    expect(run).toMatch(/node tools\/polar-checkout\.mjs --plan private-repo --owner-id "\$GITHUB_REPOSITORY_OWNER_ID" --owner-login "\$GITHUB_REPOSITORY_OWNER" --owner-type "\$OWNER_TYPE" --repo-id "\$GITHUB_REPOSITORY_ID" --repo "\$GITHUB_REPOSITORY"/);
    expect(run).toContain("b.last_polar_webhook_at>=$started");
    expect(run.indexOf("polar-checkout.mjs")).toBeLessThan(run.indexOf("b.last_polar_webhook_at>=$started"));
    expect(step.env).toMatchObject({ POLAR_ACCESS_TOKEN: "${{ secrets.POLAR_SANDBOX_TOKEN }}", OWNER_TYPE: "${{ github.event.repository.owner.type }}" });
  });
});
