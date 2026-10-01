import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { RESTORE_COMMAND } from "../d1-restore-rehearsal.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const restore = parse(readFileSync(join(ROOT, ".github/workflows/d1-restore.yml"), "utf8"));
const deploy = parse(readFileSync(join(ROOT, ".github/workflows/deploy.yml"), "utf8"));
type Step = { name?: string; run?: string; env?: Record<string, string>; if?: string };

describe("d1-restore.yml", () => {
  const steps: Step[] = Object.values(restore.jobs as Record<string, { steps: Step[] }>)[0]!.steps;

  it("is dispatch-only with a required bookmark, reads contents only, and shares the deploy's concurrency group", () => {
    expect(Object.keys(restore.on)).toEqual(["workflow_dispatch"]);
    expect(restore.on.workflow_dispatch.inputs.bookmark).toMatchObject({ required: true, type: "string" });
    expect(restore.permissions).toEqual({ contents: "read" });
    expect(restore.concurrency.group).toBe(deploy.concurrency.group);
    expect(restore.concurrency["cancel-in-progress"]).toBe(false);
  });

  it("runs the rehearsed restore command, with the production database and the dispatched bookmark", () => {
    const want = RESTORE_COMMAND.replace("{database}", "claudinite-licenses").replace("{bookmark}", '"$BOOKMARK"');
    const lines = steps.flatMap((s) => (s.run ?? "").split("\n")).map((l) => l.trim()).filter((l) => l.includes("time-travel restore"));
    expect(lines).toEqual([want]);
    const step = steps.find((s) => (s.run ?? "").includes("time-travel restore"))!;
    expect(step.env).toMatchObject({ BOOKMARK: "${{ inputs.bookmark }}", CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}", CLOUDFLARE_ACCOUNT_ID: "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}" });
  });

  it("reads the sync Worker's health and alerts back into the summary after the restore", () => {
    const at = steps.findIndex((s) => (s.run ?? "").includes("time-travel restore"));
    const after = steps.slice(at + 1).map((s) => s.run ?? "").join("\n");
    expect(after).toContain("https://license.claudinite.com/v1/sync/health");
    expect(after).toContain("https://license.claudinite.com/v1/sync/alerts");
    expect(after).toContain("GITHUB_STEP_SUMMARY");
  });

  it("restores without the prompt wrangler answers no to off a terminal", () => {
    expect(RESTORE_COMMAND).toMatch(/ --json\b/);
    expect(RESTORE_COMMAND.startsWith("npx wrangler d1 time-travel restore {database} --bookmark={bookmark}")).toBe(true);
  });
});
