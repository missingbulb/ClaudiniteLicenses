import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// A workflow cannot run here; these read deploy.yml and run its gate script the way Actions would.
const ROOT = resolve(import.meta.dirname, "../..");
const workflow = parse(readFileSync(join(ROOT, ".github/workflows/deploy.yml"), "utf8"));
const steps: { id?: string; name?: string; run?: string }[] = workflow.jobs.deploy.steps;
const gate = steps.find((s) => s.id === "gate")!;

function readmeSecrets(worker: string): string[] {
  const text = readFileSync(join(ROOT, "workers", worker, "README.md"), "utf8");
  const section = text.split(/^## Secrets$/m)[1] ?? "";
  return [...section.matchAll(/^- `([A-Z0-9_]+)`/gm)].map((m) => m[1]!);
}

function runGate(env: Record<string, string>) {
  const out = join(mkdtempSync(join(tmpdir(), "acme-gate-")), "output");
  const res = spawnSync("bash", ["-e", "-c", gate.run!], { env: { PATH: process.env.PATH!, GITHUB_OUTPUT: out, ...env }, encoding: "utf8" });
  return { status: res.status, stdout: res.stdout, output: readFileSync(out, "utf8") };
}

describe("deploy.yml", () => {
  const secrets = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", ...readmeSecrets("public-key"), ...readmeSecrets("router")];

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
});
