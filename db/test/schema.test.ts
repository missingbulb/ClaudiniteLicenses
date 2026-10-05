import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const e = env as unknown as { DB: D1Database; TEST_MIGRATIONS: D1Migration[] };

const NAMES = ["0001_init.sql", "0002_repos_identity_and_sync_state.sql", "0003_subscription_status.sql", "0004_incidents.sql", "0005_fleets_only.sql"];
const columns = async (table: string) => (await e.DB.prepare(`PRAGMA table_info('${table}')`).all<{ name: string }>()).results.map((c) => c.name);

describe("migrations", () => {
  beforeEach(async () => {
    await applyD1Migrations(e.DB, e.TEST_MIGRATIONS);
  });

  it("creates the subscriptions, repos and signing keys, the sync stamps and the incidents, and no seat, overuse or usage table", async () => {
    const { results } = await e.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'd1_%' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(["incidents", "repos", "signing_keys", "subscriptions", "sync_state"]);
  });

  it("applies once: a second apply is a no-op recorded by the migrations table", async () => {
    await applyD1Migrations(e.DB, e.TEST_MIGRATIONS);
    const { results } = await e.DB.prepare("SELECT name FROM d1_migrations").all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(NAMES);
  });

  it("keeps subscriptions without repo_ids, and repos without private_repo_licensed", async () => {
    expect(await columns("subscriptions")).toEqual(["polar_subscription_id", "owner_id", "owner_type", "plan", "seats", "source", "period_end", "cancel_at_period_end", "modified_at", "raw", "status", "ended_at", "product_id", "interval"]);
    expect(await columns("repos")).not.toContain("private_repo_licensed");
    expect(await columns("repos")).toEqual(["repo_id", "owner_id", "visibility", "installation_id", "updated_at", "full_name", "owner_type", "owner_login", "default_branch"]);
  });

  it("indexes subscriptions by owner", async () => {
    const { results } = await e.DB.prepare("PRAGMA index_info('subscriptions_owner')").all<{ name: string }>();
    expect(results.map((c) => c.name)).toEqual(["owner_id"]);
  });

  it("keeps an unknown period_end null, never 0", async () => {
    await e.DB.prepare(
      "INSERT INTO subscriptions (polar_subscription_id, owner_id, owner_type, plan, seats, source, period_end, cancel_at_period_end, modified_at, raw) VALUES ('sub_acme', 2, 'Organization', 'organization', 5, 'polar', NULL, NULL, 100, '{}')",
    ).run();
    const row = await e.DB.prepare("SELECT period_end, cancel_at_period_end FROM subscriptions WHERE polar_subscription_id = 'sub_acme'").first();
    expect(row).toEqual({ period_end: null, cancel_at_period_end: null });
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

  it("allows only the fleets and internal as a subscription's plan", async () => {
    for (const plan of ["personal", "organization", "internal"]) await subscription(`sub_${plan}`, { plan }).run();
    for (const plan of ["private-repo", "public", "enterprise"]) await expect(subscription(`sub_${plan}`, { plan }).run(), plan).rejects.toThrow(/CHECK/);
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

describe("0005, from the schema 0004 left", () => {
  it("copies every subscription but Private repo's, each column intact, and keeps the repos", async () => {
    // The file's tests share one database: start this one from empty.
    const { results: tables } = await e.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all<{ name: string }>();
    for (const t of tables) await e.DB.prepare(`DROP TABLE "${t.name}"`).run();
    await applyD1Migrations(e.DB, e.TEST_MIGRATIONS.slice(0, 4));
    const insert = (id: string, plan: string, repoIds: string | null) =>
      e.DB.prepare(
        "INSERT INTO subscriptions (polar_subscription_id, owner_id, owner_type, plan, seats, repo_ids, source, period_end, cancel_at_period_end, modified_at, raw, status, ended_at, product_id, interval) VALUES (?, 2, 'User', ?, 3, ?, 'polar', 500, 0, 100, '{\"id\":1}', 'active', NULL, 'prod_acme', 'year')",
      )
        .bind(id, plan, repoIds)
        .run();
    await insert("sub_personal", "personal", null);
    await insert("sub_private", "private-repo", "[1001]");
    await insert("sub_internal", "internal", null);
    await e.DB.prepare("INSERT INTO repos (repo_id, owner_id, visibility, private_repo_licensed, installation_id, updated_at, full_name, owner_type, owner_login, default_branch) VALUES (1001, 2, 'private', 1, 5, 100, 'acme-user/acme-repo', 'User', 'acme-user', 'main')").run();
    await e.DB.prepare("INSERT INTO seats (licensee_id, user_id, first_key_at, last_key_at) VALUES (1, 2, 100, 100)").run();
    await applyD1Migrations(e.DB, e.TEST_MIGRATIONS);
    const { results } = await e.DB.prepare("SELECT * FROM subscriptions ORDER BY polar_subscription_id").all();
    const row = (id: string, plan: string) => ({ polar_subscription_id: id, owner_id: 2, owner_type: "User", plan, seats: 3, source: "polar", period_end: 500, cancel_at_period_end: 0, modified_at: 100, raw: '{"id":1}', status: "active", ended_at: null, product_id: "prod_acme", interval: "year" });
    expect(results).toEqual([row("sub_internal", "internal"), row("sub_personal", "personal")]);
    expect(await e.DB.prepare("SELECT * FROM repos").all().then((r) => r.results)).toEqual([
      { repo_id: 1001, owner_id: 2, visibility: "private", installation_id: 5, updated_at: 100, full_name: "acme-user/acme-repo", owner_type: "User", owner_login: "acme-user", default_branch: "main" },
    ]);
  });
});
