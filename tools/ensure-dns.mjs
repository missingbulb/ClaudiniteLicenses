#!/usr/bin/env node
// Makes a hostname whose Workers are bound by route patterns resolve: a route only matches traffic
// Cloudflare already proxies, so the name needs a proxied record. Creates an AAAA 100:: record
// when the zone holds no A, AAAA or CNAME for the name; leaves an existing one alone.
// Reads CLOUDFLARE_API_TOKEN from the environment.
//
//   node tools/ensure-dns.mjs --zone claudinite.com --name license.claudinite.com
import { parseArgs } from "node:util";

/**
 * @param {{ base?: string, token: string, zone: string, name: string }} opts
 * @returns {Promise<{ created: boolean, record: { type: string, name: string, content: string, proxied: boolean } }>}
 */
export async function ensureDns({ base = "https://api.cloudflare.com/client/v4", token, zone, name }) {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  /** @param {string} method @param {string} path @param {unknown} [body] */
  const call = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.success === false) throw new Error(`${method} ${path} answered ${res.status}: ${JSON.stringify(json.errors ?? json)}`);
    return json.result;
  };
  const zones = await call("GET", `/zones?name=${encodeURIComponent(zone)}`);
  if (!zones?.length) throw new Error(`the token sees no zone named ${zone}`);
  const zoneId = zones[0].id;
  const records = await call("GET", `/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}`);
  const held = records.find((/** @type {{ type: string }} */ r) => ["A", "AAAA", "CNAME"].includes(r.type));
  if (held) {
    if (!held.proxied) throw new Error(`${name} has a ${held.type} record that is not proxied, so Worker routes never see its traffic`);
    return { created: false, record: held };
  }
  const record = await call("POST", `/zones/${zoneId}/dns_records`, { type: "AAAA", name, content: "100::", proxied: true, comment: "Worker routes (ClaudiniteLicenses deploy)" });
  return { created: true, record };
}

if (import.meta.filename === process.argv[1]) {
  const { values } = parseArgs({ options: { zone: { type: "string" }, name: { type: "string" }, base: { type: "string" } } });
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!values.zone || !values.name || !token) {
    console.error("usage: CLOUDFLARE_API_TOKEN=... node tools/ensure-dns.mjs --zone <zone> --name <hostname>");
    process.exit(2);
  }
  ensureDns({ base: values.base, token, zone: values.zone, name: values.name }).then(
    ({ created, record }) => console.log(`${created ? "created" : "already held"}: ${record.type} ${record.name} ${record.content} proxied=${record.proxied}`),
    (err) => {
      console.error(`ensure-dns: ${err.message}`);
      process.exit(1);
    },
  );
}
