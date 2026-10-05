import { describe, expect, it } from "vitest";
import { FEATURES } from "../../signing/src/index.ts";
import { INCIDENT_MARKERS, isWriteMessage, paidSeats, planFeatures, type SubscriptionRow } from "../src/index.ts";

const DAY = 86400;
const NOW = 1_790_000_000;

const sub = (over: Partial<SubscriptionRow> = {}): SubscriptionRow => ({ plan: "personal", seats: 5, repo_ids: null, status: "active", ended_at: null, ...over });

const allButFleet = FEATURES.filter((f) => f !== "fleet");

describe("planFeatures", () => {
  it("gives Public and Private repo every feature but fleet, and the owner-wide plans every feature", () => {
    expect(planFeatures("public")).toEqual(allButFleet);
    expect(planFeatures("private-repo")).toEqual(allButFleet);
    for (const plan of ["personal", "organization", "internal"] as const) expect(planFeatures(plan)).toEqual([...FEATURES]);
  });
});

describe("paidSeats", () => {
  it("sums the Private repo rows naming the repo and ignores one naming another", () => {
    const rows = [sub({ plan: "private-repo", seats: 3, repo_ids: "[1001]" }), sub({ plan: "private-repo", seats: 2, repo_ids: "[1001]" }), sub({ plan: "private-repo", seats: 9, repo_ids: "[4040]" })];
    expect(paidSeats(rows, NOW, { plan: "private-repo", repoId: 1001 })).toBe(5);
    expect(paidSeats(rows, NOW, { plan: "private-repo", repoId: 4040 })).toBe(9);
  });

  it("counts active, trialing and past_due rows, and ignores a revoked, an incomplete or another plan's row", () => {
    const rows = [
      sub({ seats: 5 }),
      sub({ seats: 2, status: "trialing" }),
      sub({ seats: 1, status: "past_due" }),
      sub({ seats: 7, status: "canceled", ended_at: NOW - DAY }),
      sub({ seats: 4, status: "incomplete" }),
      sub({ seats: 6, status: "active", ended_at: NOW - DAY }),
      sub({ plan: "organization", seats: 11 }),
    ];
    expect(paidSeats(rows, NOW, { plan: "personal", repoId: 1001 })).toBe(8);
    expect(paidSeats(rows, NOW, { plan: "organization", repoId: 1001 })).toBe(11);
  });

  it("counts a canceled row that has not ended: the seats last to the period's end", () => {
    expect(paidSeats([sub({ status: "canceled", seats: 3 })], NOW, { plan: "personal", repoId: 1 })).toBe(0);
    expect(paidSeats([sub({ status: "active", seats: 3 })], NOW, { plan: "personal", repoId: 1 })).toBe(3);
  });

  it("reads an unknown seat count as no seats", () => {
    expect(paidSeats([sub({ seats: null })], NOW, { plan: "personal", repoId: 1 })).toBe(0);
  });
});

describe("isWriteMessage", () => {
  const incident = { v: 1, kind: "incident", at: NOW, marker: "polar-unreachable" };

  it("accepts an incident with and without a detail, and with no owner_id", () => {
    expect(isWriteMessage(incident)).toBe(true);
    expect(isWriteMessage({ ...incident, detail: "checkout" })).toBe(true);
    expect(isWriteMessage({ ...incident, detail: "x".repeat(200) })).toBe(true);
    for (const marker of INCIDENT_MARKERS) expect(isWriteMessage({ ...incident, marker }), marker).toBe(true);
  });

  it("names the five markers the alerts count, the deploy's deploy-read-back and its two reconcile requests, and not queue-send-failed, which no queued message can carry", () => {
    expect([...INCIDENT_MARKERS]).toEqual(["d1-unreadable", "polar-unreachable", "app-not-installed", "polar-webhook-refused", "write-dead-lettered", "deploy-read-back", "reconcile-now", "polar-reconcile-now"]);
    expect(isWriteMessage({ ...incident, marker: "queue-send-failed" })).toBe(false);
  });

  it("refuses an incident with a marker outside the list, a 201-character detail, a detail that is not a string, or a fractional time", () => {
    expect(isWriteMessage({ ...incident, marker: "acme-marker" })).toBe(false);
    expect(isWriteMessage({ ...incident, detail: "x".repeat(201) })).toBe(false);
    expect(isWriteMessage({ ...incident, detail: 7 })).toBe(false);
    expect(isWriteMessage({ ...incident, at: NOW + 0.5 })).toBe(false);
  });

  it("refuses the retired seat messages: a usage, a grace-start and a grace-reset, and the retired secondary-rate-limit incident", () => {
    expect(isWriteMessage({ v: 1, kind: "usage", at: NOW, repo_id: 1001, user_id: 3003, owner_id: 2002, plan: "personal", day: "2026-09-21" })).toBe(false);
    expect(isWriteMessage({ v: 1, kind: "grace-start", at: NOW, owner_id: 2002 })).toBe(false);
    expect(isWriteMessage({ v: 1, kind: "grace-reset", at: NOW, owner_id: 2002 })).toBe(false);
    expect(isWriteMessage({ ...incident, marker: "secondary-rate-limit" })).toBe(false);
  });
});
