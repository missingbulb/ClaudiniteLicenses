import { describe, expect, it } from "vitest";
import { FEATURES } from "../../signing/src/index.ts";
import { dayOf, GRACE_S, headroom, licenseeOf, paidSeats, planFeatures, resolveSeats, SEAT_WINDOW_S, type SeatRow, type SubscriptionRow } from "../src/index.ts";

const DAY = 86400;
const NOW = 1_790_000_000;

/** `n` seated users, ranked by first key, all active within the window. */
const users = (n: number, from = 1): SeatRow[] => Array.from({ length: n }, (_, i) => ({ user_id: 100 + from + i, first_key_at: NOW - 20 * DAY + (from + i) * 60, last_key_at: NOW - DAY }));

const sub = (over: Partial<SubscriptionRow> = {}): SubscriptionRow => ({ plan: "personal", seats: 5, repo_ids: null, status: "active", ended_at: null, ...over });

const allButFleet = FEATURES.filter((f) => f !== "fleet");

describe("licenseeOf", () => {
  it("keys a Private repo seat by the repo and every other plan's by the owner", () => {
    expect(licenseeOf("private-repo", 2002, 1001)).toBe(1001);
    for (const plan of ["personal", "organization", "internal"] as const) expect(licenseeOf(plan, 2002, 1001)).toBe(2002);
  });
});

describe("headroom", () => {
  it("is 10% of the paid count, at least one, and none when nothing is paid", () => {
    expect([headroom(0), headroom(1), headroom(10), headroom(11), headroom(25)]).toEqual([0, 1, 1, 2, 3]);
  });
});

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

describe("resolveSeats, by the design's numbered rules", () => {
  const base = { plan: "personal" as const, paid: 5, overuse: null, now: NOW };

  it("1. within the paid count: four users and a fifth are ok", () => {
    const r = resolveSeats({ ...base, seatRows: users(4), userId: 999 });
    expect(r).toMatchObject({ state: "ok", counted: 5, headroom: 1, rank: 5, seated: true, notice: null, writes: [], graceUntil: null });
    expect(r.features).toEqual([...FEATURES]);
  });

  it("2. over the paid count, within headroom: the sixth user is ok and every user is told", () => {
    expect(resolveSeats({ ...base, seatRows: users(5), userId: 999 })).toMatchObject({ state: "ok", counted: 6, rank: 6, seated: false, notice: "over-within-headroom", writes: [] });
    expect(resolveSeats({ ...base, seatRows: users(6), userId: users(1)[0]!.user_id })).toMatchObject({ state: "ok", rank: 1, seated: true, notice: "over-within-headroom" });
  });

  it("3. over headroom: the seventh user with no overuse row starts grace", () => {
    const r = resolveSeats({ ...base, seatRows: users(6), userId: 999 });
    expect(r).toMatchObject({ state: "grace", counted: 7, graceUntil: NOW + GRACE_S, notice: "overused", writes: ["grace-start"] });
    expect(r.features).toEqual([...FEATURES]);
  });

  it("3. grace started 3 days ago: grace for everyone until start + 7 days, no write", () => {
    const start = NOW - 3 * DAY;
    for (const [rows, userId] of [[users(6), 999], [users(7), users(1)[0]!.user_id]] as const) {
      expect(resolveSeats({ ...base, seatRows: rows, userId, overuse: { grace_started_at: start, grace_spent_until: start + 30 * DAY } })).toMatchObject({
        state: "grace",
        graceUntil: start + GRACE_S,
        notice: "overused",
        writes: [],
      });
    }
  });

  it("4. after grace: users ranked 1 to 5 keep ok, 6 and 7 are degraded with no features", () => {
    const start = NOW - 8 * DAY;
    const overuse = { grace_started_at: start, grace_spent_until: start + 30 * DAY };
    const rows = users(7);
    rows.forEach((row, i) => {
      const r = resolveSeats({ ...base, seatRows: rows, userId: row.user_id, overuse });
      expect([r.rank, r.state, r.notice], String(i)).toEqual(i < 5 ? [i + 1, "ok", "overused"] : [i + 1, "degraded", "seat-refused"]);
      expect(r.features).toEqual(i < 5 ? [...FEATURES] : []);
    });
  });

  it("5. over again within 30 days of the last grace: degraded at once for the unseated, ok for the seated", () => {
    const overuse = { grace_started_at: null, grace_spent_until: NOW + 10 * DAY };
    const rows = users(7);
    expect(resolveSeats({ ...base, seatRows: rows, userId: rows[5]!.user_id, overuse })).toMatchObject({ state: "degraded", notice: "seat-refused", writes: [] });
    expect(resolveSeats({ ...base, seatRows: rows, userId: rows[2]!.user_id, overuse })).toMatchObject({ state: "ok", writes: [] });
  });

  it("5. a spent grace that has run out allows a new one", () => {
    const overuse = { grace_started_at: null, grace_spent_until: NOW - 1 };
    expect(resolveSeats({ ...base, seatRows: users(7), userId: 999, overuse })).toMatchObject({ state: "grace", writes: ["grace-start"], graceUntil: NOW + GRACE_S });
  });

  it("5. back within the count with a start set: ok and a grace-reset", () => {
    const overuse = { grace_started_at: NOW - 2 * DAY, grace_spent_until: NOW + 28 * DAY };
    expect(resolveSeats({ ...base, seatRows: users(3), userId: 999, overuse })).toMatchObject({ state: "ok", counted: 4, notice: null, writes: ["grace-reset"], graceUntil: null });
  });

  it("no subscription: one user starts grace with no headroom, and is degraded once grace ran out", () => {
    const free = { ...base, plan: "private-repo" as const, paid: 0 };
    const r = resolveSeats({ ...free, seatRows: [], userId: 999 });
    expect(r).toMatchObject({ state: "grace", counted: 1, headroom: 0, writes: ["grace-start"] });
    expect(r.features).toEqual(allButFleet);
    const after = resolveSeats({ ...free, seatRows: users(1), userId: users(1)[0]!.user_id, overuse: { grace_started_at: NOW - 8 * DAY, grace_spent_until: NOW + 22 * DAY } });
    expect(after).toMatchObject({ state: "degraded", rank: 1, seated: false, notice: "seat-refused" });
  });

  it("breaks a tie in first key time by user id", () => {
    const rows: SeatRow[] = [
      { user_id: 30, first_key_at: NOW - DAY, last_key_at: NOW },
      { user_id: 10, first_key_at: NOW - DAY, last_key_at: NOW },
      { user_id: 20, first_key_at: NOW - 2 * DAY, last_key_at: NOW },
    ];
    expect([20, 10, 30].map((userId) => resolveSeats({ ...base, seatRows: rows, userId }).rank)).toEqual([1, 2, 3]);
  });

  it("ranks a caller whose row lapsed 31 days ago as new, and leaves lapsed rows out of the count", () => {
    const rows: SeatRow[] = [...users(2), { user_id: 7, first_key_at: NOW - 60 * DAY, last_key_at: NOW - 31 * DAY }];
    expect(resolveSeats({ ...base, seatRows: rows, userId: 7 })).toMatchObject({ counted: 3, rank: 3 });
    expect(resolveSeats({ ...base, seatRows: [{ user_id: 7, first_key_at: NOW - 60 * DAY, last_key_at: NOW - SEAT_WINDOW_S }], userId: 7 })).toMatchObject({ counted: 1, rank: 1 });
  });

  it("with no caller, as for an Actions key, counts only the rows and reads the licensee's state", () => {
    expect(resolveSeats({ ...base, seatRows: users(5), userId: null })).toMatchObject({ state: "ok", counted: 5, rank: null, notice: null });
    expect(resolveSeats({ ...base, seatRows: users(7), userId: null, overuse: { grace_started_at: NOW - DAY, grace_spent_until: NOW + 29 * DAY } })).toMatchObject({ state: "grace", notice: "overused" });
    expect(resolveSeats({ ...base, seatRows: users(7), userId: null, overuse: { grace_started_at: NOW - 8 * DAY, grace_spent_until: NOW + 22 * DAY } })).toMatchObject({ state: "degraded", features: [] });
  });
});

describe("dayOf", () => {
  it("is the UTC date of a unix time", () => {
    expect(dayOf(Date.parse("2026-10-01T23:59:59Z") / 1000)).toBe("2026-10-01");
    expect(dayOf(Date.parse("2026-10-02T00:00:00Z") / 1000)).toBe("2026-10-02");
  });
});
