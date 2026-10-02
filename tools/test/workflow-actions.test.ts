import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// Every action a workflow uses is pinned to a commit with its version beside it, and one action
// resolves to one commit across the tree, so a half-done bump fails here. The SHAs themselves are
// not pinned: which release is current is a point in time.
const DIR = resolve(import.meta.dirname, "../../.github/workflows");
const files = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f));
const USES = /^\s*(?:-\s+)?uses:\s*(.*)$/;
const PINNED = /^([\w.-]+\/[\w.-]+(?:\/[\w./-]+)?)@([0-9a-f]{40}) # v\d+\.\d+\.\d+$/;

type Step = { uses?: string; run?: string; with?: Record<string, unknown> };

describe(".github/workflows", () => {
  it("has workflows to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("pins every uses: to a 40-hex commit with a version comment, one commit per action across the tree", () => {
    const failures: string[] = [];
    const shas = new Map<string, Set<string>>();
    for (const f of files) {
      readFileSync(join(DIR, f), "utf8")
        .split("\n")
        .forEach((line, i) => {
          const m = USES.exec(line);
          if (!m) return;
          const pinned = PINNED.exec(m[1]!.trim());
          if (!pinned) return void failures.push(`${f}:${i + 1} is not owner/repo@<40 hex> # v<semver>: ${m[1]!.trim()}`);
          const seen = shas.get(pinned[1]!) ?? new Set<string>();
          seen.add(`${pinned[2]} # ${m[1]!.trim().split(" # ")[1]}`);
          shas.set(pinned[1]!, seen);
        });
    }
    for (const [action, seen] of shas) if (seen.size > 1) failures.push(`${action} is pinned to ${seen.size} commits: ${[...seen].join(", ")}`);
    expect(failures).toEqual([]);
  });

  // `cache: npm` where the job installs, `package-manager-cache: false` where it does not, so a job
  // that never fills ~/.npm saves nothing under the key the installing jobs share.
  it("declares its caching either way on every actions/setup-node step", () => {
    const failures: string[] = [];
    for (const f of files) {
      const wf = parse(readFileSync(join(DIR, f), "utf8")) as { jobs: Record<string, { steps?: Step[] }> };
      for (const [name, job] of Object.entries(wf.jobs)) {
        for (const step of job.steps ?? []) {
          if (!step.uses?.startsWith("actions/setup-node@")) continue;
          const cached = Boolean(step.with?.cache);
          const off = step.with?.["package-manager-cache"] === false;
          const installs = (job.steps ?? []).some((st) => /\bnpm (ci|install)\b/.test(st.run ?? ""));
          if (cached === off) failures.push(`${f} job ${name}: setup-node declares ${cached ? "both cache and package-manager-cache: false" : "no caching"}`);
          else if (cached !== installs) failures.push(`${f} job ${name}: ${installs ? "installs, so declares cache: npm" : "never installs, so declares package-manager-cache: false"}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
