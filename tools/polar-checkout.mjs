#!/usr/bin/env node
// Creates a Polar checkout for a plan, an owner and (for Private repo) a repo, with the code the key
// Worker bundles, and prints its url. Nothing is bought; the checkout expires on its own. Reads
// POLAR_API_BASE and POLAR_ACCESS_TOKEN.
//
//   node tools/polar-checkout.mjs --plan <plan> --owner-id <n> --owner-login <login> --owner-type User|Organization [--repo-id <n> --repo <owner/name>]
import { parseArgs } from "node:util";
import { createCheckout, polarClient, POLAR_VERSION } from "../packages/polar/src/index.ts";

const USAGE = "usage: POLAR_API_BASE=... POLAR_ACCESS_TOKEN=... node tools/polar-checkout.mjs --plan <plan> --owner-id <n> --owner-login <login> --owner-type User|Organization [--repo-id <n> --repo <owner/name>]";

if (import.meta.filename === process.argv[1]) {
  const { values: v } = parseArgs({
    options: { plan: { type: "string" }, "owner-id": { type: "string" }, "owner-login": { type: "string" }, "owner-type": { type: "string" }, "repo-id": { type: "string" }, repo: { type: "string" } },
  });
  const base = process.env.POLAR_API_BASE;
  const token = process.env.POLAR_ACCESS_TOKEN;
  const ownerId = Number(v["owner-id"]);
  const ownerType = v["owner-type"];
  const repoId = v["repo-id"] === undefined ? null : Number(v["repo-id"]);
  if (
    !base ||
    !token ||
    !v.plan ||
    !Number.isSafeInteger(ownerId) ||
    !v["owner-login"] ||
    (ownerType !== "User" && ownerType !== "Organization") ||
    (repoId !== null && (!Number.isSafeInteger(repoId) || !v.repo)) ||
    (v.plan === "private-repo" && repoId === null)
  ) {
    console.error(USAGE);
    process.exit(2);
  }
  try {
    const client = polarClient({ base, token, version: POLAR_VERSION, retries: 3, userAgent: "claudinite-licenses-deploy" });
    const repo = repoId !== null && v.repo ? { id: repoId, fullName: v.repo } : undefined;
    const made = await createCheckout(client, { plan: v.plan, ownerId, ownerLogin: v["owner-login"], ownerType, repo });
    console.log(made.url);
  } catch (err) {
    console.error(`polar-checkout: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  }
}
