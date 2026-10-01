import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { startStub } from "../github-stub.mjs";
import { pointAppWebhook } from "../point-app-webhook.mjs";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
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
