import { defineProject } from "vitest/config";

export default defineProject({
  test: { name: "spike", environment: "node", testTimeout: 30_000 },
});
