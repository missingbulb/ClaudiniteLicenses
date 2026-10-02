import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

// D1 has no read-only binding, so the key Worker's source is pinned instead: it never writes.
it("the key Worker's source holds no INSERT, UPDATE or DELETE", () => {
  const dir = resolve(import.meta.dirname, "../../workers/key/src");
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
  expect(files.length).toBeGreaterThanOrEqual(5);
  const hits = files.filter((f) => /\b(INSERT|UPDATE|DELETE)\b/.test(readFileSync(join(dir, f), "utf8")));
  expect(hits).toEqual([]);
});

// A writer's constraint in a Worker that never writes would send every key's first read to the
// primary for nothing; the key Worker's reads are one unconstrained session per request.
it("the key Worker's source never opens a first-primary session", () => {
  const dir = resolve(import.meta.dirname, "../../workers/key/src");
  const hits = readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => /first-primary/.test(readFileSync(join(dir, f), "utf8").replace(/^\s*(\/\/|\*).*$/gm, "")));
  expect(hits).toEqual([]);
});
