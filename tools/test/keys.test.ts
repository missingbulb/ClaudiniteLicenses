import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { signKey, verifyCertificate, verifyKey, type KeyPayload } from "../../packages/signing/src/index.ts";
import { parseDevVars } from "../keys.mjs";

const KEYS = resolve(import.meta.dirname, "../keys.mjs");
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

  it("dev-chain writes the key and sync Workers' dev.vars: a license key that verifies against its roots, and the App's secrets on sync alone", async () => {
    const dir = tmp();
    run("dev-chain", "--out", dir);
    const roots = [read(join(dir, "root.pub")), read(join(dir, "standby.pub"))];
    const lic = JSON.parse(read(join(dir, "license.cert.json")));
    expect((await verifyCertificate(lic, roots, "license", new Date())).ok).toBe(true);

    const keyVars = parseDevVars(readFileSync(join(dir, "key.dev.vars"), "utf8"));
    expect(Object.keys(keyVars).sort()).toEqual(["ISSUING_KEY_CERT", "ISSUING_KEY_PRIVATE"]);
    const payload = { v: 1, typ: "actions", kid: "", repo_id: 1, owner_id: 2, owner_type: "User", owner_login: "acme-user", plan: "personal", iat: Math.floor(Date.now() / 1000) - 5, exp: Math.floor(Date.now() / 1000) + 3600, state: "ok", grace_until: null, features: [], release: { held: [], revoked: [], security_fixes: [], pack_index_serial: 0, pack_keys: [] } } satisfies KeyPayload;
    const key = await signKey(keyVars.ISSUING_KEY_PRIVATE!, JSON.parse(keyVars.ISSUING_KEY_CERT!), payload);
    expect((await verifyKey(key, { roots, now: new Date() })).ok).toBe(true);
    expect(JSON.parse(keyVars.ISSUING_KEY_CERT!)).toEqual(lic);

    const sync = parseDevVars(readFileSync(join(dir, "sync.dev.vars"), "utf8"));
    expect(sync.GITHUB_APP_PRIVATE_KEY).toMatch(/^-----BEGIN RSA PRIVATE KEY-----\n/);
    expect(sync.GITHUB_APP_ID).toMatch(/^\d+$/);
    expect(sync.GITHUB_APP_WEBHOOK_SECRET!.length).toBeGreaterThanOrEqual(32);
    for (const f of ["public-key.dev.vars", "router.dev.vars", "license-public.cert.json"]) expect(existsSync(join(dir, f)), f).toBe(false);
  });

  it("has no trust-roots command: nothing grants on an Actions key any more", () => {
    expect(spawnSync(process.execPath, [KEYS, "trust-roots"], { encoding: "utf8" }).status).not.toBe(0);
  });
});
