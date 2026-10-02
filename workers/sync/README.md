# workers/sync

The only writer of D1. It holds no signing key, so it can never issue one. It writes `repos` from
the Claudinite App's webhooks and the GitHub reconcile, `subscriptions` from Polar's webhooks and
the Polar reconcile, and `seats`, `usage`, `overuse` and `incidents` from the writes queue the key
Worker fills. It audits whether the App still covers every paying account and judges every alert at
`GET /v1/sync/alerts`.

It deploys at 100% with `wrangler deploy --secrets-file`, never through the split the
request-path Workers take: which version a split hands a cron or a queue consumer is not
documented, and its deploy never touches key issuance. Its secrets travel with the version that
deploy makes, so the version a rollback returns to holds the secrets it ran with. Its judge right
after reads its health, pushes one `deploy-read-back` message onto the writes queue through the
Queues REST API (`tools/push-queue-message.mjs`) and requires the consumer's stamps to show a
batch landed on the version just deployed after the push (`last_queue_at` at or after the push,
`last_queue_version` the deployed id, `queue_lag_s` at most 900, the `queue-lagging` alert's bound,
so a backlog still draining is not a rollback). For a while after `wrangler deploy` the previous
version can still be the one consuming, so a batch that lands after the push on another version is
answered with another push, up to four in all. It then reads its alerts; any failure
rolls it back to the version that was live. That proves the queue bound to the deployed version,
the consumer running on it and one D1 write through it.

Each consumed batch stamps `last_queue_version` and each cron `last_cron_version`, both from the
`version_metadata` binding `CF_VERSION_METADATA`, as every answer's `X-Claudinite-Version` and the
health body's `version` are. Each `scheduled` and `queue` invocation also logs
`{ invocation, version }` at its start. So the question of which version a split hands a cron or a
queue consumer is now one health field away, but it stays open: it can only be read from a split of
this Worker, and until one is tried the sync Worker stays at 100%.

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
or `secret-unset`). A refused delivery first spends one request of the caller's `IP_LIMIT`, and
over it answers 429 `rate-limited` with `Retry-After: 60` and writes nothing; a verified delivery never meets the cap. A
body past 1 MiB is refused 413 `payload-too-large` before the signature is checked. Otherwise a
refusal writes nothing but a `polar-webhook-refused` incident naming the reason (at
most a hundred an hour, since anyone can post here), stamps nothing and logs
`{ "marker": "polar-webhook-refused" }`, so a secret that stops matching shows as a stale
`last_polar_webhook_at` and, repeated, as an alert. A verified delivery
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
| `grace-reset` | `grace_started_at` cleared when it is no later than the message's `at`, `grace_spent_until` kept: delivery order is best-effort, so a reset delivered after a later `grace-start` leaves that start alone |
| `incident` | an `incidents` row of `marker`, `at` and `detail`; `deploy-read-back` is the one the deploy's judge pushes, written and pruned like the rest and counted by no alert |

Every seat statement is idempotent; a redelivered incident is one more row, which only errs toward
an alert. A message this version cannot read is acked and logged `{ "marker": "write-malformed" }`.
Each batch stamps `last_queue_at`, `last_queue_version`, the version that consumed it, and
`queue_lag_s`, the age of its oldest message, in the same D1 batch as its writes, so the stamps move
only when the writes land. A dead-letter batch writes no seat: each message is logged
`{ "marker": "write-dead-lettered", kind, at }` and written as a `write-dead-lettered` incident
naming its kind, and `last_dead_letter_at` and `last_queue_version` are stamped, in one D1 batch.

Every cron, the hourly one included, first stamps `last_cron_at` (its detail the cron expression
that ran) and `last_cron_version` in one batch, before its work and whether or not the Polar
reconcile is due, so a cron that stops running shows as a stale stamp rather than silence.

The nightly cron deletes incidents older than 7 days, since no alert window is longer than a day
and the record's job is the alert, not history.

## Coverage

The coverage audit lists the paying subscription rows (`status` `active`, `trialing` or
`past_due`, `ended_at` null) and checks what the App must cover: under `private-repo` every repo in
`repo_ids` needs a `repos` row; under `personal`, `organization` and `internal` the owner needs at
least one. It stamps `sync_state.paying_uncovered` with the number of uncovered accounts (an owner
under a plan) and logs one line per account, `{ "marker": "paying-uncovered", owner_id, plan,
repo_ids }`, the missing repos under `private-repo`. The ids stay in the log, never in a public
body. It runs at the end of the nightly cron after both reconciles, and at the end of each
reconcile route, so a deploy's read-back re-judges it.

## Alerts

`GET /v1/sync/alerts` reads the stamps and, per marker, the incidents inside its window, and
answers `{ ok: true, checked_at, alerts: [] }` with 200, or `{ ok: false, checked_at, alerts }`
with 503, each alert `{ id, since, detail }`. A D1 read that throws answers 503 with the single
alert `sync-d1-unreadable`.

| Alert | Fires while |
| --- | --- |
| `polar-reconcile-stale` | `last_polar_reconcile_at` older than 26 h, or null and the Worker has run a day (`last_queue_at` or `last_webhook_at` older than 24 h) |
| `polar-reconcile-failing` | `last_polar_reconcile_error` set |
| `polar-reconcile-corrected` | `last_polar_reconcile_corrections > 0` on the latest reconcile (a webhook was lost; clears at the next clean reconcile) |
| `github-reconcile-stale` | `last_reconcile_at` older than 26 h |
| `polar-webhooks-refused` | 3 or more `polar-webhook-refused` in the last hour |
| `queue-lagging` | `queue_lag_s > 900` on a `last_queue_at` within 24 h |
| `writes-dead-lettered` | `last_dead_letter_at` within 24 h |
| `d1-unreadable` | 1 or more in the last hour |
| `polar-unreachable` | 3 or more in the last hour |
| `app-not-installed` | 5 or more in the last hour |
| `secondary-rate-limit` | 1 or more in the last hour |
| `paying-uncovered` | `paying_uncovered > 0` |

Every alert clears on its own as its window passes or its stamp moves; none needs an
acknowledgement, so a status-only monitor can poll the route and a stale alert never pins it red.
`queue_lag_s` is a reading taken at the last consumed batch, so its alert is bounded to a recent
batch rather than read as the queue's live depth, which only Cloudflare's dashboard shows.

## Health

`/v1/sync/health`, `/v1/sync/alerts`, `/v1/sync/reconcile` and `/v1/sync/polar-reconcile` first
spend one request of `IP_LIMIT`, 300 per 60 seconds per `CF-Connecting-IP` (an IPv6 caller by its /64), answering 429
`rate-limited` over it and letting the request through when the binding cannot answer
(`packages/http`). The service-binding `POST /webhook` answers a body past 1 MiB 413
`payload-too-large`.

`GET /v1/sync/health` answers `{ ok, repos, subscriptions, seats, last_webhook_at,
last_reconcile_at, last_reconcile_corrections, last_polar_webhook_at, last_polar_reconcile_at,
last_polar_reconcile_corrections, last_polar_reconcile_error, last_queue_at, last_queue_version,
queue_lag_s, last_dead_letter_at, last_cron_at, last_cron, last_cron_version, paying_uncovered,
polar_webhook_secret, ip_limit, version }`. `last_cron` is the expression of the cron that last
stamped `last_cron_at`; `last_queue_version` and `last_cron_version` are the versions that last
consumed a batch and ran a cron. `seats` counts rows whose last key
is within 30 days; each stamp is null where it was never written, `paying_uncovered` until the first
audit; `polar_webhook_secret` says whether the secret
is set, never its value, and is what `deploy.yml` reads to decide whether to make a new endpoint.
`ip_limit` is what the per-address cap made of that very read: `counted`, `unavailable` when the limiter threw, `unbound` when the binding is missing; the deploy's judge of this Worker requires `counted`.

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
writes its secret to a file the Worker's deploy step puts in its secrets file. A run that makes no
new endpoint leaves `POLAR_WEBHOOK_SECRET` out of the file, and `--secrets-file` keeps a secret the
file omits from the previous version.

Like the three request-path Workers, whose secrets travel with each uploaded version, the sync
Worker's travel with the version its `wrangler deploy --secrets-file` makes; no step runs
`wrangler secret bulk`.

`SYNC_ADMIN_TOKEN` is no repository secret: `deploy.yml` generates a fresh one on every run, stores
it with the others and uses it once to run the reconcile in its read-back, so nobody holds a copy
and the next deploy rotates it.
