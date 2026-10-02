import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// A workflow cannot run here; these read deploy.yml and run its step scripts the way Actions would,
// resolving `${{ secrets.NAME }}` in the job's and the step's env from a stand-in secrets store.
const ROOT = resolve(import.meta.dirname, "../..");
const workflow = parse(readFileSync(join(ROOT, ".github/workflows/deploy.yml"), "utf8"));
type Step = { id?: string; name?: string; run?: string; env?: Record<string, string>; if?: string };
const job: { env?: Record<string, string>; steps: Step[] } = workflow.jobs.deploy;
const steps = job.steps;
// The sync judge's lag bound is the queue-lagging alert's; read from its source, since the tools
// project carries no Workers types to import it with.
const QUEUE_LAG_MAX_S = Number(/^export const QUEUE_LAG_MAX_S = (\d+);$/m.exec(readFileSync(join(ROOT, "workers/sync/src/alerts.ts"), "utf8"))![1]);
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

// `${{ secrets.NAME }}` resolves from `secrets`, `${{ vars.NAME }}` from `vars`, each empty when unset, as Actions does.
function resolveEnv(env: Record<string, string> | undefined, secrets: Record<string, string>, vars: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    const m = /^\$\{\{\s*(secrets|vars)\.([A-Z0-9_]+)\s*\}\}$/.exec(String(v));
    out[k] = m ? ((m[1] === "vars" ? vars : secrets)[m[2]!] ?? "") : String(v);
  }
  return out;
}

function runStep(step: Step, secrets: Record<string, string>, extra: Record<string, string> = {}, opts: { cwd?: string; vars?: Record<string, string> } = {}) {
  return spawnSync("bash", ["-e", "-c", step.run!], {
    cwd: opts.cwd ?? ROOT,
    env: { PATH: process.env.PATH!, ...resolveEnv(job.env, secrets, opts.vars), ...resolveEnv(step.env, secrets, opts.vars), ...extra },
    encoding: "utf8",
  });
}

function runGate(secrets: Record<string, string>) {
  const out = join(mkdtempSync(join(tmpdir(), "acme-gate-")), "output");
  const res = runStep(gate, secrets, { GITHUB_OUTPUT: out });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, output: existsSync(out) ? readFileSync(out, "utf8") : "" };
}

// A stand-in `node` on PATH: `node tools/stage.mjs ...` records its argv, keeps any secrets file it
// was handed, writes its --json answer and fails when STAGE_FAIL names `<command>:<worker>`;
// `node tools/push-queue-message.mjs ...` appends `push <args>` to the order log and exits PUSH_EXIT;
// every other node invocation runs the real node. The stand-in `npx` logs its arguments, keeps the
// file a `wrangler deploy --secrets-file` was handed, and fails a `wrangler deploy` when NPX_FAIL is set.
function standIns(): string {
  const dir = mkdtempSync(join(tmpdir(), "acme-stage-"));
  writeFileSync(
    join(dir, "stage-stub.cjs"),
    `const fs = require("fs");
const args = process.argv.slice(2);
const dir = ${JSON.stringify(dir)};
fs.appendFileSync(dir + "/stage.log", JSON.stringify(args) + "\\n");
const cmd = args[0];
const opt = (n) => (args.indexOf(n) >= 0 ? args[args.indexOf(n) + 1] : undefined);
const worker = /workers\\/([^/]+)\\//.exec(opt("--config") || "")[1];
if (opt("--secrets-file")) fs.copyFileSync(opt("--secrets-file"), dir + "/secrets-" + worker + ".json");
if (process.env.STAGE_FAIL === cmd + ":" + worker) { console.error("stage stub failing " + cmd + " " + worker); process.exit(1); }
const answers = {
  upload: { version_id: "new-" + worker },
  status: JSON.parse(process.env["STATUS_" + worker.replace("-", "_").toUpperCase()] || JSON.stringify({ versions: [{ id: "live-" + worker, percentage: 100 }] })),
  split: { deployed: [], previous: "live-" + worker },
  tag: { tag: process.env["TAG_" + worker.replace("-", "_").toUpperCase()] || null },
};
const out = answers[cmd] || { ok: true };
console.log(JSON.stringify(out));
if (opt("--json")) fs.writeFileSync(opt("--json"), JSON.stringify(out));
`,
  );
  writeFileSync(
    join(dir, "node"),
    `#!/usr/bin/env bash\nif [ "$1" = tools/stage.mjs ]; then shift; exec "${process.execPath}" "${dir}/stage-stub.cjs" "$@"; fi\nif [ "$1" = tools/push-queue-message.mjs ]; then shift; echo "push $*" >> "${dir}/order"; exit "\${PUSH_EXIT:-0}"; fi\nexec "${process.execPath}" "$@"\n`,
  );
  writeFileSync(
    join(dir, "npx"),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${dir}/npx.log"\nprev=""; for a in "$@"; do [ "$prev" = --secrets-file ] && cp "$a" "${dir}/deploy-secrets.json"; prev=$a; done\nif [ "$1 $2" = "wrangler deploy" ] && [ -n "$NPX_FAIL" ]; then echo "npx stub failing wrangler deploy" >&2; exit 1; fi\n`,
  );
  for (const f of ["node", "npx"]) chmodSync(join(dir, f), 0o755);
  return dir;
}

function stageCalls(dir: string): string[][] {
  return existsSync(join(dir, "stage.log")) ? readFileSync(join(dir, "stage.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
}

function runWithStandIns(step: Step, secrets: Record<string, string> = {}, extra: Record<string, string> = {}, vars: Record<string, string> = {}) {
  const dir = standIns();
  const res = runStep(step, secrets, { PATH: `${dir}:${process.env.PATH}`, RUNNER_TEMP: dir, GITHUB_OUTPUT: join(dir, "output"), GITHUB_STEP_SUMMARY: join(dir, "summary"), GITHUB_SHA: "0123456789abcdef", RUN_URL: "https://github.test/acme/runs/1", ...extra }, { vars });
  const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : "");
  return { ...res, dir, calls: stageCalls(dir), output: read("output"), summary: read("summary"), npx: read("npx.log") };
}

const uploadStep = (worker: string) => steps.find((s) => (s.run ?? "").split("\n").some((l) => l.trim().startsWith(`node tools/stage.mjs upload --config workers/${worker}/wrangler.jsonc`)));

const syncDeployStep = () => steps.find((s) => s.name === "Deploy claudinite-sync with its secrets")!;
const NEW_SYNC = '{"versions":[{"id":"new-sync","percentage":100}]}';

// Runs the sync Worker's deploy with the stand-ins, after the webhook step left its secret file when `webhookSecret` is given.
function syncDeployRun(secrets: Record<string, string>, opts: { webhookSecret?: string; extra?: Record<string, string> } = {}) {
  const dir = standIns();
  if (opts.webhookSecret !== undefined) writeFileSync(join(dir, "polar-webhook-secret"), opts.webhookSecret);
  const res = runStep(syncDeployStep(), secrets, { PATH: `${dir}:${process.env.PATH}`, RUNNER_TEMP: dir, GITHUB_OUTPUT: join(dir, "output"), RUN_URL: "https://github.test/acme/runs/1", LIVE: "live-sync", STATUS_SYNC: NEW_SYNC, ...opts.extra });
  const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : "");
  return { ...res, dir, calls: stageCalls(dir), output: read("output"), npx: read("npx.log") };
}

// The secrets a Worker is given: the file its upload carries, or the file the sync Worker's `wrangler deploy` carries.
function storedSecrets(worker: string, secrets: Record<string, string>): { bulk: Record<string, string>; dir: string } {
  const res = worker === "sync" ? syncDeployRun(secrets) : runWithStandIns(uploadStep(worker)!, secrets);
  expect(res.status, res.stderr).toBe(0);
  const file = worker === "sync" ? "deploy-secrets.json" : `secrets-${worker}.json`;
  return { bulk: JSON.parse(readFileSync(join(res.dir, file), "utf8")), dir: res.dir };
}

const stepAt = (pred: (s: Step) => boolean) => steps.findIndex(pred);
const deployAt = (worker: string) => stepAt((s) => s.run?.includes(`wrangler deploy -c workers/${worker}/wrangler.jsonc`) ?? false);
const uploadAt = (worker: string) => steps.indexOf(uploadStep(worker)!);

describe("deploy.yml", () => {
  const listed = WORKERS.flatMap(readmeSecrets);
  const secrets = [...new Set(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", ...listed.map((s) => s.repo)])];
  const optional = listed.filter((s) => s.optional).map((s) => s.repo);

  it("uploads public-key and key, deploys sync, then uploads the router that binds to all three", () => {
    const order = [uploadAt("public-key"), uploadAt("key"), deployAt("sync"), uploadAt("router")];
    expect(order.every((i) => i > -1), JSON.stringify(order)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const w of ["public-key", "key", "router"]) expect(deployAt(w), w).toBe(-1);
  });

  it("creates the D1 database, writes its id, records the restore point, and applies the migrations before any Worker deploys", () => {
    const ensure = stepAt((s) => /node tools\/ensure-d1\.mjs --name claudinite-licenses --write/.test(s.run ?? ""));
    const point = stepAt((s) => /npx wrangler d1 time-travel info claudinite-licenses --json -c db\/wrangler\.jsonc/.test(s.run ?? ""));
    const migrate = stepAt((s) => /wrangler d1 migrations apply claudinite-licenses --remote -c db\/wrangler\.jsonc/.test(s.run ?? ""));
    expect(ensure).toBeGreaterThan(-1);
    expect(ensure).toBeLessThan(point);
    expect(point).toBeLessThan(migrate);
    const firstDeploy = stepAt((s) => /wrangler deploy\b|stage\.mjs upload/.test(s.run ?? ""));
    expect(migrate).toBeLessThan(firstDeploy);
  });

  const pointStep = () => steps.find((s) => /npx wrangler d1 time-travel info claudinite-licenses/.test(s.run ?? ""))!;

  it("writes the bookmark into the summary as the exact d1-restore dispatch, with the window", () => {
    const dir = mkdtempSync(join(tmpdir(), "acme-point-"));
    writeFileSync(join(dir, "npx"), `#!/usr/bin/env bash\necho ' wrangler 4.145.0'\necho '{"bookmark": "00000085-0000024c-00004c6d-8e61117b"}'\n`);
    chmodSync(join(dir, "npx"), 0o755);
    const res = runStep(pointStep(), {}, { PATH: `${dir}:${process.env.PATH}`, RUNNER_TEMP: dir, GITHUB_STEP_SUMMARY: join(dir, "summary") });
    expect(res.status, res.stderr).toBe(0);
    const summary = readFileSync(join(dir, "summary"), "utf8");
    expect(summary).toContain("gh workflow run d1-restore.yml -f bookmark=00000085-0000024c-00004c6d-8e61117b");
    expect(summary).toMatch(/7 days on Workers Free, 30 on Workers Paid/);
    writeFileSync(join(dir, "npx"), `#!/usr/bin/env bash\necho '{}'\n`);
    expect(runStep(pointStep(), {}, { PATH: `${dir}:${process.env.PATH}`, RUNNER_TEMP: dir, GITHUB_STEP_SUMMARY: join(dir, "summary") }).status).not.toBe(0);
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
      const { bulk } = storedSecrets(worker, { ...allBut(...pair), [pair[0]!]: "", [pair[1]!]: "" });
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
      const { bulk } = storedSecrets(worker, values);
      const { SYNC_ADMIN_TOKEN: _generated, ...stored } = bulk;
      expect(stored, worker).toEqual(want);
    }
  });

  it("leaves an unset optional secret out of the Worker's secrets", () => {
    const values = Object.fromEntries(secrets.map((s) => [s, `value-of-${s}`]));
    const { bulk } = storedSecrets("key", { ...values, CLAUDINITE_GITHUB_APP_CLIENT_SECRET: "" });
    expect(bulk).not.toHaveProperty("GITHUB_APP_CLIENT_SECRET");
  });

  it("generates a fresh SYNC_ADMIN_TOKEN each run and leaves it only for the read-back", () => {
    const values = Object.fromEntries(secrets.map((s) => [s, `value-of-${s}`]));
    const a = storedSecrets("sync", values);
    const b = storedSecrets("sync", values);
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
    expect(queue).toBeLessThan(uploadAt("key"));
    expect(queue).toBeLessThan(deployAt("sync"));
  });

  const webhookStep = () => steps.find((s) => /node tools\/ensure-polar-webhook\.mjs/.test(s.run ?? ""))!;

  it("makes the Polar webhook endpoint exist before the sync Worker's secrets, on the sandbox API both Workers point at", () => {
    const at = steps.indexOf(webhookStep());
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(steps.indexOf(syncDeployStep()));
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
    expect(storedSecrets("sync", values).bulk).not.toHaveProperty("POLAR_WEBHOOK_SECRET");
    const res = syncDeployRun(values, { webhookSecret: "whsec_acme" });
    expect(res.status, res.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(res.dir, "deploy-secrets.json"), "utf8")).POLAR_WEBHOOK_SECRET).toBe("whsec_acme");
    expect(existsSync(join(res.dir, "polar-webhook-secret"))).toBe(false);
  });

  it("uploads the key Worker with TRUST_ROOTS from tools/keys.mjs trust-roots", () => {
    const res = runWithStandIns(uploadStep("key")!);
    expect(res.status, res.stderr).toBe(0);
    const args = res.calls[0]!;
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

  it("no longer fetches the hosted checkout page: the checkout.created delivery is the whole proof", () => {
    const run = steps.find((s) => s.name === "Read back the live Workers")!.run!;
    const checkoutLines = run.split("\n").filter((l) => /\$checkout\b|\$\{checkout\}/.test(l) && !/^\s*#/.test(l));
    expect(checkoutLines.filter((l) => /\b(curl|probe)\b/.test(l))).toEqual([]);
  });

  const readBackAt = () => stepAt((s) => s.name === "Read back the live Workers");
  const alertsStep = () => steps.slice(readBackAt() + 1).find((s) => (s.run ?? "").includes("https://license.claudinite.com/v1/sync/alerts"));
  const probeStep = () => steps.find((s) => (s.run ?? "").split("\n").some((l) => /^\s*node tools\/probe\.mjs\b/.test(l) && !l.includes("--expect-version")));

  it("reads the alerts back, then runs the outside probe without --issue, with the run's OIDC token", () => {
    const alerts = alertsStep();
    const probe = probeStep();
    expect(alerts).toBeDefined();
    expect(probe).toBeDefined();
    expect(steps.indexOf(alerts!)).toBeGreaterThan(steps.findIndex((s) => s.name === "Read back the live Workers"));
    expect(steps.indexOf(alerts!)).toBeLessThan(steps.indexOf(probe!));
    const line = probe!.run!.split("\n").find((l) => /^\s*node tools\/probe\.mjs\b/.test(l))!;
    expect(line).toContain("--base https://license.claudinite.com");
    expect(line).toMatch(/--oidc-token-env \w+/);
    expect(line).not.toMatch(/--issue\b/);
    expect(probe!.run).toContain("audience=claudinite");
  });

  // Runs the alerts step with a curl that answers `status` and `body`.
  function alertsRun(status: number, body: string) {
    const dir = mkdtempSync(join(tmpdir(), "acme-alerts-"));
    writeFileSync(join(dir, "curl"), `#!/usr/bin/env bash\nout=""\nwhile [ $# -gt 0 ]; do if [ "$1" = -o ]; then out=$2; shift; fi; shift; done\nprintf '%s' '${body}' > "$out"\nprintf '%s' '${status}'\n`);
    chmodSync(join(dir, "curl"), 0o755);
    return runStep(alertsStep()!, {}, { PATH: `${dir}:${process.env.PATH}`, RUNNER_TEMP: dir });
  }

  it("reports a standing alert without failing the deploy, and fails only on a body that is not the alerts shape", () => {
    const clear = alertsRun(200, '{"ok":true,"checked_at":1,"alerts":[]}');
    expect(clear.status, clear.stderr).toBe(0);
    const standing = alertsRun(503, '{"ok":false,"checked_at":1,"alerts":[{"id":"polar-reconcile-corrected","since":1,"detail":"1"}]}');
    expect(standing.status, standing.stderr).toBe(0);
    expect(standing.stdout).toMatch(/::warning::.*polar-reconcile-corrected/);
    expect(alertsRun(200, "not json").status).not.toBe(0);
    expect(alertsRun(502, '{"ok":false,"alerts":[]}').status).not.toBe(0);
  });

  const STAGED = ["public-key", "key", "router"];
  const named = (name: string) => steps.find((s) => s.name === name)!;
  const runLines = (step: Step) => (step.run ?? "").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

  it("stores no secret with secret bulk for any Worker: each upload carries its secrets file, tag and run URL", () => {
    const bulkLines = steps.flatMap(runLines).filter((l) => /secret bulk/.test(l));
    expect(bulkLines).toEqual([]);
    for (const w of STAGED) {
      const res = runWithStandIns(uploadStep(w)!);
      expect(res.status, res.stderr).toBe(0);
      expect(res.calls, w).toHaveLength(1);
      const args = res.calls[0]!;
      expect(args.slice(0, 3), w).toEqual(["upload", "--config", `workers/${w}/wrangler.jsonc`]);
      expect(args[args.indexOf("--secrets-file") + 1], w).toBe(join(res.dir, `${w}.secrets.json`));
      expect(args[args.indexOf("--tag") + 1], w).toBe("0123456");
      expect(args[args.indexOf("--message") + 1], w).toBe("https://github.test/acme/runs/1");
      expect(res.output.split("\n").filter((l) => l.startsWith("version_id=")), w).toEqual([`version_id=new-${w}`]);
    }
    expect(job.env!.RUN_URL).toBe("${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}");
  });

  it("removes each secrets file in the step that made it, also when the upload fails", () => {
    for (const w of STAGED) {
      for (const fail of ["", `upload:${w}`]) {
        const res = runWithStandIns(uploadStep(w)!, {}, { STAGE_FAIL: fail });
        expect(res.status === 0, `${w} ${fail}`).toBe(fail === "");
        expect(existsSync(join(res.dir, `secrets-${w}.json`)), w).toBe(true);
        expect(existsSync(join(res.dir, `${w}.secrets.json`)), `${w} ${fail}`).toBe(false);
      }
    }
  });

  it("deploys the sync Worker with wrangler deploy carrying its secrets file, and keeps its live version for a rollback", () => {
    expect(steps.indexOf(syncDeployStep())).toBe(deployAt("sync"));
    const res = syncDeployRun({});
    expect(res.status, res.stderr).toBe(0);
    expect(readFileSync(join(res.dir, "staged/sync"), "utf8")).toBe("live-sync");
    expect(res.npx.trim()).toBe(`wrangler deploy -c workers/sync/wrangler.jsonc --secrets-file ${join(res.dir, "sync.secrets.json")}`);
    expect(syncDeployStep().env).toMatchObject({ LIVE: "${{ steps.live.outputs.sync }}" });
    expect(syncDeployStep().id).toBe("deploy-sync");
  });

  it("reads the deployed sync version from stage.mjs status right after wrangler deploy and outputs it as version_id", () => {
    const res = syncDeployRun({});
    expect(res.status, res.stderr).toBe(0);
    expect(res.calls.map((c) => c.slice(0, 3).join(" "))).toEqual(["status --config workers/sync/wrangler.jsonc"]);
    expect(res.output.split("\n").filter((l) => l.startsWith("version_id="))).toEqual(["version_id=new-sync"]);
    const split = syncDeployRun({}, { extra: { STATUS_SYNC: '{"versions":[{"id":"a","percentage":90},{"id":"b","percentage":10}]}' } });
    expect(split.status).not.toBe(0);
    expect(split.output).not.toContain("version_id=");
  });

  it("removes the sync secrets file and the webhook secret in the step that made them, also when wrangler deploy fails", () => {
    for (const fail of ["", "1"]) {
      const res = syncDeployRun({}, { webhookSecret: "whsec_acme", extra: { NPX_FAIL: fail } });
      expect(res.status === 0, fail).toBe(fail === "");
      expect(existsSync(join(res.dir, "deploy-secrets.json")), fail).toBe(true);
      expect(existsSync(join(res.dir, "sync.secrets.json")), fail).toBe(false);
      expect(existsSync(join(res.dir, "polar-webhook-secret")), fail).toBe(false);
      expect(readFileSync(join(res.dir, "staged/sync"), "utf8"), fail).toBe("live-sync");
    }
  });

  it("judges the sync Worker by its health and alerts right after its deploy, before the router uploads", () => {
    const judge = stepAt((s) => (s.run ?? "").includes("https://license.claudinite.com/v1/sync/health") && (s.run ?? "").includes("https://license.claudinite.com/v1/sync/alerts") && s.name !== "Read back the live Workers");
    expect(judge).toBe(deployAt("sync") + 1);
    expect(judge).toBeLessThan(uploadAt("router"));
  });

  it("reads every Worker's live version first, and refuses to start on a split left standing", () => {
    const live = named("Read the live versions");
    expect(steps.indexOf(live)).toBeLessThan(uploadAt("public-key"));
    const res = runWithStandIns(live);
    expect(res.status, res.stderr).toBe(0);
    expect(res.calls.map((c) => c.slice(0, 3).join(" "))).toEqual(WORKERS.map((w) => `status --config workers/${w}/wrangler.jsonc`));
    expect(res.output).toBe("public_key=live-public-key\nkey=live-key\nsync=live-sync\nrouter=live-router\n");
    const fresh = runWithStandIns(live, {}, { STATUS_ROUTER: '{"versions":[]}' });
    expect(fresh.status, fresh.stderr).toBe(0);
    expect(fresh.output).toContain("router=\n");
    const stuck = runWithStandIns(live, {}, { STATUS_KEY: '{"versions":[{"id":"a","percentage":90},{"id":"b","percentage":10}]}' });
    expect(stuck.status).not.toBe(0);
    expect(stuck.stdout).toMatch(/^::error::claudinite-key has a split standing; roll it back by hand with node tools\/stage\.mjs rollback/m);
  });

  const splitEnv = { PUBLIC_KEY_NEW: "new-public-key", KEY_NEW: "new-key", ROUTER_NEW: "new-router", PUBLIC_KEY_LIVE: "live-public-key", KEY_LIVE: "live-key", ROUTER_LIVE: "live-router" };

  it("splits public-key, key and router at one tenth, in that order, noting each live version before its split", () => {
    const split = named("Serve the new versions to one tenth of requests");
    expect(steps.indexOf(split)).toBeGreaterThan(uploadAt("router"));
    const res = runWithStandIns(split, {}, splitEnv);
    expect(res.status, res.stderr).toBe(0);
    expect(res.calls.map((c) => c.slice(0, 7))).toEqual(STAGED.map((w) => ["split", "--config", `workers/${w}/wrangler.jsonc`, "--new", `new-${w}`, "--percent", "10"]));
    for (const w of STAGED) expect(readFileSync(join(res.dir, `staged/${w}`), "utf8")).toBe(`live-${w}`);
    expect(res.output).toBe("public_key_previous=live-public-key\nkey_previous=live-key\nrouter_previous=live-router\n");
    const broken = runWithStandIns(split, {}, { ...splitEnv, STAGE_FAIL: "split:key" });
    expect(broken.status).not.toBe(0);
    expect(["public-key", "key", "router"].map((w) => existsSync(join(broken.dir, `staged/${w}`)))).toEqual([true, true, false]);
  });

  const canaryStep = () => steps.find((s) => runLines(s).some((l) => l.startsWith("node tools/probe.mjs") && l.includes("--expect-version")))!;

  it("probes the new versions by name after the split and the DNS, without the standing issue", () => {
    const canary = canaryStep();
    expect(canary.id).toBe("canary");
    expect(steps.indexOf(canary)).toBeGreaterThan(steps.indexOf(named("Serve the new versions to one tenth of requests")));
    expect(steps.indexOf(canary)).toBeGreaterThan(stepAt((s) => (s.run ?? "").includes("tools/ensure-dns.mjs")));
    const line = runLines(canary).find((l) => l.startsWith("node tools/probe.mjs"))!;
    expect(line).toContain('--expect-version "public-key=$PUBLIC_KEY_NEW,key=$KEY_NEW,router=$ROUTER_NEW"');
    expect(line).toContain("--base https://license.claudinite.com");
    expect(line).toMatch(/--oidc-token-env \w+/);
    expect(line).not.toMatch(/--issue\b/);
    expect(canary.env).toMatchObject({ PUBLIC_KEY_NEW: "${{ steps.upload-public-key.outputs.version_id }}", KEY_NEW: "${{ steps.upload-key.outputs.version_id }}", ROUTER_NEW: "${{ steps.upload-router.outputs.version_id }}" });
  });

  it("promotes only on the canary's success, then applies triggers for all four Workers", () => {
    const promote = named("Promote the new versions to all requests");
    expect(promote.if).toContain("steps.canary.outcome == 'success'");
    expect(steps.indexOf(promote)).toBe(steps.indexOf(canaryStep()) + 1);
    const res = runWithStandIns(promote, {}, splitEnv);
    expect(res.status, res.stderr).toBe(0);
    expect(res.calls.map((c) => c.join(" "))).toEqual([
      ...STAGED.map((w) => `promote --config workers/${w}/wrangler.jsonc --id new-${w}`),
      ...WORKERS.map((w) => `triggers --config workers/${w}/wrangler.jsonc`),
    ]);
    expect(steps.indexOf(promote)).toBeLessThan(steps.indexOf(named("Read back the live Workers")));
  });

  it("rolls every staged Worker back to its live version on any failure, the read-back's included", () => {
    const rollback = named("Roll back to the versions that were live");
    expect(rollback.if).toMatch(/^failure\(\) && /);
    expect(steps.indexOf(rollback)).toBe(steps.length - 1);
    const dir = standIns();
    mkdirSync(join(dir, "staged"));
    writeFileSync(join(dir, "staged/public-key"), "live-public-key");
    writeFileSync(join(dir, "staged/key"), "");
    writeFileSync(join(dir, "staged/sync"), "live-sync");
    const res = runStep(rollback, {}, { PATH: `${dir}:${process.env.PATH}`, RUNNER_TEMP: dir });
    expect(res.status, res.stderr).toBe(0);
    expect(stageCalls(dir).filter((c) => c[0] === "rollback").map((c) => c.join(" "))).toEqual(["rollback --config workers/public-key/wrangler.jsonc --id live-public-key", "rollback --config workers/sync/wrangler.jsonc --id live-sync"]);
    expect(res.stdout).toMatch(/^::warning::claudinite-key had no live version/m);
    expect(res.stdout).toMatch(/^::error::claudinite-public-key rolled back to live-public-key$/m);
    const failing = runStep(rollback, {}, { PATH: `${dir}:${process.env.PATH}`, RUNNER_TEMP: dir, STAGE_FAIL: "rollback:sync" });
    expect(failing.status).not.toBe(0);
    expect(failing.stdout).toMatch(/claudinite-sync could not be rolled back/);
  });

  it("rehearses the D1 restore only on the dispatch input", () => {
    const rehearse = steps.find((s) => runLines(s).includes("node tools/d1-restore-rehearsal.mjs"))!;
    expect(rehearse.if).toContain("inputs.rehearse_d1_restore");
    expect(workflow.on.workflow_dispatch.inputs.rehearse_d1_restore).toMatchObject({ type: "boolean", default: false });
    expect(workflow.on.workflow_dispatch.inputs.rotate_polar_webhook).toMatchObject({ type: "boolean", default: false });
  });

  // ClaudiniteLicenses#18

  it("reads the live versions before the restore point and the database, right after npm ci", () => {
    const live = stepAt((s) => s.name === "Read the live versions");
    const ci = stepAt((s) => s.run === "npm ci");
    expect(live).toBe(ci + 1);
    expect(live).toBeLessThan(stepAt((s) => /node tools\/ensure-d1\.mjs/.test(s.run ?? "")));
    expect(live).toBeLessThan(stepAt((s) => /wrangler d1 time-travel info/.test(s.run ?? "")));
  });

  const judgeStep = () => named("Judge claudinite-sync by its own health and alerts");

  const STAMPED = '"last_queue_at":9999999999,"last_queue_version":"new-sync","queue_lag_s":2';
  const HEALTHY = `{"ok":true,"ip_limit":"counted",${STAMPED}}`;

  // Runs the judge with the stand-ins and a curl answering `health` on /v1/sync/health and 200 alerts,
  // the marker the deploy wrote in place, the deployed version new-sync. `body` may list several
  // health bodies separated by `|`, answered in turn, the last one repeating. Each health read, alerts
  // read and push is appended to the order log.
  function judgeRun(health: number, body = HEALTHY, extra: Record<string, string> = {}) {
    const dir = standIns();
    mkdirSync(join(dir, "staged"));
    writeFileSync(join(dir, "staged/sync"), "live-sync");
    writeFileSync(
      join(dir, "curl"),
      `#!/usr/bin/env bash\nout=""; url=""\nwhile [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift;; https://*) url=$1;; esac; shift; done\nif [ "\${url##*/}" = health ]; then echo health >> "${dir}/order"; n=$(( $(cat "${dir}/reads" 2>/dev/null || echo 0) + 1 )); echo $n > "${dir}/reads"; IFS='|' read -ra bodies <<< '${body}'; i=$(( n <= \${#bodies[@]} ? n - 1 : \${#bodies[@]} - 1 )); printf '%s' "\${bodies[$i]}" > "$out"; printf '${health}'; else echo alerts >> "${dir}/order"; printf '{"ok":true,"alerts":[]}' > "$out"; printf 200; fi\n`,
    );
    writeFileSync(join(dir, "sleep"), `#!/usr/bin/env bash\necho "$@" >> "${dir}/sleeps"\n`);
    for (const f of ["curl", "sleep"]) chmodSync(join(dir, f), 0o755);
    const res = runStep(judgeStep(), { CLOUDFLARE_API_TOKEN: "cf-token", CLOUDFLARE_ACCOUNT_ID: "acct" }, { PATH: `${dir}:${process.env.PATH}`, RUNNER_TEMP: dir, RUN_URL: "https://github.test/acme/runs/1", SYNC_VERSION: "new-sync", ...extra });
    const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8").trim().split("\n") : []);
    return { ...res, dir, order: read("order"), sleeps: read("sleeps") };
  }

  it("closes the sync Worker's rollback window once its own judge passes, and keeps it open when the judge fails", () => {
    const passed = judgeRun(200);
    expect(passed.status, passed.stderr).toBe(0);
    expect(existsSync(join(passed.dir, "staged/sync"))).toBe(false);
    expect(existsSync(join(passed.dir, "sync-judged"))).toBe(true);
    const failed = judgeRun(503);
    expect(failed.status).not.toBe(0);
    expect(existsSync(join(failed.dir, "staged/sync"))).toBe(true);
  });

  it("fails the sync Worker's judge unless its health says the per-address cap counted the read", () => {
    for (const state of ["unbound", "unavailable"]) {
      const res = judgeRun(200, `{"ok":true,"ip_limit":"${state}",${STAMPED}}`);
      expect(res.status, state).not.toBe(0);
      expect(res.stdout, state).toContain(`::error::claudinite-sync's health reports ip_limit ${state}`);
      expect(existsSync(join(res.dir, "staged/sync")), state).toBe(true);
    }
    const missing = judgeRun(200, `{"ok":true,${STAMPED}}`);
    expect(missing.status).not.toBe(0);
  });

  it("asks the sync Worker's health again when the limiter was unavailable once, and passes on the next counted read", () => {
    const res = judgeRun(200, `{"ok":true,"ip_limit":"unavailable",${STAMPED}}|${HEALTHY}`);
    expect(res.status, res.stderr + res.stdout).toBe(0);
    expect(res.order.slice(0, 3)).toEqual(["health", "health", expect.stringMatching(/^push /)]);
    expect(existsSync(join(res.dir, "staged/sync"))).toBe(false);
  });

  it("pushes a deploy-read-back message after the counted read and before the alerts read, with the run URL as its detail", () => {
    const step = judgeStep();
    expect(step.env).toMatchObject({ CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}", CLOUDFLARE_ACCOUNT_ID: "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}", SYNC_VERSION: "${{ steps.deploy-sync.outputs.version_id }}" });
    const res = judgeRun(200);
    expect(res.status, res.stderr + res.stdout).toBe(0);
    expect(res.order).toEqual(["health", "push --queue claudinite-licenses-writes --marker deploy-read-back --detail https://github.test/acme/runs/1", "health", "alerts"]);
    expect(res.stdout).toMatch(/last_queue_version new-sync/);
  });

  it("asks the health again with growing sleeps until the consumer's stamps name the deployed version", () => {
    const stale = '{"ok":true,"ip_limit":"counted","last_queue_at":1,"last_queue_version":"live-sync","queue_lag_s":0}';
    const res = judgeRun(200, `${HEALTHY}|${stale}|${stale}|${HEALTHY}`);
    expect(res.status, res.stderr + res.stdout).toBe(0);
    expect(res.order.filter((o) => o === "health")).toHaveLength(4);
    const waits = res.sleeps.map(Number);
    expect(waits.length).toBeGreaterThanOrEqual(2);
    expect(waits).toEqual([...waits].sort((a, b) => a - b));
    expect(existsSync(join(res.dir, "sync-judged"))).toBe(true);
  });

  it("passes the judge while a backlog drains, up to the queue-lagging alert's bound, and says a batch landed on the deployed version", () => {
    const res = judgeRun(200, `{"ok":true,"ip_limit":"counted","last_queue_at":9999999999,"last_queue_version":"new-sync","queue_lag_s":${QUEUE_LAG_MAX_S}}`);
    expect(res.status, res.stderr + res.stdout).toBe(0);
    expect(res.stdout).toMatch(new RegExp(`^ok a writes-queue batch landed on the deployed version after the push: .*queue_lag_s ${QUEUE_LAG_MAX_S}$`, "m"));
    expect(existsSync(join(res.dir, "sync-judged"))).toBe(true);
  });

  it("pushes again when the previous version's consumer took the message, and passes once a batch lands on the deployed version", () => {
    const byOld = '{"ok":true,"ip_limit":"counted","last_queue_at":9999999999,"last_queue_version":null,"queue_lag_s":0}';
    const res = judgeRun(200, `${HEALTHY}|${byOld}|${HEALTHY}`);
    expect(res.status, res.stderr + res.stdout).toBe(0);
    expect(res.order.filter((o) => o.startsWith("push "))).toHaveLength(2);
    expect(res.order.at(-1)).toBe("alerts");
    expect(existsSync(join(res.dir, "sync-judged"))).toBe(true);
  });

  it("pushes at most four times while only another version consumes, then fails naming that version", () => {
    const byOld = '{"ok":true,"ip_limit":"counted","last_queue_at":9999999999,"last_queue_version":"live-sync","queue_lag_s":0}';
    const res = judgeRun(200, `${HEALTHY}|${byOld}`);
    expect(res.status).not.toBe(0);
    expect(res.order.filter((o) => o.startsWith("push "))).toHaveLength(4);
    expect(res.stdout).toMatch(/::error::.*last_queue_version live-sync.*not new-sync/);
    expect(existsSync(join(res.dir, "staged/sync"))).toBe(true);
  });

  const rollbackIn = (dir: string) => {
    const res = runStep(named("Roll back to the versions that were live"), {}, { PATH: `${dir}:${process.env.PATH}`, RUNNER_TEMP: dir });
    return { ...res, rolled: stageCalls(dir).filter((c) => c[0] === "rollback").map((c) => /workers\/([^/]+)\//.exec(c[2]!)![1]) };
  };

  for (const [why, body, extra] of [
    ["names the previous version", `{"ok":true,"ip_limit":"counted","last_queue_at":9999999999,"last_queue_version":"live-sync","queue_lag_s":2}`, {}],
    ["was stamped before the judge started", `{"ok":true,"ip_limit":"counted","last_queue_at":1,"last_queue_version":"new-sync","queue_lag_s":2}`, {}],
    ["reports a lag over the queue-lagging alert's bound", `{"ok":true,"ip_limit":"counted","last_queue_at":9999999999,"last_queue_version":"new-sync","queue_lag_s":${QUEUE_LAG_MAX_S + 1}}`, {}],
    ["follows a push that exited 1", HEALTHY, { PUSH_EXIT: "1" }],
  ] as const) {
    it(`fails the judge, and the rollback rolls back sync and only sync, when the consumer's stamp ${why}`, () => {
      const res = judgeRun(200, body, extra);
      expect(res.status).not.toBe(0);
      expect(res.stdout).toMatch(/^::error::/m);
      expect(existsSync(join(res.dir, "sync-judged"))).toBe(false);
      expect(existsSync(join(res.dir, "staged/sync"))).toBe(true);
      expect(res.order).not.toContain("alerts");
      const back = rollbackIn(res.dir);
      expect(back.status, back.stderr).toBe(0);
      expect(back.rolled).toEqual(["sync"]);
    });
  }

  it("names the three stamps on a stale stamp, and the permission on a failed push", () => {
    const stale = judgeRun(200, '{"ok":true,"ip_limit":"counted","last_queue_at":1,"last_queue_version":"live-sync","queue_lag_s":0}');
    expect(stale.stdout).toMatch(/::error::.*last_queue_at 1.*last_queue_version live-sync.*queue_lag_s 0/);
    expect(stale.sleeps.length).toBeGreaterThanOrEqual(5);
    const refused = judgeRun(200, HEALTHY, { PUSH_EXIT: "1" });
    expect(refused.stdout).toMatch(/::error::.*Queues Edit/);
  });

  // The rollback step after a failure, with markers as the steps before it left them.
  function rollbackAfter(markers: Record<string, string>, extra: Record<string, string> = {}, cwd?: string) {
    const dir = standIns();
    mkdirSync(join(dir, "staged"));
    for (const [f, v] of Object.entries(markers)) writeFileSync(join(dir, f), v);
    const res = runStep(named("Roll back to the versions that were live"), {}, { PATH: `${dir}:${process.env.PATH}`, RUNNER_TEMP: dir, ...extra }, { cwd });
    return { ...res, dir, calls: stageCalls(dir) };
  }
  const rolledBack = (calls: string[][]) => calls.filter((c) => c[0] === "rollback").map((c) => /workers\/([^/]+)\//.exec(c[2]!)![1]);

  it("rolls back the three split Workers and not sync when the canary fails after sync passed its judge, and says why", () => {
    const res = rollbackAfter({ "staged/public-key": "live-public-key", "staged/key": "live-key", "staged/router": "live-router", "sync-judged": "" });
    expect(res.status, res.stderr).toBe(0);
    expect(rolledBack(res.calls)).toEqual(["public-key", "key", "router"]);
    expect(res.stdout).toMatch(/claudinite-sync passed its own judge/);
  });

  it("rolls back sync when its own deploy or judge failed", () => {
    const res = rollbackAfter({ "staged/sync": "live-sync" });
    expect(res.status, res.stderr).toBe(0);
    expect(rolledBack(res.calls)).toEqual(["sync"]);
  });

  // A stand-in history: the key Worker's config at a base commit, then at HEAD with `routes` as given.
  function history(headRoutes: string[]) {
    const repo = mkdtempSync(join(tmpdir(), "acme-history-"));
    const git = (...a: string[]) => spawnSync("git", ["-c", "user.name=acme", "-c", "user.email=acme@example.test", ...a], { cwd: repo, encoding: "utf8" });
    git("init", "-q");
    mkdirSync(join(repo, "workers/key"), { recursive: true });
    const config = (routes: string[]) => `{\n  // a comment\n  "name": "claudinite-key",\n  "main": "src/index.ts",\n  "routes": ${JSON.stringify(routes.map((pattern) => ({ pattern, zone_name: "claudinite.com" })))}\n}\n`;
    writeFileSync(join(repo, "workers/key/wrangler.jsonc"), config(["license.claudinite.com/v1/session-key"]));
    git("add", ".");
    git("commit", "-q", "-m", "base");
    const base = git("rev-parse", "HEAD").stdout.trim();
    writeFileSync(join(repo, "workers/key/wrangler.jsonc"), config(headRoutes));
    git("commit", "-q", "-am", "head");
    return { repo, base, head: git("rev-parse", "HEAD").stdout.trim() };
  }

  it("re-applies the live version's commit's triggers on rollback when the routes moved, from a config beside the real one it then removes", () => {
    const { repo, base, head } = history(["license.claudinite.com/v1/session-key", "license.claudinite.com/v1/other"]);
    const res = rollbackAfter({ "staged/key": "live-key" }, { TAG_KEY: base.slice(0, 7) }, repo);
    expect(res.status, res.stderr + res.stdout).toBe(0);
    expect(res.calls.map((c) => c.slice(0, 5).join(" "))).toEqual(["rollback --config workers/key/wrangler.jsonc --id live-key", "tag --config workers/key/wrangler.jsonc --id live-key", "triggers --config workers/key/wrangler.rollback.jsonc"]);
    expect(existsSync(join(repo, "workers/key/wrangler.rollback.jsonc"))).toBe(false);
    expect(res.stdout).toMatch(new RegExp(`^::error::claudinite-key's routes or triggers differ between ${head.slice(0, 7)} and ${base.slice(0, 7)}`, "m"));
  });

  it("falls back to the push's base commit when the live version carries no tag, and runs nothing when no trigger moved", () => {
    const { repo, base } = history(["license.claudinite.com/v1/session-key"]);
    const res = rollbackAfter({ "staged/key": "live-key" }, { BEFORE: base }, repo);
    expect(res.status, res.stderr + res.stdout).toBe(0);
    expect(res.calls.filter((c) => c[0] === "triggers")).toEqual([]);
    expect(res.stdout).toMatch(/claudinite-key: no route or trigger moved/);
    const moved = history(["license.claudinite.com/v1/elsewhere"]);
    const again = rollbackAfter({ "staged/key": "live-key" }, { BEFORE: moved.base }, moved.repo);
    expect(again.calls.filter((c) => c[0] === "triggers").map((c) => c.join(" "))).toEqual(["triggers --config workers/key/wrangler.rollback.jsonc"]);
    expect(named("Roll back to the versions that were live").env).toMatchObject({ BEFORE: "${{ github.event.before }}" });
  });

  it("passes FAIL_OPEN from the KEY_FAIL_OPEN repository variable only when it is set, refusing anything but true or false", () => {
    const step = uploadStep("key")!;
    expect(step.env).toMatchObject({ KEY_FAIL_OPEN: "${{ vars.KEY_FAIL_OPEN }}" });
    const failOpenVar = (args: string[]) => args.flatMap((a, i) => (a === "--var" && args[i + 1]!.startsWith("FAIL_OPEN:") ? [args[i + 1]] : []));
    for (const value of ["true", "false"]) {
      const res = runWithStandIns(step, {}, {}, { KEY_FAIL_OPEN: value });
      expect(res.status, res.stderr).toBe(0);
      expect(failOpenVar(res.calls[0]!), value).toEqual([`FAIL_OPEN:${value}`]);
      expect(res.output).toContain(`fail_open=${value}\n`);
    }
    const unset = runWithStandIns(step);
    expect(unset.status, unset.stderr).toBe(0);
    expect(failOpenVar(unset.calls[0]!)).toEqual([]);
    expect(unset.output).toContain("fail_open=true\n");
    const wrong = runWithStandIns(step, {}, {}, { KEY_FAIL_OPEN: "TRUE" });
    expect(wrong.status).not.toBe(0);
    expect(wrong.stdout + wrong.stderr).toMatch(/KEY_FAIL_OPEN.*TRUE/);
    expect(wrong.calls).toEqual([]);
  });

  it("reads fail_open back from the key Worker's health as the upload passed it", () => {
    const step = named("Read back the live Workers");
    expect(step.env).toMatchObject({ FAIL_OPEN_WANT: "${{ steps.upload-key.outputs.fail_open }}" });
    expect(step.run).toContain('probe 200 "b.fail_open===$FAIL_OPEN_WANT" -- https://license.claudinite.com/v1/key/health');
  });

  it("reads back that the split Workers' health reads met the per-address cap, the binding bound and called", () => {
    const run = named("Read back the live Workers").run!;
    expect(run).toContain(`probe 200 'b.ip_limit==="counted"' -- https://license.claudinite.com/v1/public/health`);
    expect(run).toContain(`probe 200 'b.d1==="ok"&&b.queue==="bound"&&b.polar==="configured"&&b.ip_limit==="counted"' -- https://license.claudinite.com/v1/key/health`);
  });

  const capStep = () => named("Observe the per-address cap from outside");

  // Runs the cap proof with a curl that answers 200 to the first `allowed` reads in arrival order, then
  // 429, with or without the version header; each read holds 50 ms so the stand-in sees how many
  // were in flight at once.
  function capRun(allowed: number, versioned = true) {
    const dir = mkdtempSync(join(tmpdir(), "acme-cap-"));
    const realSleep = spawnSync("bash", ["-c", "command -v sleep"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(join(dir, "sleep"), `#!/usr/bin/env bash\necho "$@" >> "${dir}/sleeps"\n`);
    chmodSync(join(dir, "sleep"), 0o755);
    writeFileSync(
      join(dir, "curl"),
      `#!/usr/bin/env bash
headers=""
while [ $# -gt 0 ]; do if [ "$1" = -D ]; then headers=$2; shift; fi; shift; done
exec 9>"${dir}/lock"
flock 9; n=$(( $(cat "${dir}/n" 2>/dev/null || echo 0) + 1 )); echo $n > "${dir}/n"
f=$(( $(cat "${dir}/flight" 2>/dev/null || echo 0) + 1 )); echo $f > "${dir}/flight"
[ $f -gt $(cat "${dir}/max" 2>/dev/null || echo 0) ] && echo $f > "${dir}/max"; flock -u 9
${realSleep} 0.05
flock 9; echo $(( $(cat "${dir}/flight") - 1 )) > "${dir}/flight"; flock -u 9
if [ $n -le ${allowed} ]; then code=200; else code=429; fi
printf 'HTTP/2 %s\\r\\n${versioned ? "x-claudinite-version: acme-version\\r\\n" : ""}\\r\\n' $code > "$headers"
printf %s $code
`,
    );
    chmodSync(join(dir, "curl"), 0o755);
    const res = runStep(capStep(), {}, { PATH: `${dir}:${process.env.PATH}`, RUNNER_TEMP: dir });
    const count = (f: string) => Number(readFileSync(join(dir, f), "utf8"));
    const sleeps = existsSync(join(dir, "sleeps")) ? readFileSync(join(dir, "sleeps"), "utf8").trim().split("\n") : [];
    return { ...res, sent: count("n"), maxInFlight: count("max"), sleeps };
  }

  // The limiter is per location and syncs in the background, so a burst can pass it whole; the reads
  // are paced across most of the period instead, and what they meet is reported, never failed: the
  // read-back's ip_limit field is what proves the cap is wired.
  it("paces 400 health reads across the cap's period, eight at a time a second, and reports the 429s it met", () => {
    const ok = capRun(300);
    expect(ok.status, ok.stderr + ok.stdout).toBe(0);
    expect(ok.sent).toBe(400);
    expect(ok.maxInFlight).toBeGreaterThan(1);
    expect(ok.maxInFlight).toBeLessThanOrEqual(8);
    expect(ok.sleeps).toEqual(Array(49).fill("1"));
    expect(ok.stdout).toMatch(/^sent 400 health reads in \d+s, 100 answered 429$/m);
    expect(ok.stdout).toMatch(/^ok 429 from version acme-version, 100 of 400 health reads refused in \d+s$/m);
  });

  it("warns rather than fails when the paced reads meet no 429, or 429s with no version header", () => {
    const never = capRun(1000);
    expect(never.status, never.stderr).toBe(0);
    expect(never.sent).toBe(400);
    expect(never.stdout).toMatch(/^::warning::400 health reads from one address in \d+s met no 429/m);
    expect(never.stdout).not.toContain("::error::");
    const unversioned = capRun(300, false);
    expect(unversioned.status, unversioned.stderr).toBe(0);
    expect(unversioned.stdout).toMatch(/^::warning::none of the 100 429s carried a version header/m);
  });

  it("observes the cap after promotion and the read-back, then waits out its period before the final probe", () => {
    const cap = steps.indexOf(capStep());
    const wait = stepAt((s) => s.name === "Wait out the cap's period before the final probe");
    expect(cap).toBeGreaterThan(stepAt((s) => s.name === "Read back the live Workers"));
    expect(wait).toBe(cap + 1);
    expect(steps[wait]!.run!.trim()).toMatch(/^sleep (6[1-9]|[7-9]\d)$/m);
    expect(wait).toBeLessThan(steps.indexOf(probeStep()!));
  });
});
