import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineProject } from "vitest/config";

export default defineProject({
  plugins: [
    cloudflareTest(async ({ inject }) => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ...inject("keyVars"),
          DEV_ROOTS: JSON.stringify(inject("devRoots")),
          TRUST_ROOTS: JSON.stringify(inject("devRoots")),
          TEST_MIGRATIONS: await readD1Migrations(new URL("../../db/migrations", import.meta.url).pathname),
          GITHUB_API_BASE: "https://github-api.test",
          GITHUB_WEB_BASE: "https://github-web.test",
          OIDC_ISSUER: "https://oidc.test",
        },
      },
    })),
  ],
  test: { name: "key", globalSetup: ["./test/global-setup.ts"] },
});
