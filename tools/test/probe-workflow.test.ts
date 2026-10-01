import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = resolve(import.meta.dirname, "../..");
const workflow = parse(readFileSync(join(ROOT, ".github/workflows/probe.yml"), "utf8"));
const runs = (Object.values(workflow.jobs) as { steps: { run?: string }[] }[]).flatMap((j) => j.steps.map((s) => s.run ?? ""));
const invocations = runs.flatMap((r) => r.split("\n")).filter((l) => /^\s*node tools\/probe\.mjs\b/.test(l));

describe("probe.yml", () => {
  it("runs on a schedule off the top of the hour, about every 15 minutes, and on dispatch", () => {
    const crons: string[] = workflow.on.schedule.map((s: { cron: string }) => s.cron);
    expect(crons).toHaveLength(1);
    const minutes = crons[0]!.split(" ")[0]!.split(",").map(Number);
    expect(minutes).toHaveLength(4);
    expect(minutes).not.toContain(0);
    expect(crons[0]!.split(" ").slice(1)).toEqual(["*", "*", "*", "*"]);
    expect(workflow.on).toHaveProperty("workflow_dispatch");
  });

  it("holds exactly the three permissions it needs", () => {
    expect(workflow.permissions).toEqual({ contents: "read", issues: "write", "id-token": "write" });
  });

  it("invokes tools/probe.mjs against the live host with the OIDC token and --issue", () => {
    expect(invocations).toHaveLength(1);
    const line = invocations[0]!;
    expect(line).toContain("--base https://license.claudinite.com");
    expect(line).toMatch(/--oidc-token-env \w+/);
    expect(line).toMatch(/--issue\b/);
    expect(line).toContain('--repo "$GITHUB_REPOSITORY"');
    expect(runs.join("\n")).toContain("audience=claudinite");
  });
});
