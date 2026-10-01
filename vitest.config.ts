import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/signing", "packages/github-app", "workers/router", "workers/public-key", "db", "tools", "spike"],
  },
});
