import { env, type D1Migration } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const migrations = (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;

// A rollback leaves the database as it is, so the version rolled back to must still read the schema:
// a migration may add, never drop or rename.
const DESTRUCTIVE = [/\bDROP\s+TABLE\b/i, /\bDROP\s+COLUMN\b/i, /\bALTER\s+TABLE\s+\S+\s+RENAME\b/i, /\bDROP\s+INDEX\b/i];

function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

function destructive(sql: string): string[] {
  const text = stripComments(sql);
  return DESTRUCTIVE.filter((re) => re.test(text)).map((re) => re.source);
}

describe("migrations stay additive", () => {
  it("reads every migration file", () => {
    expect(migrations.slice(0, 4).map((m) => m.name)).toEqual(["0001_init.sql", "0002_repos_identity_and_sync_state.sql", "0003_subscription_status.sql", "0004_incidents.sql"]);
    for (const m of migrations) expect(m.queries.length, m.name).toBeGreaterThan(0);
  });

  it("drops and renames nothing outside a comment", () => {
    expect(migrations.flatMap((m) => destructive(m.queries.join(";\n")).map((what) => `${m.name}: ${what}`))).toEqual([]);
  });

  it("would refuse each destructive statement, and passes one that is only a comment", () => {
    for (const sql of ["DROP TABLE seats", "ALTER TABLE repos DROP COLUMN visibility", "alter table repos rename to old_repos", "ALTER TABLE repos RENAME COLUMN visibility TO v", "DROP INDEX repos_installation"]) {
      expect(destructive(sql), sql).not.toEqual([]);
    }
    expect(destructive("-- DROP TABLE seats\nCREATE TABLE a (x INTEGER); /* DROP INDEX b */")).toEqual([]);
  });
});
