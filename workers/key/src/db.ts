// The key Worker's one way to read D1: a session per request, opened "first-unconstrained", so the
// request's first read may be served by the nearest read replica and every later read in it by an
// instance at least as fresh. Cloudflare's D1 read replication page
// (developers.cloudflare.com/d1/best-practices/read-replication/, read 2026-10-02): without the
// Sessions API every query goes to the primary; with replication off, D1 routes every query to the
// primary, and the Sessions API works on such a database, so a session there reads as a plain
// binding does. The key Worker writes nothing to D1 and reads nothing it wrote, so it needs no
// bookmark and no "first-primary". `D1Database.withSession` is in @cloudflare/workers-types as
// pinned, so the binding needs no local declaration.
import type { Env } from "./env.ts";

/** What a read needs of D1: a session and the binding both satisfy it. */
export type D1Reads = Pick<D1Database, "prepare" | "batch">;

/** One unconstrained session; call it once per request and pass the result down. */
export function reader(env: Pick<Env, "DB">): D1Reads {
  return env.DB.withSession("first-unconstrained");
}
