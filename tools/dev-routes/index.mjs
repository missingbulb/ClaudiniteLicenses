// Hands each request to the Worker whose route pattern matches its path. DEV_ROUTES is a JSON list
// of { path, service }, a trailing `*` matching any rest; a service's binding is its name in upper
// case with dashes as underscores.
export default {
  /** @param {Request} req @param {Record<string, any>} env */
  async fetch(req, env) {
    const path = new URL(req.url).pathname;
    for (const { path: pattern, service } of JSON.parse(env.DEV_ROUTES)) {
      const matches = pattern.endsWith("*") ? path.startsWith(pattern.slice(0, -1)) : path === pattern;
      if (matches) return env[service.toUpperCase().replaceAll("-", "_")].fetch(req);
    }
    return new Response(`no route for ${path}`, { status: 404 });
  },
};
