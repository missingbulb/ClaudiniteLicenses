import { describe, expect, it } from "vitest";
import { refusalSummary } from "../src/index.ts";

describe("refusalSummary", () => {
  it("puts the reason before the first colon, where the binary cuts the cause", () => {
    const text = "this repo is private; the Public plan covers public repos only";
    expect(refusalSummary("refused-private", text)).toBe(`refused-private: ${text}`);
    expect(refusalSummary("server-error", "try again shortly").split(":")[0]).toBe("server-error");
  });

  it("refuses a text holding a colon, which would move the cut, and a reason that is not one word", () => {
    expect(() => refusalSummary("refused-private", "see https://claudinite.com")).toThrow(/colon/);
    expect(() => refusalSummary("refused: private", "text")).toThrow();
    expect(() => refusalSummary("", "text")).toThrow();
  });
});
