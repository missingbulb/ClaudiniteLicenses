import { defineProject } from "vitest/config";

export default defineProject({
  test: { name: "http", environment: "node" },
});
