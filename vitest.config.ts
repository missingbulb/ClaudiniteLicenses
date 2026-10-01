import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["workers/router", "workers/public-key"],
  },
});
