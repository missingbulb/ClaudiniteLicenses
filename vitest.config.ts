import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/signing", "workers/router", "workers/public-key", "db", "tools", "spike"],
  },
});
