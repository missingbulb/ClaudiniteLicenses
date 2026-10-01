import { defineProject } from "vitest/config";

export default defineProject({
  test: { name: "version", environment: "node" },
});
