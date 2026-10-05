import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/signing", "packages/licensing", "packages/polar", "packages/github-app", "packages/version", "packages/http", "workers/key", "workers/sync", "db", "tools"],
  },
});
