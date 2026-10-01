# workers/sync

The only writer of D1. It holds no signing key, so it can never issue one. It writes `repos` from
the Claudinite App's webhooks and the GitHub reconcile, `subscriptions` from Polar's webhooks and
the Polar reconcile, and `seats`, `usage` and `overuse` from the writes queue the key Worker fills.

## Repos

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
answer is 202. GitHub redelivers nothing on its own, whatever the answer: the 202 marks the
delivery in the App's log, and the next reconcile fills the branch. A write that completes answers 200 and stamps
`sync_state.last_webhook_at`. Writes are last-write-wins; the reconcile repairs any order a burst
of webhooks got wrong.

The reconcile lists every installation of the App with the App JWT and every repo each covers with
a `metadata: read` installation token, skipping a suspended installation (it would refuse the
token) so its rows are deleted, upserts each row that differs, deletes each row no
installation lists, and stamps `last_reconcile_at` and `last_reconcile_corrections` (the number of
rows it wrote or deleted). It writes nothing unless every listing was read. It runs on the cron
`17 3 * * *` and on `POST /v1/sync/reconcile` with `Authorization: Bearer $SYNC_ADMIN_TOKEN`, which
answers `{ ok, repos, corrections }`, or 502 when GitHub fails.

## Subscriptions, from Polar

`POST /v1/sync/polar-webhook` is public: Polar calls it. Each delivery is checked as Standard
Webhooks with `POLAR_WEBHOOK_SECRET` (`packages/polar`'s `verifyWebhook`); a failure answers 401
with the reason (`signature-missing`, `timestamp-skew`, `signature-mismatch`, `payload-malformed`,
or `secret-unset`), writes nothing, stamps nothing and logs `{ "marker": "polar-webhook-refused" }`,
so a secret that stops matching shows as a stale `last_polar_webhook_at`. A verified delivery
stamps `last_polar_webhook_at`; then `subscription.created`, `.updated`, `.active`, `.canceled`,
`.uncanceled`, `.revoked` and `.past_due` upsert the subscription, and every other event,
`checkout.created` included, answers 204 with no write.

| Column | From Polar's subscription |
| --- | --- |
| `polar_subscription_id` | `id` |
| `owner_id` | `customer.external_id`, a numeric GitHub id; without one the subscription is skipped and logged `polar-no-external-id` |
| `owner_type` | `metadata.github_owner_type`; without `User` or `Organization`, skipped (`polar-no-owner-type`) |
| `plan` | the product's `claudinite_plan`; a product whose `managed_by` is not ours is skipped (`polar-not-managed`) |
| `seats` | `seats` |
| `repo_ids` | `[metadata.github_repo_id]` under `private-repo`, else null |
| `source` | `polar` |
| `period_end` | `current_period_end` |
| `cancel_at_period_end` | `cancel_at_period_end`, 1 or 0 |
| `modified_at` | `modified_at`, else `created_at` |
| `status`, `ended_at`, `product_id` | the same names |
| `interval` | the product's `claudinite_interval` |
| `raw` | the object as JSON |

Times are unix seconds. A webhook's write is skipped when the stored row has a later `modified_at`,
so a duplicate, retried or reordered delivery never leaves a wrong row.

The Polar reconcile lists every subscription, ended ones included, and upserts each that is missing
or differs from Polar in any column but `raw`, whatever the stored `modified_at`; it deletes
nothing. It stamps `last_polar_reconcile_at` and `last_polar_reconcile_corrections` (the rows it
wrote) and clears `last_polar_reconcile_error`; a failure stamps `last_polar_reconcile_error` with
Polar's status and writes nothing else. The cron `17 3 * * *` runs it after the GitHub reconcile;
`47 * * * *` runs it only when the last attempt failed or the last success is a day old. `POST
/v1/sync/polar-reconcile` with the admin bearer runs it at once, answering `{ ok, subscriptions,
corrections }`, or 502 when Polar fails.

## The writes queue

The Worker consumes `claudinite-licenses-writes` (batches of up to 100, 5 seconds, 5 retries) and
its dead-letter queue `claudinite-licenses-writes-dlq`. Each batch is one D1 batch of statements in
message order, acked on success and retried whole when D1 throws:

| `kind` | Write |
| --- | --- |
| `usage` | the `usage` row for `(repo_id, user_id, day)` if missing; the seat of `(licenseeOf(plan, owner_id, repo_id), user_id)`: inserted at `at`, else `last_key_at` raised to `at`, and `first_key_at` reset to `at` when the old `last_key_at` is more than 30 days before it |
| `grace-start` | the owner's `overuse` row: `grace_started_at` kept if set, else `at`; `grace_spent_until` raised to `at` + 30 days |
| `grace-reset` | `grace_started_at` cleared, `grace_spent_until` kept |

Every statement is idempotent. A message this version cannot read is acked and logged
`{ "marker": "write-malformed" }`. Each batch stamps `last_queue_at` and `queue_lag_s`, the age of
its oldest message. A dead-letter batch writes nothing: each message is logged
`{ "marker": "write-dead-lettered", kind, at }` and `last_dead_letter_at` is stamped.

## Health

`GET /v1/sync/health` answers `{ ok, repos, subscriptions, seats, last_webhook_at,
last_reconcile_at, last_reconcile_corrections, last_polar_webhook_at, last_polar_reconcile_at,
last_polar_reconcile_corrections, last_polar_reconcile_error, last_queue_at, queue_lag_s,
last_dead_letter_at, polar_webhook_secret }`. `seats` counts rows whose last key is within 30
days; each stamp is null where it was never written; `polar_webhook_secret` says whether the secret
is set, never its value, and is what `deploy.yml` reads to decide whether to make a new endpoint.

## Secrets

Each repository secret `deploy.yml` reads, and the Worker secret it is stored as:

- `CLAUDINITE_GITHUB_APP_ID`, as `GITHUB_APP_ID`
- `CLAUDINITE_GITHUB_APP_PRIVATE_KEY`, as `GITHUB_APP_PRIVATE_KEY`
- `POLAR_SANDBOX_TOKEN`, as `POLAR_ACCESS_TOKEN` (the sandbox organization's token, until the commercial track flips both Workers to production)

The var `POLAR_API_BASE` is `https://sandbox-api.polar.sh`.

`POLAR_WEBHOOK_SECRET` is no repository secret either: Polar returns an endpoint's secret only when
it creates the endpoint, and the job's token cannot write repository secrets. `deploy.yml` runs
`tools/ensure-polar-webhook.mjs`, which keeps the existing endpoint, or, when the live Worker's
health reports no secret or the dispatch input `rotate_polar_webhook` is on, makes a new one and
writes its secret to a file the Worker's secrets step stores.

`SYNC_ADMIN_TOKEN` is no repository secret: `deploy.yml` generates a fresh one on every run, stores
it with the others and uses it once to run the reconcile in its read-back, so nobody holds a copy
and the next deploy rotates it.
