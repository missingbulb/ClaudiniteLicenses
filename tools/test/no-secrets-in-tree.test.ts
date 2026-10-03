import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// No credential is committed: every tracked file is read for the shapes a real secret takes. The
// signing vectors are the deliberate exception, keys no released binary trusts, published so the
// tests and the engine can verify against them; the committed roots are public keys, which a seed's
// shape cannot tell apart.
const ROOT = resolve(import.meta.dirname, "../..");
const ALLOWED = [/^packages\/signing\/vectors\/keys\.json$/, /^packages\/signing\/roots\/[^/]+\.pub$/];

const SHAPES: { name: string; re: RegExp }[] = [
  // A header followed by key material, on the next line or after an escaped newline.
  { name: "PEM private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:\r?\n|\\n)[A-Za-z0-9+/=]{40,}/ },
  { name: "Polar webhook secret", re: /\bwhsec_[A-Za-z0-9+/=]{16,}/ },
  { name: "Polar token", re: /\bpolar_(?:oat|pat)_[A-Za-z0-9]{16,}/ },
  { name: "GitHub token", re: /\b(?:ghp|ghs|ghu|ghr|gho)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}/ },
  // A 32-byte seed in base64url: a line that is nothing else, or the value of a seed or private key field.
  { name: "32-byte seed", re: /^\s*[A-Za-z0-9_-]{43}\s*$|"(?:seed|private(?:_?key)?)"\s*:\s*"[A-Za-z0-9_-]{43}"/im },
];

const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
const scan = (text: string) => SHAPES.filter((s) => s.re.test(text)).map((s) => s.name);

describe("the tracked tree", () => {
  it("reads every tracked file, so the scan is not silently empty", () => {
    expect(tracked.length).toBeGreaterThan(100);
    expect(tracked).toContain("workers/key/wrangler.jsonc");
  });

  it("holds no credential-shaped value outside the signing vectors and the committed root public keys", () => {
    const found = tracked
      .filter((f) => !ALLOWED.some((a) => a.test(f)) && !/\.(png|jpg|ico|woff2?)$/.test(f))
      .flatMap((f) => scan(readFileSync(join(ROOT, f), "utf8")).map((name) => `${f}: ${name}`));
    expect(found).toEqual([]);
  });

  it("would refuse each shape, and passes the placeholders the examples carry", () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${"M".repeat(64)}\n-----END RSA PRIVATE KEY-----`;
    const samples = [pem, JSON.stringify(pem), `whsec_${"A".repeat(32)}`, `polar_oat_${"a".repeat(40)}`, `ghs_${"a".repeat(36)}`, `github_pat_${"a".repeat(60)}`, "zdxeybhtkgywOc--Gs27iVbunZwwkpU3Xwc69KeDJs0", `{"seed": "${"a".repeat(43)}"}`];
    for (const s of samples) expect(scan(s), s.slice(0, 40)).toHaveLength(1);
    for (const s of ['GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\\n...\\n-----END RSA PRIVATE KEY-----\\n"', "polar_oat_acme", "ghs_acme", "whsec_acme"]) expect(scan(s), s).toEqual([]);
    expect(ALLOWED.some((a) => a.test("packages/signing/vectors/keys.json"))).toBe(true);
  });
});
