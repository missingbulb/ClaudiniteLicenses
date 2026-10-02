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
  /** Each Worker's live version, and the one a split serves to one version key in ten. */
  versions: Record<string, { old: string; new?: string }>;
  /** Answers the new version gives instead of the route's. */
  newRoutes: Stub["routes"];
  /** The version keys the probe sent, in order. */
  keys: string[];
  /** Routes whose answer carries no version header, as if no Worker had given it. */
  unversioned: Set<string>;
  /** How many more requests the key Worker answers with its per-address cap's 429. */
  keyCapped: number;
  close: () => Promise<void>;
}

const WORKER_OF: Record<string, string> = {
  "GET /v1/public/health": "public-key",
  "GET /v1/key/health": "key",
  "POST /v1/session-key": "key",
  "POST /v1/actions-key": "key",
  "GET /v1/sync/health": "sync",
  "GET /v1/sync/alerts": "sync",
  "POST /github-webhook": "router",
  "POST /v1/login/refresh": "key",
  "POST /v1/key/webhook": "key",
  "POST /v1/sync/polar-webhook": "sync",
};

// One key in ten reaches the new version, as a 10% split hashes them: canary-7, canary-17, ...
const reachesNew = (key: string | undefined) => key !== undefined && /^canary-\d*7$/.test(key);

const HEALTHY: Stub["routes"] = {
  "GET /v1/public/health": () => ({ status: 200, body: { ok: true, alerts: [] } }),
  "GET /v1/key/health": () => ({ status: 200, body: { ok: true, d1: "ok", queue: "bound", polar: "configured", trust_roots: "ok", alerts: [] } }),
  "GET /v1/sync/health": () => ({ status: 200, body: { ok: true } }),
  "GET /v1/sync/alerts": () => ({ status: 200, body: { ok: true, checked_at: 1, alerts: [] } }),
  "POST /github-webhook": () => ({ status: 401, body: "bad signature" }),
  "POST /v1/session-key": () => ({ status: 401, body: { refused: "token-invalid" } }),
  "POST /v1/actions-key": () => ({ status: 403, body: { refused: "workflow-not-pinned" } }),
  "POST /v1/login/refresh": () => ({ status: 400, body: { refused: "no-refresh-token" } }),
  "POST /v1/sync/polar-webhook": () => ({ status: 401, body: "signature-missing" }),
  // No Worker route reaches /webhook; the key Worker's prefix reaches /v1/key/webhook and answers 404.
  "POST /webhook": () => ({ status: 404, body: "no Worker" }),
  "POST /v1/key/webhook": () => ({ status: 404, body: "not found" }),
};

async function startStub(): Promise<Stub> {
  const stub = {
    routes: { ...HEALTHY },
    issues: [] as Issue[],
    labels: [] as string[],
    seen: [] as string[],
    versions: { "public-key": { old: "pk-old" }, key: { old: "key-old" }, sync: { old: "sync-old" }, router: { old: "router-old" } },
    newRoutes: {},
    keys: [] as string[],
    unversioned: new Set<string>(),
    keyCapped: 0,
  } as unknown as Stub;
  const read = async (req: IncomingMessage) => {
    let raw = "";
    for await (const c of req) raw += c;
    return raw ? JSON.parse(raw) : {};
  };
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://stub");
    const route = `${req.method} ${url.pathname}`;
    stub.seen.push(`${route} ${req.headers.authorization ?? ""}`.trim());
    const key = req.headers["cloudflare-workers-version-key"] as string | undefined;
    if (key !== undefined) stub.keys.push(key);
    const worker = WORKER_OF[route];
    const v = worker ? stub.versions[worker]! : null;
    const version = v && !stub.unversioned.has(route) ? (v.new && reachesNew(key) ? v.new : v.old) : null;
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": typeof body === "string" ? "text/plain" : "application/json", ...(version ? { "X-Claudinite-Version": version } : {}) });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    let m: RegExpExecArray | null;
    if (worker === "key" && stub.keyCapped > 0) {
      stub.keyCapped--;
      return send(429, { refused: "rate-limited" });
    }
    if (stub.routes[route]) {
      if (route === "POST /v1/session-key") {
        const body = await read(req);
        if (req.headers.authorization !== "Bearer probe" || typeof body.repo !== "string" || typeof body.nonce !== "string") return send(400, { refused: "bad-request" });
      }
      if (route === "POST /v1/actions-key" && req.headers.authorization !== "Bearer acme-oidc-token") return send(401, { refused: "token-invalid" });
      const { status, body } = (version === v?.new && stub.newRoutes[route] ? stub.newRoutes[route] : stub.routes[route])!();
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
      ["login-refresh-unauthenticated", true],
      ["polar-webhook-unsigned", true],
      ["private-paths-unrouted", true],
      ["actions-key-oidc", true],
    ]);
    for (const c of summary.checks) expect(typeof c.latency_ms).toBe("number");
    expect(res.stdout.split("\n").filter((l) => /^(ok|FAIL) /.test(l))).toHaveLength(10);
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

  const row = (json: string, name: string) => (JSON.parse(readFileSync(json, "utf8")) as { checks: { name: string; ok: boolean; status: number | null; version: string | null; detail?: string; headers?: Record<string, string> }[] }).checks.find((c) => c.name === name)!;

  it("fails polar-webhook-unsigned on a 200 and on secret-unset, which would mean the live Worker lost its secret", async () => {
    const json = join(dir, "probe.json");
    for (const answer of [{ status: 200, body: "ok" }, { status: 401, body: "secret-unset" }]) {
      stub.routes["POST /v1/sync/polar-webhook"] = () => answer;
      expect((await probe(["--json", json])).status, answer.body).toBe(1);
      expect(row(json, "polar-webhook-unsigned"), answer.body).toMatchObject({ ok: false, status: answer.status });
    }
    expect(stub.seen.filter((s) => s.startsWith("POST /v1/sync/polar-webhook"))).toHaveLength(2);
  });

  it("fails login-refresh-unauthenticated unless the route refuses no-refresh-token before any GitHub call", async () => {
    stub.routes["POST /v1/login/refresh"] = () => ({ status: 503, body: { refused: "refresh-not-configured" } });
    const json = join(dir, "probe.json");
    expect((await probe(["--json", json])).status).toBe(1);
    expect(row(json, "login-refresh-unauthenticated")).toMatchObject({ ok: false, status: 503 });
  });

  it("fails private-paths-unrouted when a Worker answers /webhook from outside, or the key Worker's prefix answers anything but 404", async () => {
    const json = join(dir, "probe.json");
    stub.routes["POST /webhook"] = () => ({ status: 200, body: "served" });
    expect((await probe(["--json", json])).status).toBe(1);
    expect(row(json, "private-paths-unrouted")).toMatchObject({ ok: false });
    stub.routes["POST /webhook"] = HEALTHY["POST /webhook"]!;
    stub.routes["POST /v1/key/webhook"] = () => ({ status: 201, body: "issued" });
    expect((await probe(["--json", json])).status).toBe(1);
    expect(row(json, "private-paths-unrouted").detail).toMatch(/\/v1\/key\/webhook/);
  });

  it("fails private-paths-unrouted when the answer on /webhook names a version, since then a Worker gave it", async () => {
    WORKER_OF["POST /webhook"] = "key";
    try {
      const json = join(dir, "probe.json");
      expect((await probe(["--json", json])).status).toBe(1);
      expect(row(json, "private-paths-unrouted").detail).toMatch(/version key-old/);
    } finally {
      delete WORKER_OF["POST /webhook"];
    }
  });

  it("fails a Worker check whose answer carries no version header, keeping the raw headers in the row", async () => {
    stub.unversioned.add("POST /github-webhook");
    const json = join(dir, "probe.json");
    const res = await probe(["--json", json]);
    expect(res.status).toBe(1);
    const r = row(json, "router-signature");
    expect(r).toMatchObject({ ok: false, status: 401, version: null });
    expect(r.detail).toMatch(/^version header missing/);
    expect(r.headers).toMatchObject({ "content-type": "text/plain" });
    expect(res.stdout).toMatch(/^ {2}headers .*content-type/m);
    expect(row(json, "key-health").headers).toBeUndefined();
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

describe("tools/probe.mjs --expect-version", () => {
  const pinned = "public-key=pk-new,key=key-new,router=router-new";
  type Row = { name: string; ok: boolean; version: string | null; detail?: string; cap_waits?: number };
  const rows = (json: string) => (JSON.parse(readFileSync(json, "utf8")) as { checks: Row[] }).checks;

  it("reports the version that answered every check, with no pin", async () => {
    const json = join(dir, "probe.json");
    expect((await probe(["--json", json])).status).toBe(0);
    expect(rows(json).map((c) => [c.name, c.version])).toEqual([
      ["public-health", "pk-old"],
      ["key-health", "key-old"],
      ["sync-health", "sync-old"],
      ["sync-alerts", "sync-old"],
      ["router-signature", "router-old"],
      ["session-key-upstream", "key-old"],
      ["login-refresh-unauthenticated", "key-old"],
      ["polar-webhook-unsigned", "sync-old"],
      ["private-paths-unrouted", null],
    ]);
    expect(stub.keys).toEqual([]);
  });

  it("reaches each pinned Worker's new version through the version key within the budget, and judges that answer", async () => {
    stub.versions["public-key"]!.new = "pk-new";
    stub.versions.key!.new = "key-new";
    stub.versions.router!.new = "router-new";
    const json = join(dir, "probe.json");
    const res = await probe(["--oidc-token-env", "ACME_OIDC", "--expect-version", pinned, "--json", json], { ACME_OIDC: "acme-oidc-token" });
    expect(res.status, res.stdout + res.stderr).toBe(0);
    expect(rows(json).map((c) => [c.name, c.ok, c.version])).toEqual([
      ["public-health", true, "pk-new"],
      ["key-health", true, "key-new"],
      ["sync-health", true, "sync-old"],
      ["sync-alerts", true, "sync-old"],
      ["router-signature", true, "router-new"],
      ["session-key-upstream", true, "key-new"],
      ["login-refresh-unauthenticated", true, "key-new"],
      ["polar-webhook-unsigned", true, "sync-old"],
      ["private-paths-unrouted", true, null],
      ["actions-key-oidc", true, "key-new"],
    ]);
    // Six pinned checks, each walking canary-1 to canary-7; the unpinned sync checks and the private paths send no key.
    expect(stub.keys).toEqual(Array.from({ length: 6 }, () => Array.from({ length: 7 }, (_, i) => `canary-${i + 1}`)).flat());
  });

  it("fails a check the new version answers wrongly, naming the version, while the old version is healthy", async () => {
    stub.versions.key!.new = "key-new";
    stub.newRoutes["GET /v1/key/health"] = () => ({ status: 503, body: { ok: false, alerts: ["d1-unreadable"] } });
    const json = join(dir, "probe.json");
    const res = await probe(["--expect-version", "key=key-new", "--json", json]);
    expect(res.status).toBe(1);
    const health = rows(json).find((c) => c.name === "key-health")!;
    expect(health).toMatchObject({ ok: false, version: "key-new" });
    expect(health.detail).toMatch(/^version key-new: want 200/);
    expect(rows(json).find((c) => c.name === "session-key-upstream")).toMatchObject({ ok: true, version: "key-new" });
  });

  it("fails a pinned check whose version is never served, and runs the others unpinned", async () => {
    const json = join(dir, "probe.json");
    const res = await probe(["--expect-version", "key=key-new", "--json", json]);
    expect(res.status).toBe(1);
    const health = rows(json).find((c) => c.name === "key-health")!;
    expect(health).toMatchObject({ ok: false, version: "key-old" });
    expect(health.detail).toMatch(/^version key-new not reached in 60 keys/);
    expect(rows(json).find((c) => c.name === "public-health")).toMatchObject({ ok: true, version: "pk-old" });
    expect(stub.keys.filter((k) => k === "canary-60")).toHaveLength(3);
    expect(stub.keys).not.toContain("canary-61");
  });

  it("waits out the per-address cap's 429 mid-walk and asks again rather than failing the canary", async () => {
    stub.versions.key!.new = "key-new";
    stub.keyCapped = 3;
    const json = join(dir, "probe.json");
    const res = await probe(["--expect-version", "key=key-new", "--cap-wait-ms", "20", "--json", json]);
    expect(res.status, res.stdout + res.stderr).toBe(0);
    const health = rows(json).find((c) => c.name === "key-health")!;
    expect(health).toMatchObject({ ok: true, version: "key-new", cap_waits: 2 });
    expect(rows(json).find((c) => c.name === "session-key-upstream")).toMatchObject({ ok: true, version: "key-new" });
    expect(res.stdout).toMatch(/^ok key-health 200 .* key-new \(waited out the per-address cap 2x\)$/m);
    // The capped key is asked again, not skipped: canary-1 three times (the third 429 is that key's
    // answer, from the old version), then the walk goes on to canary-7.
    expect(stub.keys.slice(0, 9)).toEqual(["canary-1", "canary-1", "canary-1", "canary-2", "canary-3", "canary-4", "canary-5", "canary-6", "canary-7"]);
  });

  it("fails a check the cap still refuses after its waits, naming rate-limited, and does not wait on an unpinned run's other answers", async () => {
    stub.keyCapped = 1000;
    const json = join(dir, "probe.json");
    const res = await probe(["--cap-wait-ms", "5", "--json", json]);
    expect(res.status).toBe(1);
    const health = rows(json).find((c) => c.name === "key-health")!;
    expect(health).toMatchObject({ ok: false, status: 429, cap_waits: 2 });
    expect(health.detail).toMatch(/rate-limited/);
    expect(rows(json).find((c) => c.name === "public-health")).toMatchObject({ ok: true });
    expect(rows(json).find((c) => c.name === "public-health")!.cap_waits).toBeUndefined();
  });

  it("refuses a Worker name no check is answered by, and a malformed pin", async () => {
    for (const pin of ["keys=abc", "key", "key=", "key=a,key=b"]) {
      const res = await probe(["--expect-version", pin]);
      expect(res.status, pin).toBe(2);
      expect(res.stderr, pin).toMatch(/--expect-version/);
    }
  });
});
