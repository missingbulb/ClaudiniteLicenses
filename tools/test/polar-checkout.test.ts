import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { desiredProducts, readPlans } from "../polar-products.mjs";
import { startPolarStub } from "../polar-stub.mjs";

const TOOL = resolve(import.meta.dirname, "../polar-checkout.mjs");
let stub: Awaited<ReturnType<typeof startPolarStub>>;

beforeEach(async () => {
  stub = await startPolarStub();
  for (const d of desiredProducts(readPlans())) stub.addProduct({ name: d.name, metadata: d.metadata, recurring_interval: d.interval, prices: [d.price] });
});
afterEach(async () => stub.close());

function run(args: string[]) {
  const child = spawn(process.execPath, [TOOL, ...args], { env: { ...process.env, POLAR_API_BASE: stub.base, POLAR_ACCESS_TOKEN: stub.token } });
  let out = "";
  let err = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (err += c));
  return new Promise<{ code: number | null; out: string; err: string }>((done) => child.on("close", (code) => done({ code, out, err })));
}

describe("tools/polar-checkout.mjs", () => {
  it("creates a fleet checkout for the owner and prints only its url", async () => {
    const res = await run(["--plan", "personal", "--owner-id", "73882448", "--owner-login", "missingbulb", "--owner-type", "User"]);
    expect(res.code, res.err).toBe(0);
    expect(res.out.trim()).toMatch(/^https:\/\//);
    const body = stub.state.checkouts.at(-1)!.body;
    expect(body.external_customer_id).toBe("73882448");
    expect(body.products).toHaveLength(2);
    expect(body.metadata).toEqual({ claudinite_plan: "personal", github_owner_id: "73882448", github_owner_login: "missingbulb", github_owner_type: "User" });
  });

  it("refuses a missing argument, and the retired repo arguments, with usage and no Polar call", async () => {
    for (const args of [
      ["--plan", "personal", "--owner-id", "73882448", "--owner-login", "missingbulb"],
      ["--plan", "personal", "--owner-id", "73882448", "--owner-login", "missingbulb", "--owner-type", "User", "--repo-id", "1001", "--repo", "missingbulb/ClaudiniteLicenses"],
    ]) {
      const res = await run(args);
      expect(res.code, args.join(" ")).toBe(2);
      expect(res.err).toMatch(/usage|Unknown option/);
    }
    expect(stub.state.checkouts).toHaveLength(0);
  });
});
