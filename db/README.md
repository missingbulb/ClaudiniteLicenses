# db

The D1 schema: `migrations/`, applied by `deploy.yml` with `wrangler d1 migrations apply --remote`
against `wrangler.jsonc`, which no Worker deploys from.

Migrations are additive: a rollback leaves the database as it is, so every version in the rollback
window must read the live schema, and `test/migrations-additive.test.ts` refuses a `DROP TABLE`,
`DROP COLUMN`, `DROP INDEX` or `ALTER TABLE … RENAME` outside a comment. A column that must go is
removed in a later chunk, once a deploy whose code no longer reads it has been promoted and the
convergence window that chunk states has passed.

## Restoring

Each deploy records D1 Time Travel's bookmark before its migrations and prints, in its summary, the
dispatch that returns the database there. A restore is in place and destructive: queries in flight
are cancelled, and every row written after the bookmark is gone, usage, seats and subscriptions
included. The nightly reconciles, or a `reconcile-now` and a `polar-reconcile-now` pushed onto the writes
queue with `tools/push-queue-message.mjs`, re-derive repos and subscriptions, and seats accumulate again from the next keys. Running one is a
person's call, never automatic:

```
gh workflow run d1-restore.yml -f bookmark=<bookmark from the deploy summary>
```

A bookmark is valid for 7 days on Workers Free, 30 on Workers Paid. `d1-restore.yml` runs the
command `tools/d1-restore-rehearsal.mjs` rehearses on a throwaway database (`RESTORE_COMMAND`, which
its test holds the workflow to); the deploy's dispatch input `rehearse_d1_restore` runs that
rehearsal.

## Read replication

The key Worker reads through one D1 session per request, opened `first-unconstrained`
(`workers/key/src/db.ts`). So once replication is on, a request's first read may be served by the
nearest replica, and every later read in that request comes from an instance at least as fresh.
The sync Worker opens no session, so every read it makes goes to the primary and sees its own
writes. A replica a little behind the primary can lead the key Worker to queue a `usage` or
`grace-start` message the primary already holds. Every seat statement is idempotent, so that costs
one extra message, never a wrong row.

While replication is off, the session behaves exactly as a plain binding does, because D1 routes
every query to the primary. The deploy reads the mode on every run and changes it only when the
repository variable `D1_READ_REPLICATION` is `auto`. That variable stays unset until a deploy
dispatched with `rehearse_d1_restore` has run Time Travel's restore on a replicated throwaway
database: the rehearsal turns replication on for that database before migrating it. Cloudflare's
Time Travel page says nothing on restoring a replicated database, so the rehearsal is the proof.
That dispatch waits on the owner's approval. Once it passes:

```
gh variable set D1_READ_REPLICATION --body auto
gh workflow run deploy.yml
```

From then on every deploy turns the mode back to `auto` if something else turned it off, and the
read-back fails unless the mode is `auto`. Until then, the deploy and its read-back only warn when
the mode is missing or unknown. `node tools/ensure-d1.mjs --name claudinite-licenses
--show-read-replication` prints the mode, or `no database named …`. It looks the database up and
never creates it.
