// The Claudinite App's one webhook address: checks GitHub's signature, then hands each webhook to
// the Worker it is for over a service binding and returns that Worker's answer, so the App's
// delivery log shows the outcome.

export interface Env {
  GITHUB_APP_WEBHOOK_SECRET: string;
  PUBLIC_KEY?: Fetcher;
  KEY?: Fetcher;
  SYNC?: Fetcher;
}

const MAX_BODY = 1024 * 1024;

async function readCapped(req: Request): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(req.headers.get("Content-Length") ?? "0");
  if (declared > MAX_BODY) return null;
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BODY) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

async function signatureMatches(secret: string, body: Uint8Array<ArrayBuffer>, header: string | null): Promise<boolean> {
  if (!header || !/^sha256=[0-9a-f]{64}$/.test(header)) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const given = Uint8Array.from(header.slice(7).match(/../g)!, (h) => parseInt(h, 16));
  // HMAC verify compares in constant time.
  return crypto.subtle.verify("HMAC", key, given, body);
}

async function forward(binding: Fetcher | undefined, host: string, route: string, req: Request, body: Uint8Array<ArrayBuffer>): Promise<Response> {
  if (!binding) {
    console.log(JSON.stringify({ unrouted: route, delivery: req.headers.get("X-GitHub-Delivery") }));
    return new Response(`unrouted: ${route}`, { status: 202 });
  }
  const headers = new Headers({ "Content-Type": "application/json" });
  for (const h of ["X-GitHub-Event", "X-GitHub-Delivery"]) {
    const v = req.headers.get(h);
    if (v !== null) headers.set(h, v);
  }
  const res = await binding.fetch(`https://${host}/webhook`, { method: "POST", headers, body });
  return new Response(res.body, { status: res.status, headers: res.headers });
}

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== "/github-webhook") return new Response("not found", { status: 404 });
    const body = await readCapped(req);
    if (body === null) return new Response("payload too large", { status: 413 });
    if (!(await signatureMatches(env.GITHUB_APP_WEBHOOK_SECRET, body, req.headers.get("X-Hub-Signature-256")))) {
      return new Response("bad signature", { status: 401 });
    }
    const event = req.headers.get("X-GitHub-Event") ?? "";
    switch (event) {
      case "ping":
        return new Response("pong", { status: 200 });
      case "repository_dispatch": {
        let action: unknown;
        try {
          action = (JSON.parse(new TextDecoder().decode(body)) as { action?: unknown }).action;
        } catch {
          return new Response("malformed payload", { status: 400 });
        }
        if (action === "claudinite-key-public") return forward(env.PUBLIC_KEY, "public-key", `${event}/${action}`, req, body);
        if (action === "claudinite-key") return forward(env.KEY, "key", `${event}/${action}`, req, body);
        return new Response(null, { status: 204 });
      }
      case "installation":
      case "installation_repositories":
      case "repository":
        return forward(env.SYNC, "sync", event, req, body);
      default:
        return new Response(null, { status: 204 });
    }
  },
};
