import { createExecutionContext, env } from "cloudflare:test";
import { expect, it } from "vitest";
import worker from "../src/index.ts";

it("answers a request with a Response", async () => {
  const res = await worker.fetch(new Request("https://license.claudinite.com/"), env as never, createExecutionContext());
  expect(res).toBeInstanceOf(Response);
});
