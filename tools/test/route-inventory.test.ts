import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { perAddressCap, routeTable } from "../route-table.mjs";

// The security review's route table against the code: every route a Worker answers is a row, every
// row is a route, a row is "public" exactly when a wrangler route reaches it, and every row names
// the test that pins its cap.
const ROOT = resolve(import.meta.dirname, "../..");
const WORKERS = ["key", "public-key", "sync", "router"];
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const rows = routeTable(read("docs/license-record.md"));

/** The `routes` patterns of a Worker's wrangler.jsonc, host dropped. */
function patterns(worker: string): string[] {
  const config = JSON.parse(read(`workers/${worker}/wrangler.jsonc`).replace(/^\s*\/\/.*$/gm, ""));
  return (config.routes ?? []).map((r: { pattern: string }) => r.pattern.slice(r.pattern.indexOf("/")));
}

const reachedBy = (path: string, pats: string[]) => pats.some((p) => (p.endsWith("*") ? path.startsWith(p.slice(0, -1)) : path === p));

/** Every `METHOD /path` a Worker's fetch handler answers, read from its route switch or its if-chain. */
function codeRoutes(worker: string): string[] {
  const src = read(`workers/${worker}/src/index.ts`);
  const found = new Set<string>();
  for (const m of src.matchAll(/case "([A-Z]+) (\/[^"]*)":/g)) found.add(`${m[1]} ${m[2]}`);
  for (const m of src.matchAll(/req\.method === "([A-Z]+)" && url\.pathname === "(\/[^"]*)"/g)) found.add(`${m[1]} ${m[2]}`);
  for (const m of src.matchAll(/req\.method !== "([A-Z]+)" \|\| url\.pathname !== "(\/[^"]*)"/g)) found.add(`${m[1]} ${m[2]}`);
  return [...found].sort();
}

describe("the security review's route table", () => {
  it("reads routes from every Worker, so the scan is not silently empty", () => {
    for (const w of WORKERS) expect(codeRoutes(w).length, w).toBeGreaterThan(0);
    expect(codeRoutes("key")).toContain("GET /v1/key/health");
    expect(codeRoutes("router")).toEqual(["POST /github-webhook"]);
  });

  it("lists every route each Worker answers, and nothing it does not", () => {
    for (const w of WORKERS) {
      const listed = rows.filter((r) => r.worker === w).map((r) => `${r.method} ${r.path}`).sort();
      expect(listed, w).toEqual(codeRoutes(w));
    }
    expect(new Set(rows.map((r) => r.worker))).toEqual(new Set(WORKERS));
  });

  it("calls a row public exactly when a wrangler route reaches its path, and a service binding otherwise", () => {
    for (const r of rows) {
      const want = reachedBy(r.path, patterns(r.worker)) ? "public" : "service binding";
      expect(r.reached, `${r.worker} ${r.method} ${r.path}`).toBe(want);
    }
    expect(rows.filter((r) => r.reached === "service binding").map((r) => `${r.worker} ${r.path}`)).toEqual(["key /webhook", "public-key /webhook", "sync /webhook"]);
  });

  it("puts the per-address cap in front of every public route but GitHub's webhook, and none on the service-binding paths", () => {
    for (const r of rows) {
      const label = `${r.worker} ${r.method} ${r.path}`;
      if (r.reached === "public" && r.path !== "/github-webhook") expect(perAddressCap(r), label).toBe(true);
      else expect(r.cap, label).toMatch(/^none: /);
    }
  });

  it("names, on every row, a test file that exists", () => {
    for (const r of rows) {
      const file = /`([^`]+\.test\.ts)`/.exec(r.test)?.[1];
      expect(file, `${r.worker} ${r.method} ${r.path}: ${JSON.stringify(r.test)}`).toBeTruthy();
      expect(existsSync(join(ROOT, file!)), file).toBe(true);
    }
  });
});
