import { describe, expect, it } from "vitest";
import { KEY_COUNT_BLOBS, keyCountBlobs } from "../src/index.ts";

describe("KEY_COUNT_BLOBS", () => {
  it("pins the order both Workers write and the reader maps blob1..blob5 from", () => {
    expect(KEY_COUNT_BLOBS).toEqual(["plan", "outcome", "ownerType", "engineVersion", "path"]);
  });

  it("places each field at its index", () => {
    const p = { plan: "personal", outcome: "issued", ownerType: "User", engineVersion: "1.2.3", path: "web" };
    const blobs = keyCountBlobs(p);
    expect(blobs).toHaveLength(KEY_COUNT_BLOBS.length);
    KEY_COUNT_BLOBS.forEach((name, i) => expect(blobs[i]).toBe(p[name]));
  });

  it("ignores fields outside the order", () => {
    expect(keyCountBlobs({ plan: "a", outcome: "b", ownerType: "c", engineVersion: "d", path: "e", repoId: "9" } as never)).toEqual(["a", "b", "c", "d", "e"]);
  });
});
