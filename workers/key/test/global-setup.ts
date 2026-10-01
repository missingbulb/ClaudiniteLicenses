import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
import { devChain } from "../../../tools/keys.mjs";

declare module "vitest" {
  export interface ProvidedContext {
    keyVars: Record<string, string>;
    devRoots: string[];
  }
}

// The dev chain from tools/keys.mjs, made once per run and handed to the Worker as its secrets.
export default async function setup(project: TestProject) {
  const dir = mkdtempSync(join(tmpdir(), "acme-dev-chain-"));
  const chain = await devChain(dir);
  project.provide("keyVars", chain.keyVars);
  project.provide("devRoots", [readFileSync(join(dir, "root.pub"), "utf8").trim(), readFileSync(join(dir, "standby.pub"), "utf8").trim()]);
  return () => rmSync(dir, { recursive: true, force: true });
}
