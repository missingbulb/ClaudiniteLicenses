// Hands each request to the Worker whose route pattern matches its path. DEV_ROUTES is a JSON list
// of { path, service }, a trailing `*` matching any rest; a service's binding is its name in upper
// case with dashes as underscores. `POST /__dev/writes` sends its JSON body onto the writes queue,
// standing in for the deploy's push through the Queues REST API, which a local queue does not serve.
export default {
  /** @param {Request} req @param {Record<string, any>} env */
  async fetch(req, env) {
    const path = new URL(req.url).pathname;
    if (req.method === "POST" && path === "/__dev/writes") {
      await env.WRITES.send(await req.json(), { contentType: "json" });
      return new Response(null, { status: 202 });
    }
    for (const { path: pattern, service } of JSON.parse(env.DEV_ROUTES)) {
      const matches = pattern.endsWith("*") ? path.startsWith(pattern.slice(0, -1)) : path === pattern;
      if (matches) return env[service.toUpperCase().replaceAll("-", "_")].fetch(req);
    }
    return new Response(`no route for ${path}`, { status: 404 });
  },
};
