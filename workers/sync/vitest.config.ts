import { generateKeyPairSync } from "node:crypto";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineProject } from "vitest/config";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });

export default defineProject({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(new URL("../../db/migrations", import.meta.url).pathname),
          GITHUB_APP_ID: "4242",
          GITHUB_APP_PRIVATE_KEY: privateKey,
          SYNC_ADMIN_TOKEN: "acme-admin-token",
          GITHUB_API_BASE: "https://github-api.test",
        },
      },
    })),
  ],
  test: { name: "sync" },
});
