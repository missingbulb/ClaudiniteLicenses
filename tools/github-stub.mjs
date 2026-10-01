#!/usr/bin/env node
// A local stand-in for the GitHub API calls the license tools and Workers make: installation
// tokens, check runs (recorded on create, served back on the commit's check-runs listing), the
// App's webhook config, and, for the spike client, a repo, its default-branch commit and
// dispatches that a scripted responder answers with a check run after a delay.
//
//   node tools/github-stub.mjs --port <n>
import { createServer } from "node:http";
import { parseArgs } from "node:util";

/**
 * @typedef {{ external_id: string, name: string, head_sha: string, status?: string, conclusion?: string, output?: { title?: string, summary?: string, text?: string } }} CheckRun
 * @typedef {{
 *   dispatchStatus?: number,
 *   dispatchDelays?: (number | null)[],
 *   dispatchSenderType?: string,
 *   checkRunStatus?: number,
 *   checkRunBody?: string,
 *   headSha?: string,
 *   defaultBranch?: string,
 * }} StubOptions
 */

/**
 * @param {{ port?: number } & StubOptions} [opts]
 */
export async function startStub(opts = {}) {
  const headSha = opts.headSha ?? "0123456789abcdef0123456789abcdef01234567";
  const state = {
    /** @type {Record<string, CheckRun[]>} */
    checkRuns: {},
    /** @type {{ path: string, body: any }[]} */
    tokenRequests: [],
    /** @type {any[]} */
    dispatches: [],
    hookConfig: { url: "https://placeholder.invalid/github-webhook", content_type: "json", insecure_ssl: "0" },
    /** @type {any[]} */
    hookPatches: [],
    /** @type {string[]} */
    requests: [],
  };
  /** @type {Set<NodeJS.Timeout>} */
  const timers = new Set();
  let dispatchCount = 0;

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : {};
    const url = new URL(req.url ?? "/", "http://stub");
    const path = url.pathname;
    state.requests.push(`${req.method} ${path}`);
    /** @param {number} status @param {unknown} [data] */
    const send = (status, data) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(data === undefined ? "" : JSON.stringify(data));
    };
    let m;
    if (req.method === "POST" && (m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path))) {
      state.tokenRequests.push({ path, body });
      return send(201, { token: `ghs_stub_${m[1]}`, expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    if (req.method === "POST" && (m = /^\/repos\/([^/]+\/[^/]+)\/check-runs$/.exec(path))) {
      if (opts.checkRunStatus) return send(opts.checkRunStatus, { message: opts.checkRunBody ?? "stubbed failure" });
      (state.checkRuns[body.head_sha] ??= []).push(body);
      return send(201, { id: Object.values(state.checkRuns).flat().length, ...body });
    }
    if (req.method === "GET" && (m = /^\/repos\/([^/]+\/[^/]+)\/commits\/([^/]+)\/check-runs$/.exec(path))) {
      const name = url.searchParams.get("check_name");
      const runs = (state.checkRuns[m[2]] ?? []).filter((r) => !name || r.name === name);
      return send(200, { total_count: runs.length, check_runs: runs });
    }
    if (req.method === "GET" && (m = /^\/repos\/([^/]+\/[^/]+)\/commits\/([^/]+)$/.exec(path))) {
      return send(200, { sha: headSha });
    }
    if (req.method === "POST" && (m = /^\/repos\/([^/]+\/[^/]+)\/dispatches$/.exec(path))) {
      state.dispatches.push(body);
      const status = opts.dispatchStatus ?? 204;
      if (status !== 204) return send(status, { message: "Resource not accessible by integration" });
      const delay = opts.dispatchDelays ? opts.dispatchDelays[dispatchCount] : 0;
      dispatchCount++;
      if (delay !== null && delay !== undefined) {
        const t = setTimeout(() => {
          timers.delete(t);
          const head = body.client_payload?.head ?? headSha;
          (state.checkRuns[head] ??= []).push({
            name: "Claudinite key",
            head_sha: head,
            external_id: body.client_payload?.nonce,
            status: "completed",
            conclusion: "neutral",
            output: { title: "Claudinite key", summary: `public key for @acme-user (sender type ${opts.dispatchSenderType ?? "User"}), issued ${new Date().toISOString()}`, text: "{}" },
          });
        }, delay);
        timers.add(t);
      }
      return send(204);
    }
    if (req.method === "GET" && (m = /^\/repos\/([^/]+\/[^/]+)$/.exec(path))) {
      return send(200, { full_name: m[1], default_branch: opts.defaultBranch ?? "main", private: false });
    }
    if (path === "/app/hook/config" && req.method === "PATCH") {
      state.hookPatches.push(body);
      Object.assign(state.hookConfig, body);
      return send(200, state.hookConfig);
    }
    if (path === "/app/hook/config" && req.method === "GET") return send(200, state.hookConfig);
    return send(404, { message: "Not Found (stub)" });
  });

  await new Promise((ok) => server.listen(opts.port ?? 0, "127.0.0.1", () => ok(undefined)));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    state,
    close: () =>
      new Promise((ok) => {
        for (const t of timers) clearTimeout(t);
        server.closeAllConnections();
        server.close(() => ok(undefined));
      }),
  };
}

if (import.meta.filename === process.argv[1]) {
  const { values } = parseArgs({ options: { port: { type: "string" } } });
  const stub = await startStub({ port: Number(values.port ?? 8790) });
  console.log(`github stub listening on ${stub.base}`);
}
