import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const e = env as unknown as { DB: D1Database; TEST_MIGRATIONS: D1Migration[] };

beforeEach(async () => {
  await applyD1Migrations(e.DB, e.TEST_MIGRATIONS);
});

describe("migrations", () => {
  it("creates the six tables of What it keeps, the sync stamps and the incidents", async () => {
    const { results } = await e.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'd1_%' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(["incidents", "overuse", "repos", "seats", "signing_keys", "subscriptions", "sync_state", "usage"]);
  });

  it("applies once: a second apply is a no-op recorded by the migrations table", async () => {
    await applyD1Migrations(e.DB, e.TEST_MIGRATIONS);
    const { results } = await e.DB.prepare("SELECT name FROM d1_migrations").all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(["0001_init.sql", "0002_repos_identity_and_sync_state.sql", "0003_subscription_status.sql", "0004_incidents.sql"]);
  });

  it("holds one seat per licensee and user", async () => {
    const insert = () => e.DB.prepare("INSERT INTO seats (licensee_id, user_id, first_key_at, last_key_at) VALUES (1, 2, 100, 100)").run();
    await insert();
    await expect(insert()).rejects.toThrow(/UNIQUE|PRIMARY KEY/);
    await e.DB.prepare("INSERT INTO seats (licensee_id, user_id, first_key_at, last_key_at) VALUES (1, 3, 100, 100)").run();
  });

  it("keys usage by repo, user and day together", async () => {
    const insert = (repo: number, user: number, day: string) => e.DB.prepare("INSERT INTO usage (repo_id, user_id, day) VALUES (?, ?, ?)").bind(repo, user, day).run();
    await insert(1, 2, "2026-10-01");
    await insert(1, 2, "2026-10-02");
    await insert(1, 3, "2026-10-01");
    await insert(4, 2, "2026-10-01");
    await expect(insert(1, 2, "2026-10-01")).rejects.toThrow(/UNIQUE|PRIMARY KEY/);
  });

  it("keeps an unknown period_end null, never 0", async () => {
    await e.DB.prepare(
      "INSERT INTO subscriptions (polar_subscription_id, owner_id, owner_type, plan, seats, repo_ids, source, period_end, cancel_at_period_end, modified_at, raw) VALUES ('sub_acme', 2, 'Organization', 'organization', 5, NULL, 'polar', NULL, NULL, 100, '{}')",
    ).run();
    const row = await e.DB.prepare("SELECT period_end, cancel_at_period_end, repo_ids FROM subscriptions WHERE polar_subscription_id = 'sub_acme'").first();
    expect(row).toEqual({ period_end: null, cancel_at_period_end: null, repo_ids: null });
  });

  it("reads back an unset default_branch, owner_type, owner_login and full_name as null", async () => {
    await e.DB.prepare("INSERT INTO repos (repo_id, owner_id, visibility, installation_id, updated_at) VALUES (1, 2, 'public', 5, 100)").run();
    const row = await e.DB.prepare("SELECT full_name, owner_type, owner_login, default_branch FROM repos WHERE repo_id = 1").first();
    expect(row).toEqual({ full_name: null, owner_type: null, owner_login: null, default_branch: null });
  });

  it("allows only User or Organization as a repo's owner_type", async () => {
    const insert = (type: string) => e.DB.prepare("INSERT INTO repos (repo_id, owner_id, owner_type, updated_at) VALUES (?, 2, ?, 100)").bind(type === "User" ? 11 : 12, type).run();
    await insert("User");
    await expect(insert("Bot")).rejects.toThrow(/CHECK/);
  });

  it("holds one sync_state row per name", async () => {
    const stamp = (at: number) => e.DB.prepare("INSERT INTO sync_state (name, at, detail) VALUES ('last_reconcile_at', ?, NULL) ON CONFLICT (name) DO UPDATE SET at = excluded.at").bind(at).run();
    await stamp(100);
    await stamp(200);
    const { results } = await e.DB.prepare("SELECT name, at, detail FROM sync_state").all();
    expect(results).toEqual([{ name: "last_reconcile_at", at: 200, detail: null }]);
    await expect(e.DB.prepare("INSERT INTO sync_state (name, at) VALUES ('last_reconcile_at', 300)").run()).rejects.toThrow(/UNIQUE|PRIMARY KEY/);
  });

  const subscription = (id: string, over: Record<string, unknown> = {}) => {
    const r: Record<string, unknown> = { polar_subscription_id: id, owner_id: 2, owner_type: "User", plan: "personal", seats: 5, source: "polar", modified_at: 100, raw: "{}", ...over };
    const cols = Object.keys(r);
    return e.DB.prepare(`INSERT INTO subscriptions (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).bind(...cols.map((c) => r[c]));
  };

  it("adds status, ended_at, product_id and interval to subscriptions, an unended one reading back null", async () => {
    await subscription("sub_running", { status: "active", product_id: "prod_acme", interval: "month" }).run();
    const row = await e.DB.prepare("SELECT status, ended_at, product_id, interval FROM subscriptions WHERE polar_subscription_id = 'sub_running'").first();
    expect(row).toEqual({ status: "active", ended_at: null, product_id: "prod_acme", interval: "month" });
    await subscription("sub_ended", { status: "canceled", ended_at: 200, interval: "year" }).run();
    expect(await e.DB.prepare("SELECT ended_at FROM subscriptions WHERE polar_subscription_id = 'sub_ended'").first()).toEqual({ ended_at: 200 });
  });

  it("allows only month or year as a subscription's interval", async () => {
    await expect(subscription("sub_weekly", { interval: "week" }).run()).rejects.toThrow(/CHECK/);
  });

  it("keeps one incidents row per occurrence, a missing detail reading back null, indexed by marker and time", async () => {
    await e.DB.prepare("INSERT INTO incidents (marker, at, detail) VALUES ('polar-unreachable', 100, 'checkout')").run();
    await e.DB.prepare("INSERT INTO incidents (marker, at) VALUES ('polar-unreachable', 100)").run();
    const { results } = await e.DB.prepare("SELECT id, marker, at, detail FROM incidents ORDER BY id").all();
    expect(results).toEqual([
      { id: 1, marker: "polar-unreachable", at: 100, detail: "checkout" },
      { id: 2, marker: "polar-unreachable", at: 100, detail: null },
    ]);
    await expect(e.DB.prepare("INSERT INTO incidents (at) VALUES (100)").run()).rejects.toThrow(/NOT NULL/);
    const { results: indexes } = await e.DB.prepare("PRAGMA index_list('incidents')").all<{ name: string }>();
    const named = indexes.find((i) => i.name === "incidents_marker_at");
    expect(named).toBeDefined();
    const { results: cols } = await e.DB.prepare("PRAGMA index_info('incidents_marker_at')").all<{ name: string }>();
    expect(cols.map((c) => c.name)).toEqual(["marker", "at"]);
  });
});
