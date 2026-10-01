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
included. The nightly reconcile, `POST /v1/sync/reconcile` and `POST /v1/sync/polar-reconcile`
re-derive repos and subscriptions, and seats accumulate again from the next keys. Running one is a
person's call, never automatic:

```
gh workflow run d1-restore.yml -f bookmark=<bookmark from the deploy summary>
```

A bookmark is valid for 7 days on Workers Free, 30 on Workers Paid. `d1-restore.yml` runs the
command `tools/d1-restore-rehearsal.mjs` rehearses on a throwaway database (`RESTORE_COMMAND`, which
its test holds the workflow to); the deploy's dispatch input `rehearse_d1_restore` runs that
rehearsal.
