import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WEBHOOK_EVENTS } from "../../packages/polar/src/index.ts";
import { ensurePolarWebhook } from "../ensure-polar-webhook.mjs";
import { startPolarStub } from "../polar-stub.mjs";

const TOOL = resolve(import.meta.dirname, "../ensure-polar-webhook.mjs");
const URL_ = "https://license.claudinite.com/v1/sync/polar-webhook";
let stub: Awaited<ReturnType<typeof startPolarStub>>;

beforeEach(async () => {
  stub = await startPolarStub();
});
afterEach(async () => stub.close());

const secretPath = () => join(mkdtempSync(join(tmpdir(), "acme-webhook-")), "polar-webhook-secret");
const run = (secretOut: string, rotate = false) => ensurePolarWebhook({ base: stub.base, token: stub.token, url: URL_, secretOut, rotate });

describe("tools/ensure-polar-webhook.mjs", () => {
  it("creates the endpoint once for every event the sync Worker reads, writing its secret 0600, and keeps it the second time writing nothing", async () => {
    const first = secretPath();
    expect(await run(first)).toMatchObject({ kept: false });
    expect(stub.state.endpoints).toHaveLength(1);
    expect(stub.state.endpoints[0]).toMatchObject({ url: URL_, events: WEBHOOK_EVENTS, format: "raw" });
    expect(readFileSync(first, "utf8")).toBe(stub.state.endpoints[0]!.secret);
    expect(statSync(first).mode & 0o777).toBe(0o600);
    const second = secretPath();
    expect(await run(second)).toMatchObject({ kept: true });
    expect(existsSync(second)).toBe(false);
    expect(stub.state.endpoints).toHaveLength(1);
  });

  it("with --rotate deletes the endpoint and makes a new one with a new secret", async () => {
    await run(secretPath());
    const old = stub.state.endpoints[0]!;
    const out = secretPath();
    expect(await run(out, true)).toMatchObject({ kept: false });
    expect(stub.state.endpoints).toHaveLength(1);
    expect(stub.state.endpoints[0]!.id).not.toBe(old.id);
    expect(readFileSync(out, "utf8")).toBe(stub.state.endpoints[0]!.secret);
    expect(readFileSync(out, "utf8")).not.toBe(old.secret);
  });

  it("runs from the command line, never printing the secret", async () => {
    const out = secretPath();
    const child = spawn(process.execPath, [TOOL, "--url", URL_, "--secret-out", out, "--rotate"], { env: { ...process.env, POLAR_API_BASE: stub.base, POLAR_ACCESS_TOKEN: stub.token } });
    let text = "";
    child.stdout.on("data", (c) => (text += c));
    child.stderr.on("data", (c) => (text += c));
    expect(await new Promise((done) => child.on("close", done))).toBe(0);
    expect(text).toMatch(/^created: .* for https:\/\/license\.claudinite\.com/m);
    expect(text).not.toContain(readFileSync(out, "utf8"));
  });

  it("refuses to run without POLAR_API_BASE", async () => {
    const child = spawn(process.execPath, [TOOL, "--url", URL_, "--secret-out", secretPath()], { env: { ...process.env, POLAR_API_BASE: "", POLAR_ACCESS_TOKEN: stub.token } });
    expect(await new Promise((done) => child.on("close", done))).toBe(2);
  });
});
