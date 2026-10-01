import { afterEach, beforeEach, expect, it } from "vitest";
import { polarClient, POLAR_VERSION, listManagedProducts } from "../../packages/polar/src/index.ts";
import { startPolarStub } from "../polar-stub.mjs";

let stub: Awaited<ReturnType<typeof startPolarStub>>;

beforeEach(async () => {
  stub = await startPolarStub();
});

afterEach(async () => {
  stub.slow(0);
  await stub.close();
});

it("holds every answer past a caller's deadline while slow, and answers at once again after", async () => {
  const client = polarClient({ base: stub.base, token: stub.token, version: POLAR_VERSION, timeoutMs: 100 });
  stub.slow(1000);
  await expect(listManagedProducts(client)).rejects.toThrow(/timed out after 100 ms/);
  stub.slow(0);
  expect(await listManagedProducts(client)).toBeDefined();
});
