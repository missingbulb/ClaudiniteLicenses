import { describe, expect, it } from "vitest";
import { VERSION_HEADER, versionOf, withVersion } from "../src/index.ts";

const ID = "acme0000-0000-4000-8000-000000000001";

describe("versionOf", () => {
  it("reads the binding's id, and null when the binding or its id is absent", () => {
    expect(versionOf({ CF_VERSION_METADATA: { id: ID } })).toBe(ID);
    expect(versionOf({})).toBeNull();
    expect(versionOf({ CF_VERSION_METADATA: { id: "" } })).toBeNull();
  });
});

describe("withVersion", () => {
  it("sets the header on any status and keeps the status, body and other headers", async () => {
    for (const status of [200, 404, 503]) {
      const res = withVersion(new Response("body", { status, headers: { "Content-Type": "text/plain" } }), ID);
      expect([res.status, res.headers.get(VERSION_HEADER), res.headers.get("Content-Type"), await res.text()]).toEqual([status, ID, "text/plain", "body"]);
    }
  });

  it("replaces a callee's version, and leaves an answer alone when the version is unknown", () => {
    const callee = new Response(null, { status: 201, headers: { [VERSION_HEADER]: "callee" } });
    expect(withVersion(callee, ID).headers.get(VERSION_HEADER)).toBe(ID);
    const plain = new Response(null, { status: 204 });
    expect(withVersion(plain, null)).toBe(plain);
  });
});
