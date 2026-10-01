#!/usr/bin/env node
// Development key chains for the license Workers. Production roots and issuing-key certificates
// come from ClaudiniteEngine's cn-keys ceremony (ClaudiniteEngine#5); the files written here use
// the same formats, so a Worker cannot tell the two apart.
//
//   node tools/keys.mjs gen-root --out <dir> [--name root]
//   node tools/keys.mjs gen-issuing --out <dir> [--name issuing]
//   node tools/keys.mjs certify --root <root.key> --pub <issuing.pub> --purpose <use> --days <n>
//   node tools/keys.mjs dev-chain --out <dir>
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { b64urlDecode, generateKeyPair, issueCertificate, keyId } from "../packages/signing/src/index.ts";

const DAY_MS = 86_400_000;

function writeNew(path, content, mode) {
  if (existsSync(path)) throw new Error(`${path} exists; refusing to overwrite`);
  writeFileSync(path, content, { mode, flag: "wx" });
}

export async function genPair(out, name) {
  mkdirSync(out, { recursive: true });
  const pair = await generateKeyPair();
  writeNew(join(out, `${name}.key`), pair.seed + "\n", 0o600);
  writeNew(join(out, `${name}.pub`), pair.publicKey + "\n", 0o644);
  return { ...pair, keyId: await keyId(b64urlDecode(pair.publicKey)) };
}

export async function certify(rootSeed, subjectPub, purpose, days, now = new Date()) {
  return issueCertificate(rootSeed.trim(), subjectPub.trim(), purpose, now, new Date(now.getTime() + days * DAY_MS));
}

function quote(value) {
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';
}

export function formatDevVars(vars) {
  return Object.entries(vars).map(([k, v]) => `${k}=${quote(v)}`).join("\n") + "\n";
}

/**
 * Reads the KEY="value" lines formatDevVars writes, the subset of dotenv wrangler reads.
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseDevVars(text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\(.)/g, (_, c) => (c === "n" ? "\n" : c));
    out[m[1]] = v;
  }
  return out;
}

export async function devChain(out) {
  mkdirSync(out, { recursive: true });
  const root = await genPair(out, "root");
  await genPair(out, "standby");
  const pub = await genPair(out, "license-public");
  const lic = await genPair(out, "license");
  const pubCert = await certify(root.seed, pub.publicKey, "license-public", 90);
  const licCert = await certify(root.seed, lic.publicKey, "license", 90);
  writeNew(join(out, "license-public.cert.json"), JSON.stringify(pubCert) + "\n", 0o644);
  writeNew(join(out, "license.cert.json"), JSON.stringify(licCert) + "\n", 0o644);
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  writeNew(join(out, "github-app.pem"), privateKey, 0o600);
  const secret = randomBytes(32).toString("hex");
  const publicKeyVars = {
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY: privateKey,
    ISSUING_KEY_PRIVATE: pub.seed,
    ISSUING_KEY_CERT: JSON.stringify(pubCert),
  };
  writeNew(join(out, "public-key.dev.vars"), formatDevVars(publicKeyVars), 0o600);
  writeNew(join(out, "router.dev.vars"), formatDevVars({ GITHUB_APP_WEBHOOK_SECRET: secret }), 0o600);
  return { root, publicKeyVars, webhookSecret: secret, licenseCert: licCert };
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: { out: { type: "string" }, name: { type: "string" }, root: { type: "string" }, pub: { type: "string" }, purpose: { type: "string" }, days: { type: "string" } },
  });
  const need = (k) => {
    if (!values[k]) throw new Error(`${cmd} needs --${k}`);
    return values[k];
  };
  switch (cmd) {
    case "gen-root":
    case "gen-issuing": {
      const pair = await genPair(need("out"), values.name ?? (cmd === "gen-root" ? "root" : "issuing"));
      console.log(pair.keyId);
      return;
    }
    case "certify": {
      const days = Number(need("days"));
      if (!Number.isInteger(days) || days <= 0) throw new Error("--days must be a positive whole number");
      console.log(JSON.stringify(await certify(readFileSync(need("root"), "utf8"), readFileSync(need("pub"), "utf8"), need("purpose"), days)));
      return;
    }
    case "dev-chain": {
      const out = need("out");
      const chain = await devChain(out);
      console.log(`dev chain in ${out}: root ${chain.root.keyId}; public-key.dev.vars and router.dev.vars hold the Workers' dev secrets`);
      return;
    }
    default:
      throw new Error("usage: keys.mjs gen-root|gen-issuing|certify|dev-chain ...");
  }
}

if (import.meta.filename === process.argv[1]) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`keys: ${err.message}`);
    process.exit(1);
  });
}
