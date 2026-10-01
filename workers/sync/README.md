# workers/sync

The only writer of D1. It holds no signing key, so it can never issue one.

The router forwards the Claudinite App's `installation`, `installation_repositories` and
`repository` webhooks to `POST /webhook`, which keeps `repos` current:

| Event · action | Write |
| --- | --- |
| `installation` · `created`, `unsuspend`, `new_permissions_accepted` | upsert each listed repo, owner from `installation.account` |
| `installation` · `deleted`, `suspend` | delete that installation's rows |
| `installation_repositories` · `added` / `removed` | upsert the added repos / delete the removed ones |
| `repository` · `publicized`, `privatized` | set `visibility` |
| `repository` · `renamed`, `transferred` | set the owner and `full_name` |
| `repository` · `edited` with a default branch change | set `default_branch` |
| `repository` · `deleted` | delete the row |
| anything else | 204, no write |

Visibility is `private` when the payload says `private`, `internal` only when it says so, else
`public`. Every upsert reads the repo's default branch with an installation token holding
`metadata: read` on exactly those repos, so a row is complete before its first key. When that read
fails the row is still written, its default branch left as it was (null for a new row), and the
answer is 202 so GitHub redelivers. A write that completes answers 200 and stamps
`sync_state.last_webhook_at`. Writes are last-write-wins; the reconcile repairs any order a burst
of webhooks got wrong.

The reconcile lists every installation of the App with the App JWT and every repo each covers with
a `metadata: read` installation token, upserts each row that differs, deletes each row no
installation lists, and stamps `last_reconcile_at` and `last_reconcile_corrections` (the number of
rows it wrote or deleted). It writes nothing unless every listing was read. It runs on the cron
`17 3 * * *` and on `POST /v1/sync/reconcile` with `Authorization: Bearer $SYNC_ADMIN_TOKEN`, which
answers `{ ok, repos, corrections }`, or 502 when GitHub fails.

`GET /v1/sync/health` answers `{ ok, repos, last_webhook_at, last_reconcile_at,
last_reconcile_corrections }`, null where a stamp was never written.

## Secrets

Each repository secret `deploy.yml` reads, and the Worker secret it is stored as:

- `CLAUDINITE_GITHUB_APP_ID`, as `GITHUB_APP_ID`
- `CLAUDINITE_GITHUB_APP_PRIVATE_KEY`, as `GITHUB_APP_PRIVATE_KEY`

`SYNC_ADMIN_TOKEN` is no repository secret: `deploy.yml` generates a fresh one on every run, stores
it with the others and uses it once to run the reconcile in its read-back, so nobody holds a copy
and the next deploy rotates it.
