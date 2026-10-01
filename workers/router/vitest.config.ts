import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineProject } from "vitest/config";

// The tests pass their own env with recording stubs; these only let the configured Worker boot.
export default defineProject({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: { GITHUB_APP_WEBHOOK_SECRET: "unused-in-tests" },
        serviceBindings: { PUBLIC_KEY: () => new Response("not used in tests", { status: 501 }) },
      },
    }),
  ],
  test: { name: "router" },
});
