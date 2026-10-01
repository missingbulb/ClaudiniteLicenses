import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/signing", "packages/licensing", "packages/polar", "packages/github-app", "workers/router", "workers/public-key", "workers/key", "workers/sync", "db", "tools", "spike"],
  },
});
