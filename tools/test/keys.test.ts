import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { b64urlDecode, keyId, signKey, verifyCertificate, verifyKey, type KeyPayload } from "../../packages/signing/src/index.ts";
import { parseDevVars, trustRoots } from "../keys.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const KEYS = resolve(ROOT, "tools/keys.mjs");
const run = (...args: string[]) => execFileSync(process.execPath, [KEYS, ...args], { encoding: "utf8" });
const tmp = () => mkdtempSync(join(tmpdir(), "acme-keys-"));
const read = (p: string) => readFileSync(p, "utf8").trim();

describe("tools/keys.mjs", () => {
  it("gen-root writes a 0600 private key and a public key, and refuses to overwrite", () => {
    const dir = tmp();
    const out = run("gen-root", "--out", dir);
    expect(out).toMatch(/^[0-9a-f]{16}$/m);
    expect(statSync(join(dir, "root.key")).mode & 0o777).toBe(0o600);
    expect(read(join(dir, "root.pub"))).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const again = spawnSync(process.execPath, [KEYS, "gen-root", "--out", dir], { encoding: "utf8" });
    expect(again.status).not.toBe(0);
  });

  it("certify prints a certificate that verifies against the root for its purpose", async () => {
    const dir = tmp();
    run("gen-root", "--out", dir);
    run("gen-issuing", "--out", dir);
    const cert = JSON.parse(run("certify", "--root", join(dir, "root.key"), "--pub", join(dir, "issuing.pub"), "--purpose", "license-public", "--days", "90"));
    const res = await verifyCertificate(cert, [read(join(dir, "root.pub"))], "license-public", new Date());
    expect(res.ok).toBe(true);
    const tooLong = spawnSync(process.execPath, [KEYS, "certify", "--root", join(dir, "root.key"), "--pub", join(dir, "issuing.pub"), "--purpose", "license", "--days", "91"], { encoding: "utf8" });
    expect(tooLong.status).not.toBe(0);
  });

  it("dev-chain writes a chain whose dev.vars sign keys that verify against its roots", async () => {
    const dir = tmp();
    run("dev-chain", "--out", dir);
    const roots = [read(join(dir, "root.pub")), read(join(dir, "standby.pub"))];
    const vars = parseDevVars(readFileSync(join(dir, "public-key.dev.vars"), "utf8"));
    const payload = { v: 1, typ: "session", kid: "", repo_id: 1, owner_id: 2, owner_type: "User", owner_login: "acme-user", plan: "public", user_id: 3, nonce: "acme-nonce-0123456789", iat: Math.floor(Date.now() / 1000) - 5, exp: Math.floor(Date.now() / 1000) + 3600, state: "ok", grace_until: null, features: [], release: { held: [], revoked: [], security_fixes: [], pack_index_serial: 0, pack_keys: [] } } satisfies KeyPayload;
    const key = await signKey(vars.ISSUING_KEY_PRIVATE!, JSON.parse(vars.ISSUING_KEY_CERT!), payload);
    expect((await verifyKey(key, { roots, now: new Date() })).ok).toBe(true);
    expect(vars.GITHUB_APP_PRIVATE_KEY).toMatch(/^-----BEGIN RSA PRIVATE KEY-----\n/);
    expect(vars.GITHUB_APP_ID).toMatch(/^\d+$/);

    const lic = JSON.parse(read(join(dir, "license.cert.json")));
    expect((await verifyCertificate(lic, roots, "license", new Date())).ok).toBe(true);
    const router = parseDevVars(readFileSync(join(dir, "router.dev.vars"), "utf8"));
    expect(router.GITHUB_APP_WEBHOOK_SECRET!.length).toBeGreaterThanOrEqual(32);

    const keyVars = parseDevVars(readFileSync(join(dir, "key.dev.vars"), "utf8"));
    const paid = await signKey(keyVars.ISSUING_KEY_PRIVATE!, JSON.parse(keyVars.ISSUING_KEY_CERT!), { ...payload, plan: "personal" });
    expect((await verifyKey(paid, { roots, now: new Date() })).ok).toBe(true);
    expect(JSON.parse(keyVars.ISSUING_KEY_CERT!)).toEqual(lic);
    expect(keyVars.GITHUB_APP_PRIVATE_KEY).toBe(vars.GITHUB_APP_PRIVATE_KEY);
    expect(JSON.parse(keyVars.TRUST_ROOTS!)).toEqual(roots);
    const sync = parseDevVars(readFileSync(join(dir, "sync.dev.vars"), "utf8"));
    expect(sync).toEqual({ GITHUB_APP_ID: vars.GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY: vars.GITHUB_APP_PRIVATE_KEY });
  });

  it("trust-roots prints the committed roots, the key ceremony's root and standby, as the key Worker's committed TRUST_ROOTS holds", async () => {
    const committed = ["root.pub", "standby.pub"].map((f) => read(join(ROOT, "packages/signing/roots", f)));
    expect(await Promise.all(committed.map(async (k) => keyId(b64urlDecode(k))))).toEqual(["ea85f35421f375fc", "196c6acb9cc31774"]);
    expect(trustRoots(ROOT)).toEqual(committed);
    const config = JSON.parse(readFileSync(join(ROOT, "workers/key/wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
    expect(JSON.parse(config.vars.TRUST_ROOTS)).toEqual(committed);
    expect(JSON.parse(run("trust-roots").trim())).toEqual(committed);
    const fake = tmp();
    mkdirSync(join(fake, "packages/signing/roots"), { recursive: true });
    writeFileSync(join(fake, "packages/signing/roots/b-standby.pub"), "bbb\n");
    writeFileSync(join(fake, "packages/signing/roots/a-root.pub"), "aaa\n");
    writeFileSync(join(fake, "packages/signing/roots/README.md"), "not a key\n");
    expect(trustRoots(fake)).toEqual(["aaa", "bbb"]);
    expect(() => trustRoots(tmp())).toThrow(/holds no \.pub root key/);
  });
});
