import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { verifyKey } from "../src/index.ts";
import { generateVectors, VECTORS_PATH } from "../scripts/gen-vectors.ts";

interface KeyVectors {
  now: string;
  roots: Record<string, { publicKey: string }>;
  keyCases: { name: string; key: string; valid: boolean; reason?: string }[];
}

it("the committed vectors equal a fresh generation", async () => {
  expect(readFileSync(VECTORS_PATH, "utf8")).toBe(await generateVectors());
});

// Replays the file the way the cn binary will: only what the file says.
it("every committed key case verifies to its stated result", async () => {
  const v = JSON.parse(readFileSync(VECTORS_PATH, "utf8")) as KeyVectors;
  const roots = [v.roots.root!.publicKey, v.roots.standby!.publicKey];
  expect(v.keyCases.filter((c) => c.valid).length).toBeGreaterThanOrEqual(3);
  expect(v.keyCases.filter((c) => !c.valid).length).toBeGreaterThanOrEqual(5);
  const got = await Promise.all(
    v.keyCases.map(async (c) => {
      const res = await verifyKey(c.key, { roots, now: new Date(v.now) });
      return { name: c.name, valid: res.ok, ...(res.ok ? {} : { reason: res.reason }) };
    }),
  );
  expect(got).toEqual(v.keyCases.map((c) => ({ name: c.name, valid: c.valid, ...(c.reason ? { reason: c.reason } : {}) })));
});
