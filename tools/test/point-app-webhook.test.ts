import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { startStub } from "../github-stub.mjs";
import { pointAppWebhook } from "../point-app-webhook.mjs";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const ROOT = resolve(import.meta.dirname, "../..");
let stub: Awaited<ReturnType<typeof startStub>>;

afterEach(async () => stub?.close());

describe("tools/point-app-webhook.mjs", () => {
  it("patches the App's webhook config and reads back what GitHub holds", async () => {
    stub = await startStub();
    const held = await pointAppWebhook({ base: stub.base, appId: "1", privateKey, url: "https://license.claudinite.com/github-webhook" });
    expect(stub.state.hookPatches).toEqual([{ url: "https://license.claudinite.com/github-webhook", content_type: "json", insecure_ssl: "0" }]);
    expect(held.url).toBe("https://license.claudinite.com/github-webhook");
    expect(stub.state.requests).toEqual(["PATCH /app/hook/config", "GET /app/hook/config"]);
  });

  it("fails when the read-back differs from what it sent", async () => {
    stub = await startStub();
    const original = stub.state.hookConfig;
    // A GitHub that accepts the PATCH but keeps the old URL.
    Object.defineProperty(stub.state, "hookConfig", { get: () => ({ ...original, url: "https://elsewhere.invalid/hook" }) });
    await expect(pointAppWebhook({ base: stub.base, appId: "1", privateKey, url: "https://license.claudinite.com/github-webhook" })).rejects.toThrow(/elsewhere\.invalid/);
  });
});

describe("point-webhook.yml", () => {
  // Runs the workflow's step the way Actions would: its env resolved from secrets and the input's default.
  it("points the webhook at its default url with the App's repository secrets", async () => {
    stub = await startStub();
    const wf = parse(readFileSync(join(ROOT, ".github/workflows/point-webhook.yml"), "utf8"));
    const step = (wf.jobs.point.steps as { run?: string; env?: Record<string, string> }[]).find((s) => s.run)!;
    const context: Record<string, string> = {
      "secrets.CLAUDINITE_GITHUB_APP_ID": "1",
      "secrets.CLAUDINITE_GITHUB_APP_PRIVATE_KEY": privateKey,
      "inputs.url": wf.on.workflow_dispatch.inputs.url.default,
    };
    const env = Object.fromEntries(Object.entries(step.env ?? {}).map(([k, v]) => [k, String(v).replace(/^\$\{\{\s*([\w.]+)\s*\}\}$/, (_, ref: string) => context[ref] ?? "")]));
    await promisify(execFile)("bash", ["-e", "-c", step.run!], { cwd: ROOT, env: { PATH: process.env.PATH!, GITHUB_API_URL: stub.base, ...env } });
    expect(stub.state.hookPatches).toEqual([{ url: "https://license.claudinite.com/github-webhook", content_type: "json", insecure_ssl: "0" }]);
  });
});
