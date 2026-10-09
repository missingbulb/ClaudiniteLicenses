import { describe, expect, it } from "vitest";
import { FEATURES } from "../../signing/src/index.ts";
import { checkoutPlanFor, fleetPlan, INTERNAL_OWNERS, INCIDENT_MARKERS, isWriteMessage, planFeatures, type SubscriptionRow } from "../src/index.ts";

const DAY = 86400;
const NOW = 1_790_000_000;

const sub = (over: Partial<SubscriptionRow> = {}): SubscriptionRow => ({ plan: "personal", status: "active", ended_at: null, ...over });

const allButFleet = FEATURES.filter((f) => f !== "fleet");

const USER = 2002;
const ORG = 8008;

describe("planFeatures", () => {
  it("gives Public every feature but fleet, and the fleet plans every feature", () => {
    expect(planFeatures("public")).toEqual(allButFleet);
    for (const plan of ["personal", "organization", "internal"] as const) expect(planFeatures(plan)).toEqual([...FEATURES]);
  });
});

describe("fleetPlan", () => {
  it("gives a User owner Personal and an Organization owner Organization, never the other way round", () => {
    expect(fleetPlan(USER, "User", [sub({ plan: "personal" })])).toBe("personal");
    expect(fleetPlan(ORG, "Organization", [sub({ plan: "organization" })])).toBe("organization");
    expect(fleetPlan(ORG, "Organization", [sub({ plan: "personal" })])).toBeNull();
    expect(fleetPlan(USER, "User", [sub({ plan: "organization" })])).toBeNull();
  });

  it("checks Internal first, for either owner type", () => {
    for (const type of ["User", "Organization"] as const) {
      expect(fleetPlan(ORG, type, [sub({ plan: "personal" }), sub({ plan: "organization" }), sub({ plan: "internal" })]), type).toBe("internal");
    }
  });

  it("counts an active, trialing or past_due row that has not ended, and ignores a revoked, an incomplete or an ended one", () => {
    for (const status of ["active", "trialing", "past_due"]) expect(fleetPlan(USER, "User", [sub({ status })]), status).toBe("personal");
    for (const row of [sub({ status: "canceled", ended_at: NOW - DAY }), sub({ status: "incomplete" }), sub({ status: "active", ended_at: NOW - DAY }), sub({ status: null }), sub({ status: "canceled" })]) {
      expect(fleetPlan(USER, "User", [row]), JSON.stringify(row)).toBeNull();
    }
  });

  it("does not read seats: an Organization row with no seat count, or none left, still pays for the fleet", () => {
    expect(fleetPlan(ORG, "Organization", [{ ...sub({ plan: "organization" }), seats: 0 } as SubscriptionRow])).toBe("organization");
    expect(fleetPlan(ORG, "Organization", [{ ...sub({ plan: "organization" }), seats: null } as SubscriptionRow])).toBe("organization");
  });

  it("gives an owner Claudinite grants by id Internal with no row at all, of either type, and no other owner", () => {
    expect(INTERNAL_OWNERS.get(73882448)).toBe("missingbulb");
    for (const [id] of INTERNAL_OWNERS) {
      expect(fleetPlan(id, "User", [])).toBe("internal");
      expect(fleetPlan(id, "Organization", [sub({ status: "canceled", ended_at: NOW - DAY })])).toBe("internal");
    }
    expect(fleetPlan(USER, "User", [])).toBeNull();
  });

  it("answers null with no rows, and for a row naming a retired or unknown plan", () => {
    expect(fleetPlan(USER, "User", [])).toBeNull();
    expect(fleetPlan(USER, "User", [sub({ plan: "private-repo" })])).toBeNull();
  });
});

describe("checkoutPlanFor", () => {
  it("offers a User the Personal fleet and an Organization the Organization fleet", () => {
    expect(checkoutPlanFor("User")).toBe("personal");
    expect(checkoutPlanFor("Organization")).toBe("organization");
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
