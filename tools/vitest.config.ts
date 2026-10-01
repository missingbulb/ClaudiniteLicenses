import { defineProject } from "vitest/config";

export default defineProject({
  test: { name: "tools", environment: "node", testTimeout: 30_000 },
});
