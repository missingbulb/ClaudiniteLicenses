/// <reference types="vite/client" />
// The sync Worker is D1's only writer, and its reads must see its own writes: the reconciles'
// diffs, the alerts, and the stamps the deploy's judge compares seconds after the consumer wrote
// them. Cloudflare's D1 read replication page (developers.cloudflare.com/d1/best-practices/
// read-replication/, read 2026-10-02): "To use read replication, you must use the D1 Sessions API,
// otherwise all queries will continue to be executed only by the primary database." So the sync
// Worker opens no session, and this pins it.
import { expect, it } from "vitest";

const sources = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

it("reads the sync Worker's whole source", () => {
  expect(Object.keys(sources).length).toBeGreaterThanOrEqual(5);
  expect(Object.keys(sources)).toContain("../src/index.ts");
});

it("no sync Worker source opens a D1 session, so every read goes to the primary", () => {
  const hits = Object.entries(sources)
    .filter(([, text]) => /withSession/.test(text))
    .map(([path]) => path);
  expect(hits).toEqual([]);
});
