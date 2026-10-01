import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

interface Issue {
  number: number;
  title: string;
  state: "open" | "closed";
  state_reason?: string | null;
  labels: { name: string }[];
  body: string;
  comments: string[];
}

/** One stub standing in for the four Workers on license.claudinite.com and the GitHub issues API. */
interface Stub {
  base: string;
  routes: Record<string, () => { status: number; body: unknown }>;
  issues: Issue[];
  labels: string[];
  seen: string[];
  close: () => Promise<void>;
}

const HEALTHY: Stub["routes"] = {
  "GET /v1/public/health": () => ({ status: 200, body: { ok: true, alerts: [] } }),
  "GET /v1/key/health": () => ({ status: 200, body: { ok: true, d1: "ok", queue: "bound", polar: "configured", trust_roots: "ok", alerts: [] } }),
  "GET /v1/sync/health": () => ({ status: 200, body: { ok: true } }),
  "GET /v1/sync/alerts": () => ({ status: 200, body: { ok: true, checked_at: 1, alerts: [] } }),
  "POST /github-webhook": () => ({ status: 401, body: "bad signature" }),
  "POST /v1/session-key": () => ({ status: 401, body: { refused: "token-invalid" } }),
  "POST /v1/actions-key": () => ({ status: 403, body: { refused: "workflow-not-pinned" } }),
};

async function startStub(): Promise<Stub> {
  const stub = { routes: { ...HEALTHY }, issues: [] as Issue[], labels: [] as string[], seen: [] as string[] } as Stub;
  const read = async (req: IncomingMessage) => {
    let raw = "";
    for await (const c of req) raw += c;
    return raw ? JSON.parse(raw) : {};
  };
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://stub");
    const route = `${req.method} ${url.pathname}`;
    stub.seen.push(`${route} ${req.headers.authorization ?? ""}`.trim());
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": typeof body === "string" ? "text/plain" : "application/json" });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    let m: RegExpExecArray | null;
    if (stub.routes[route]) {
      if (route === "POST /v1/session-key") {
        const body = await read(req);
        if (req.headers.authorization !== "Bearer probe" || typeof body.repo !== "string" || typeof body.nonce !== "string") return send(400, { refused: "bad-request" });
      }
      if (route === "POST /v1/actions-key" && req.headers.authorization !== "Bearer acme-oidc-token") return send(401, { refused: "token-invalid" });
      const { status, body } = stub.routes[route]!();
      return send(status, body);
    }
    if (req.headers.authorization !== "Bearer acme-gh-token") return send(401, { message: "Bad credentials" });
    if ((m = /^\/repos\/acme-user\/acme-repo\/labels\/([^/]+)$/.exec(url.pathname)) && req.method === "GET") {
      return stub.labels.includes(decodeURIComponent(m[1]!)) ? send(200, { name: m[1] }) : send(404, { message: "Not Found" });
    }
    if (url.pathname === "/repos/acme-user/acme-repo/labels" && req.method === "POST") {
      const body = await read(req);
      stub.labels.push(body.name);
      return send(201, { name: body.name });
    }
    if (url.pathname === "/repos/acme-user/acme-repo/issues" && req.method === "GET") {
      const label = url.searchParams.get("labels");
      const state = url.searchParams.get("state");
      return send(200, stub.issues.filter((i) => (!label || i.labels.some((l) => l.name === label)) && (state === "all" || i.state === (state ?? "open"))).map(({ comments: _c, ...i }) => i));
    }
    if (url.pathname === "/repos/acme-user/acme-repo/issues" && req.method === "POST") {
      const body = await read(req);
      const issue: Issue = { number: stub.issues.length + 1, title: body.title, state: "open", labels: (body.labels ?? []).filter((l: string) => stub.labels.includes(l)).map((name: string) => ({ name })), body: body.body, comments: [] };
      stub.issues.push(issue);
      return send(201, issue);
    }
    if ((m = /^\/repos\/acme-user\/acme-repo\/issues\/(\d+)\/comments$/.exec(url.pathname)) && req.method === "POST") {
      const issue = stub.issues.find((i) => i.number === Number(m![1]));
      if (!issue) return send(404, { message: "Not Found" });
      issue.comments.push((await read(req)).body);
      return send(201, {});
    }
    if ((m = /^\/repos\/acme-user\/acme-repo\/issues\/(\d+)$/.exec(url.pathname)) && req.method === "PATCH") {
      const issue = stub.issues.find((i) => i.number === Number(m![1]));
      if (!issue) return send(404, { message: "Not Found" });
      Object.assign(issue, await read(req));
      return send(200, issue);
    }
    return send(404, { message: `stub has no ${route}` });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  stub.base = `http://127.0.0.1:${port}`;
  stub.close = () =>
    new Promise((ok) => {
      server.closeAllConnections();
      server.close(() => ok());
    });
  return stub;
}

let stub: Stub;
let dir: string;

beforeEach(async () => {
  stub = await startStub();
  dir = mkdtempSync(join(tmpdir(), "acme-probe-"));
});

afterEach(async () => {
  await stub.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Runs the probe as Actions would, its GitHub API at the stub. */
function probe(args: string[], env: Record<string, string> = {}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((ok) => {
    const child = spawn(process.execPath, ["tools/probe.mjs", "--base", stub.base, ...args], {
      cwd: ROOT,
      env: { PATH: process.env.PATH!, GITHUB_API_URL: stub.base, NO_PROXY: "127.0.0.1", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (status) => ok({ status, stdout, stderr }));
  });
}

const withIssue = ["--issue", "--repo", "acme-user/acme-repo", "--token-env", "ACME_TOKEN"];
const ghEnv = { ACME_TOKEN: "acme-gh-token", GITHUB_SERVER_URL: "https://github.test", GITHUB_REPOSITORY: "acme-user/acme-repo", GITHUB_RUN_ID: "77" };

describe("tools/probe.mjs", () => {
  it("passes every check against healthy Workers, exits 0, and writes the JSON summary", async () => {
    const json = join(dir, "probe.json");
    const res = await probe(["--oidc-token-env", "ACME_OIDC", "--json", json], { ACME_OIDC: "acme-oidc-token" });
    expect(res.status, res.stderr + res.stdout).toBe(0);
    const summary = JSON.parse(readFileSync(json, "utf8"));
    expect(summary.ok).toBe(true);
    expect(summary.checks.map((c: { name: string; ok: boolean }) => [c.name, c.ok])).toEqual([
      ["public-health", true],
      ["key-health", true],
      ["sync-health", true],
      ["sync-alerts", true],
      ["router-signature", true],
      ["session-key-upstream", true],
      ["actions-key-oidc", true],
    ]);
    for (const c of summary.checks) expect(typeof c.latency_ms).toBe("number");
    expect(res.stdout.split("\n").filter((l) => /^(ok|FAIL) /.test(l))).toHaveLength(7);
  });

  it("skips the Actions check without an OIDC token and still passes", async () => {
    const res = await probe([]);
    expect(res.status).toBe(0);
    expect(stub.seen.some((s) => s.startsWith("POST /v1/actions-key"))).toBe(false);
  });

  it("fails check 4 on a 503 alerts body, listing each alert on a line of its own", async () => {
    stub.routes["GET /v1/sync/alerts"] = () => ({
      status: 503,
      body: { ok: false, checked_at: 1, alerts: [{ id: "polar-unreachable", since: 1, detail: "3 in the last hour" }, { id: "paying-uncovered", since: 1, detail: "1" }] },
    });
    const json = join(dir, "probe.json");
    const res = await probe(["--json", json]);
    expect(res.status).toBe(1);
    const alerts = JSON.parse(readFileSync(json, "utf8")).checks.find((c: { name: string }) => c.name === "sync-alerts");
    expect(alerts).toMatchObject({ ok: false, status: 503, alerts: [{ id: "polar-unreachable" }, { id: "paying-uncovered" }] });
    expect(res.stdout).toMatch(/^ {2}alert polar-unreachable: 3 in the last hour$/m);
    expect(res.stdout).toMatch(/^ {2}alert paying-uncovered: 1$/m);
  });

  it("fails check 5 when the unsigned webhook gets a 200", async () => {
    stub.routes["POST /github-webhook"] = () => ({ status: 200, body: "pong" });
    const json = join(dir, "probe.json");
    expect((await probe(["--json", json])).status).toBe(1);
    expect(JSON.parse(readFileSync(json, "utf8")).checks.find((c: { name: string }) => c.name === "router-signature")).toMatchObject({ ok: false, status: 200 });
  });

  it("fails check 2 when the key Worker answers 200 but its queue is unbound", async () => {
    stub.routes["GET /v1/key/health"] = () => ({ status: 200, body: { ok: true, d1: "ok", queue: "unbound", polar: "configured", trust_roots: "ok" } });
    expect((await probe([])).status).toBe(1);
  });

  it("fails a Worker that does not answer at all, naming the error", async () => {
    await stub.close();
    const res = await probe([]);
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/^FAIL public-health/m);
  });

  it("with --issue keeps one standing issue: opens it once, comments on the next failure, closes it on the next pass", async () => {
    stub.routes["GET /v1/sync/alerts"] = () => ({ status: 503, body: { ok: false, alerts: [{ id: "d1-unreadable", since: 1, detail: "1 in the last hour" }] } });
    expect((await probe(withIssue, ghEnv)).status).toBe(1);
    expect(stub.labels).toEqual(["probe"]);
    expect(stub.issues).toHaveLength(1);
    expect(stub.issues[0]).toMatchObject({ title: "License server probe", state: "open", labels: [{ name: "probe" }] });
    expect(stub.issues[0]!.body).toContain("d1-unreadable");
    expect(stub.issues[0]!.body).toContain("https://github.test/acme-user/acme-repo/actions/runs/77");

    expect((await probe(withIssue, ghEnv)).status).toBe(1);
    expect(stub.issues).toHaveLength(1);
    expect(stub.issues[0]!.comments).toHaveLength(1);
    expect(stub.issues[0]!.comments[0]).toContain("d1-unreadable");

    stub.routes["GET /v1/sync/alerts"] = HEALTHY["GET /v1/sync/alerts"]!;
    expect((await probe(withIssue, ghEnv)).status).toBe(0);
    expect(stub.issues[0]).toMatchObject({ state: "closed", state_reason: "completed" });
    expect(stub.issues[0]!.comments).toHaveLength(2);
    expect(stub.issues[0]!.comments[1]).toContain("https://github.test/acme-user/acme-repo/actions/runs/77");

    // A later failure opens a fresh one, since the guard is an open issue with that title and label.
    stub.routes["POST /github-webhook"] = () => ({ status: 200, body: "pong" });
    expect((await probe(withIssue, ghEnv)).status).toBe(1);
    expect(stub.issues.filter((i) => i.state === "open")).toHaveLength(1);
  });

  it("files nothing on a passing run with no open issue, and nothing at all without --issue", async () => {
    expect((await probe(withIssue, ghEnv)).status).toBe(0);
    expect(stub.issues).toEqual([]);
    stub.seen.length = 0;
    stub.routes["GET /v1/sync/alerts"] = () => ({ status: 503, body: { ok: false, alerts: [] } });
    expect((await probe([], ghEnv)).status).toBe(1);
    expect(stub.issues).toEqual([]);
    expect(stub.seen.some((s) => s.includes("/issues"))).toBe(false);
  });

  it("ignores an open issue with the title but not the label, and one with the label but another title", async () => {
    stub.labels.push("probe");
    stub.issues.push({ number: 1, title: "License server probe", state: "open", labels: [], body: "", comments: [] });
    stub.issues.push({ number: 2, title: "Something else", state: "open", labels: [{ name: "probe" }], body: "", comments: [] });
    stub.routes["GET /v1/sync/alerts"] = () => ({ status: 503, body: { ok: false, alerts: [] } });
    expect((await probe(withIssue, ghEnv)).status).toBe(1);
    expect(stub.issues.map((i) => [i.number, i.comments.length])).toEqual([[1, 0], [2, 0], [3, 0]]);
  });
});
