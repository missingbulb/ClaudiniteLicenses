import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineProject } from "vitest/config";

export default defineProject({
  plugins: [
    cloudflareTest(({ inject }) => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: { ...inject("devVars"), DEV_ROOTS: JSON.stringify(inject("devRoots")), GITHUB_API_BASE: "https://github-api.test" },
      },
    })),
  ],
  test: { name: "public-key", globalSetup: ["./test/global-setup.ts"] },
});
