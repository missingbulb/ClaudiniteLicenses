import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { b64urlDecode, keyId, verifyCertificate, type Use } from "../src/index.ts";

// ClaudiniteEngine's shared/sign/testdata/vectors.json is the cross-repo contract for the
// certificate encoding. Point CLAUDINITE_ENGINE_VECTORS at a copy of it (an Engine checkout's
// file, or one committed at vectors/engine.json) to run these cases.
const path = process.env.CLAUDINITE_ENGINE_VECTORS ?? resolve(import.meta.dirname, "../vectors/engine.json");
const present = existsSync(path);

interface EngineVectors {
  keyIdVector: { publicKey: string; keyId: string };
  roots: Record<string, { publicKey: string }>;
  certificateCases: { name: string; certificate: unknown; root: string; use: string; now: string; valid: boolean }[];
}

it.skipIf(!present)(`verifies every certificate case in Engine's vectors (${path})`, async () => {
  const v = JSON.parse(readFileSync(path, "utf8")) as EngineVectors;
  expect(await keyId(b64urlDecode(v.keyIdVector.publicKey))).toBe(v.keyIdVector.keyId);
  expect(v.certificateCases.length).toBeGreaterThanOrEqual(10);
  const mismatches: string[] = [];
  for (const c of v.certificateCases) {
    const root = v.roots[c.root];
    if (!root) throw new Error(`case ${c.name} names unknown root ${c.root}`);
    // An unknown use cannot match any certificate, so it is refused whatever the certificate says.
    const res = await verifyCertificate(c.certificate, [root.publicKey], c.use as Use, new Date(c.now));
    if (res.ok !== c.valid) mismatches.push(`${c.name}: got ${JSON.stringify(res)}, want valid=${c.valid}`);
  }
  expect(mismatches).toEqual([]);
});
