#!/usr/bin/env node
// A local stand-in for the GitHub API calls the license tools and Workers make: installation
// tokens, the App's webhook config, the App's installations and their repos, a repo's default
// branch, and an Actions OIDC issuer (its JWKS, and tokens it signs).
//
//   node tools/github-stub.mjs --port <n>
import { createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { parseArgs } from "node:util";

/**
 * @typedef {{ world?: World }} StubOptions
 * @typedef {{ id: number, name: string, full_name: string, private: boolean, default_branch: string }} WorldRepo
 * @typedef {{ id: number, account: { id: number, login: string, type: string }, repos: WorldRepo[] }} WorldInstallation
 * @typedef {{ installations: WorldInstallation[] }} World
 */

/** One installation on a user account holding one public repo. @type {World} */
export const DEFAULT_WORLD = {
  installations: [
    {
      id: 5005,
      account: { id: 2002, login: "acme-user", type: "User" },
      repos: [{ id: 1001, name: "acme-repo", full_name: "acme-user/acme-repo", private: false, default_branch: "main" }],
    },
  ],
};

const b64url = (/** @type {Buffer | string} */ v) => Buffer.from(v).toString("base64url");

/**
 * @param {{ port?: number } & StubOptions} [opts]
 */
export async function startStub(opts = {}) {
  const world = opts.world ?? DEFAULT_WORLD;
  const oidcKid = `stub-${randomBytes(4).toString("hex")}`;
  const oidc = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...oidc.publicKey.export({ format: "jwk" }), kid: oidcKid, alg: "RS256", use: "sig" };
  /** @param {string} full */
  const repoOf = (full) => {
    for (const inst of world.installations) {
      const repo = inst.repos.find((r) => r.full_name.toLowerCase() === full.toLowerCase());
      if (repo) return { inst, repo };
    }
    return null;
  };
  const state = {
    /** @type {{ path: string, body: any }[]} */
    tokenRequests: [],
    hookConfig: { url: "https://placeholder.invalid/github-webhook", content_type: "json", insecure_ssl: "0" },
    /** @type {any[]} */
    hookPatches: [],
    /** @type {string[]} */
    requests: [],
  };

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : {};
    const url = new URL(req.url ?? "/", "http://stub");
    const path = url.pathname;
    const bearer = /^(?:Bearer|token) (\S+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
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
    if (req.method === "GET" && (m = /^\/repos\/([^/]+\/[^/]+)$/.exec(path))) {
      const found = repoOf(m[1]);
      if (!found) return send(404, { message: "Not Found (stub)" });
      const { inst, repo } = found;
      return send(200, { ...repo, visibility: repo.private ? "private" : "public", owner: inst.account });
    }
    if (req.method === "GET" && path === "/app/installations") {
      const page = Number(url.searchParams.get("page") ?? "1");
      return send(200, page === 1 ? world.installations.map((i) => ({ id: i.id, account: i.account })) : []);
    }
    if (req.method === "GET" && path === "/installation/repositories") {
      const inst = world.installations.find((i) => bearer === `ghs_stub_${i.id}`);
      if (!inst) return send(401, { message: "Bad credentials" });
      const page = Number(url.searchParams.get("page") ?? "1");
      const repos = page === 1 ? inst.repos.map((r) => ({ ...r, visibility: r.private ? "private" : "public", owner: inst.account })) : [];
      return send(200, { total_count: inst.repos.length, repositories: repos });
    }
    if (req.method === "GET" && path === "/.well-known/jwks") return send(200, { keys: [jwk] });
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
  const base = `http://127.0.0.1:${port}`;
  return {
    port,
    base,
    state,
    world,
    /** Signs an Actions OIDC token as this stub's issuer, `iss` set to the stub's base unless the claims name one. @param {Record<string, unknown>} claims */
    signOidcToken(claims) {
      const input = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: oidcKid }))}.${b64url(JSON.stringify({ iss: base, ...claims }))}`;
      return `${input}.${createSign("RSA-SHA256").update(input).sign(oidc.privateKey).toString("base64url")}`;
    },
    close: () =>
      new Promise((ok) => {
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
