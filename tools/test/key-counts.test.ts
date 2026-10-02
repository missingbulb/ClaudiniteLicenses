import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KEY_COUNT_BLOBS } from "../../packages/licensing/src/index.ts";
import { keyCounts, keyCountsSql, parseTime, probeAvailability, querySql } from "../key-counts.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const NOW = 1_790_000_000;
let server: Server | undefined;

afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

type Seen = { method: string; url: string; auth: string | undefined; body: string };
type Answer = { status: number; body: string };

/** A stand-in SQL API answering each request with the next of `answers`, the last one repeating. */
async function startSqlApi(answers: Answer[]) {
  const seen: Seen[] = [];
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
      const a = answers[Math.min(seen.length - 1, answers.length - 1)]!;
      res.statusCode = a.status;
      res.end(a.body);
    });
  });
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
  const { port } = server!.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, seen };
}

const json = (data: Record<string, unknown>[], meta: { name: string; type: string }[] = []) => ({ status: 200, body: JSON.stringify({ meta, data, rows: data.length }) });
const FORBIDDEN = { status: 403, body: JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }) };
const noSleep = async () => {};
const opts = (base: string) => ({ base, token: "t", accountId: "acct", sleep: noSleep });

describe("tools/key-counts.mjs", () => {
  it("POSTs the SQL as the raw body to the account's analytics_engine/sql with the bearer token", async () => {
    const api = await startSqlApi([json([{ plan: "public", outcome: "issued", path: "web", requests: "3" }])]);
    const res = await keyCounts({ ...opts(api.base), since: NOW - 3600, until: NOW });
    expect(api.seen).toHaveLength(1);
    const [req] = api.seen;
    expect(req!.method).toBe("POST");
    expect(req!.url).toBe("/accounts/acct/analytics_engine/sql");
    expect(req!.auth).toBe("Bearer t");
    expect(req!.body).toBe(keyCountsSql({ since: NOW - 3600, until: NOW }));
    expect(req!.body).toContain("sum(_sample_interval)");
    expect(req!.body).not.toMatch(/count\(/i);
    expect(req!.body).toMatch(/ FORMAT JSON$/);
    expect(res).toMatchObject({ available: true, total: 3, rows: [{ plan: "public", outcome: "issued", path: "web", requests: 3 }] });
    expect(res.available && typeof res.rows[0]!.requests).toBe("number");
  });

  it("builds the SQL from KEY_COUNT_BLOBS: each group is the blob at its place, the filters index1 and the engine version's blob", () => {
    const sql = keyCountsSql({ since: NOW - 60, until: NOW, repoId: "42", engineVersion: "deploy-read-back", groupBy: ["outcome", "path"] });
    const blob = (name: (typeof KEY_COUNT_BLOBS)[number]) => `blob${KEY_COUNT_BLOBS.indexOf(name) + 1}`;
    expect(sql).toBe(
      `SELECT ${blob("outcome")} AS outcome, ${blob("path")} AS path, sum(_sample_interval) AS requests FROM claudinite_key_counts WHERE timestamp >= toDateTime(${NOW - 60}) AND timestamp < toDateTime(${NOW}) AND index1 = '42' AND ${blob("engineVersion")} = 'deploy-read-back' GROUP BY outcome, path ORDER BY requests DESC FORMAT JSON`,
    );
    expect(keyCountsSql({ since: 1, until: 2 })).toContain(`${blob("plan")} AS plan, ${blob("outcome")} AS outcome, ${blob("path")} AS path,`);
  });

  for (const status of [403, 401]) {
    it(`answers unavailable naming Account Analytics: Read on a ${status}, without throwing`, async () => {
      const api = await startSqlApi([{ ...FORBIDDEN, status }]);
      const res = await keyCounts({ ...opts(api.base), since: NOW - 60, until: NOW });
      expect(res).toEqual({ available: false, reason: "forbidden", status, permission: "Account Analytics: Read" });
      expect(api.seen).toHaveLength(1);
    });
  }

  it("retries a 5xx and succeeds when the next answer is a 200, sleeping longer each time", async () => {
    const api = await startSqlApi([{ status: 500, body: "oops" }, { status: 502, body: "oops" }, json([])]);
    const slept: number[] = [];
    const res = await querySql({ ...opts(api.base), sql: "SHOW TABLES FORMAT JSON", sleep: async (ms: number) => void slept.push(ms) });
    expect(res).toMatchObject({ available: true, data: [] });
    expect(api.seen).toHaveLength(3);
    expect(slept).toHaveLength(2);
    expect(slept[1]!).toBeGreaterThan(slept[0]!);
  });

  it("throws after three retries of a 5xx", async () => {
    const api = await startSqlApi([{ status: 503, body: "down" }]);
    await expect(querySql({ ...opts(api.base), sql: "SHOW TABLES FORMAT JSON" })).rejects.toThrow(/503/);
    expect(api.seen).toHaveLength(4);
  });

  it("throws naming the body on a 400, the query being this code's bug", async () => {
    const api = await startSqlApi([{ status: 400, body: "syntax error near FORMAT" }]);
    await expect(querySql({ ...opts(api.base), sql: "SELECT nonsense FORMAT JSON" })).rejects.toThrow(/400.*syntax error near FORMAT/);
    expect(api.seen).toHaveLength(1);
  });

  const invalid: [string, Record<string, unknown>][] = [
    ["since as a string", { since: "1' OR '1'='1" }],
    ["since fractional", { since: NOW - 0.5 }],
    ["until negative", { until: -1 }],
    ["since after until", { since: NOW + 10 }],
    ["repoId not digits", { repoId: "1' OR '1'='1" }],
    ["engineVersion with a quote", { engineVersion: "1.0'; DROP" }],
    ["engineVersion too long", { engineVersion: "a".repeat(65) }],
    ["groupBy outside the blobs", { groupBy: ["plan", "index1"] }],
    ["groupBy empty", { groupBy: [] }],
  ];
  for (const [why, over] of invalid) {
    it(`throws before any request on ${why}`, async () => {
      const api = await startSqlApi([json([])]);
      await expect(keyCounts({ ...opts(api.base), since: NOW - 60, until: NOW, ...over })).rejects.toThrow();
      expect(api.seen).toHaveLength(0);
    });
  }

  it("probes with SHOW TABLES and reports whether the dataset is there", async () => {
    const present = await startSqlApi([json([{ dataset: "other" }, { dataset: "claudinite_key_counts" }], [{ name: "dataset", type: "String" }])]);
    expect(await probeAvailability(opts(present.base))).toEqual({ available: true, tables: ["other", "claudinite_key_counts"], hasKeyCounts: true });
    expect(present.seen[0]!.body).toBe("SHOW TABLES FORMAT JSON");
    server!.close();
    const absent = await startSqlApi([json([{ dataset: "other" }])]);
    expect(await probeAvailability(opts(absent.base))).toMatchObject({ available: true, hasKeyCounts: false });
  });

  it("resolves --since forms against a fixed clock", () => {
    expect(parseTime("7d", NOW)).toBe(NOW - 7 * 86400);
    expect(parseTime("24h", NOW)).toBe(NOW - 24 * 3600);
    expect(parseTime("90m", NOW)).toBe(NOW - 90 * 60);
    expect(parseTime("1789990000", NOW)).toBe(1_789_990_000);
    expect(parseTime("2026-10-01T00:00:00Z", NOW)).toBe(Date.parse("2026-10-01T00:00:00Z") / 1000);
    for (const bad of ["", "7 days", "1' OR '1'='1", "-5", "1.5"]) expect(() => parseTime(bad, NOW), bad).toThrow();
  });

  describe("the CLI", () => {
    const cli = (args: string[], env: Record<string, string> = { CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "acct" }): Promise<{ status: number | null; stdout: string; stderr: string }> =>
      new Promise((ok) => {
        const child = spawn(process.execPath, ["tools/key-counts.mjs", ...args], { cwd: ROOT, env: { PATH: process.env.PATH!, NO_PROXY: "127.0.0.1", ...env } });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (c) => (stdout += c));
        child.stderr.on("data", (c) => (stderr += c));
        child.on("close", (status) => ok({ status, stdout, stderr }));
      });

    it("exits 0 printing the unavailable line on a 403", async () => {
      const api = await startSqlApi([FORBIDDEN]);
      const res = await cli(["--base", api.base]);
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout.trim()).toBe("key counts: unavailable (403; the CLOUDFLARE_API_TOKEN needs the Account Analytics: Read permission on this account)");
      const probe = await cli(["--base", api.base, "--probe"]);
      expect(probe.status).toBe(0);
      expect(probe.stdout).toMatch(/^key counts: unavailable \(403; .*Account Analytics: Read/);
    });

    it("--probe prints whether the dataset is present", async () => {
      const api = await startSqlApi([json([{ dataset: "claudinite_key_counts" }])]);
      const res = await cli(["--base", api.base, "--probe"]);
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout.trim()).toBe("key counts: available, dataset claudinite_key_counts present");
    });

    it("prints the rows and their total, defaulting to the last 7 days", async () => {
      const api = await startSqlApi([json([{ plan: "public", outcome: "issued", path: "web", requests: "5" }, { plan: "none", outcome: "refused-workflow-not-pinned", path: "actions", requests: 2 }])]);
      const res = await cli(["--base", api.base]);
      expect(res.status, res.stderr).toBe(0);
      const lines = res.stdout.trim().split("\n");
      expect(lines[0]).toMatch(/^key counts: 2 rows, 7 requests since \d{4}-\d\d-\d\dT/);
      expect(lines.slice(1)).toHaveLength(2);
      expect(lines[1]).toMatch(/^public\s+issued\s+web\s+5$/);
      const sinceS = Number(/toDateTime\((\d+)\)/.exec(api.seen[0]!.body)![1]);
      expect(Math.abs(Date.now() / 1000 - 7 * 86400 - sinceS)).toBeLessThan(60);
    });

    it("--json prints the answer, --markdown a table with a total", async () => {
      const api = await startSqlApi([json([{ plan: "public", outcome: "issued", path: "web", requests: "5" }])]);
      const asJson = await cli(["--base", api.base, "--json", "--repo-id", "7", "--engine-version", "deploy-read-back", "--group", "outcome,path"]);
      expect(asJson.status, asJson.stderr).toBe(0);
      expect(JSON.parse(asJson.stdout)).toMatchObject({ available: true, total: 5, rows: [{ requests: 5 }] });
      expect(api.seen[0]!.body).toContain("index1 = '7'");
      const md = await cli(["--base", api.base, "--markdown"]);
      expect(md.stdout).toContain("| plan | outcome | path | requests |");
      expect(md.stdout).toContain("| public | issued | web | 5 |");
      expect(md.stdout).toMatch(/^\| total \| +\| +\| 5 \|$/m);
    });

    it("exits 2 with the usage line without a token, and on a bad flag", async () => {
      const none = await cli(["--probe"], {});
      expect(none.status).toBe(2);
      expect(none.stderr).toMatch(/^usage: /);
      const bad = await cli(["--since", "yesterday"]);
      expect(bad.status).toBe(2);
    });

    it("exits 1 on a thrown error", async () => {
      const api = await startSqlApi([{ status: 400, body: "bad query" }]);
      const res = await cli(["--base", api.base]);
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(/bad query/);
    });
  });
});
