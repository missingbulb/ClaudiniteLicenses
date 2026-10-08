# workers/key

The key Worker, answering a fleet manager's Actions run with its owner's key. It signs every key
with the `license` issuing key and decides from D1 reads alone. It writes nothing to D1: the
incidents it reports go onto the writes queue, which the sync Worker consumes as D1's only writer.
A test pins that no `INSERT`, `UPDATE` or `DELETE` appears under `src/`, since D1 has no read-only
binding.

Every read goes through `reader(env)` (`src/db.ts`): one D1 session per request, opened
`first-unconstrained`, so the first read may be served by the nearest read replica and every later
read in that request is at least as fresh. The key Worker reads nothing it wrote, so it needs no
bookmark and never opens a `first-primary` session, which a test pins. Whether replication is on is
the deploy's `D1_READ_REPLICATION` (`db/README.md`).

## Plans

One repo, public or private, is free, and the engine asks for no key for it. The paid plans are
fleets, and `resolveForRow` (`src/plan.ts`) gives a key the fleet its owner pays for, by
`packages/licensing`'s `fleetPlan`: `internal` first (an owner in `INTERNAL_OWNERS` or with an internal row), then `personal` for a `User` owner and
`organization` for an `Organization` owner, from an owner's `subscriptions` row whose `status` is
`active`, `trialing` or `past_due` and that has not ended. The owner's type is the `repos` row's.
Neither the repo's visibility nor any seat count is read. An owner with no fleet gets `public`, the
no-fleet answer.

Every key is `state: ok`, `grace_until: null`, `seats: null` and `notice: null`. A fleet plan
carries every feature; `public` carries every feature but `fleet`.

## Links

The no-fleet answer carries `checkout_url`, a Polar checkout of the fleet the owner's type can buy
(`personal` for a `User`, `organization` for an `Organization`) offering its monthly and yearly
products, with the owner as the external customer id; and, when the owner has any subscription
row, `portal_url`, a customer portal session. A fleet key carries neither and asks Polar nothing.
Both come from `packages/polar` with `POLAR_API_BASE` and `POLAR_ACCESS_TOKEN`, under one 3-second
deadline, which the Polar client also takes as its own timeout so an abandoned call is aborted,
cached in the isolate for an hour per owner, plan and whether it is subscribed (the managed products
too); a link Polar did not give is not cached. A call that fails or runs out of time reports a
`polar-unreachable` incident and leaves its link `null`; the key is answered either way.

## Incidents

Each marker the alerts count is logged as a line and, when `WRITES` is bound, queued as an
`incident` message (`{ v: 1, kind: "incident", at, marker, detail }`) in its own `sendBatch` inside
`waitUntil`, so an answer never waits on it. The sync Worker writes it as an `incidents` row.

| Marker | When | `detail` |
| --- | --- | --- |
| `d1-unreadable` | the Actions path cannot read D1 | `actions` |
| `polar-unreachable` | a link call fails, runs out of time, or Polar is unconfigured | the call: `checkout`, `customer-session` or `unconfigured` |
| `app-not-installed` | a request for a repo with no row | `actions` |
| `deploy-read-back` | the deploy's judge of the sync Worker, through the Queues API; never queued by this Worker | the deploy run's URL |

A send that fails logs `{ "marker": "queue-send-failed" }`, which is never an incident, since a
Worker that cannot reach the queue cannot report through it: the probe's `queue: "bound"` check is
its signal.

## The Actions path

`POST /v1/actions-key`, `Authorization: Bearer <OIDC token>` requested with audience `claudinite`,
body `{ "engine_version" }`. The token is verified RS256 against the key its `kid` names in
`${OIDC_ISSUER}/.well-known/jwks` (cached in the isolate for an hour, refetched on an unknown `kid`
at most once every 30 seconds), with `iss` equal to `OIDC_ISSUER`, `aud` `claudinite`, and `exp`,
`nbf` and `iat` within the signing spec's 5 minutes of skew; then `repository_id`,
`repository_owner_id`, `repository`, `repository_owner`, `repository_visibility`, `event_name` and
`job_workflow_ref` must be present. Each failure is a 401 naming it (`token-missing`,
`token-malformed`, `token-unknown-key`, `token-signature`, `token-issuer`, `token-audience`,
`token-expired`, `token-not-yet-valid`, `token-claims`), or 502 `jwks-unavailable`. Then, each a
403: `event_name` `pull_request` or `pull_request_target` is `pull-request-trigger`; a
`job_workflow_ref` other than `{repository}/.github/workflows/{name}.yml@refs/heads/{default branch}`,
`name` one of `claudinite-scheduler`, `claudinite-executor` and `claudinite-update`, is
`workflow-not-pinned`; no row is `app-not-installed`; a row whose default branch or owner type the
sync Worker has not read yet is `repo-not-synced`. `claudinite-ci` is deliberately not pinned: it
runs on `pull_request`, which is refused outright, and on a dispatch against the update PR's branch,
which the default-branch half refuses whatever the name.

The answer is `{ "key", "plan", "state", "notice", "checkout_url", "portal_url" }`, each field the
signed key's own: a 6-hour `actions` key, no user or nonce, `repo_id` and `owner_id` from the
token's `repository_id` and `repository_owner_id`, `owner_login` from `repository_owner`,
`owner_type` from the `repos` row, and the plan and links above. A key is never issued without D1:
an unreadable D1 answers 503 `server-error`. There is no per-`jti` replay store: a replayed token
mints the same principal's key for the same run, and a token outlives its job by minutes.

**Per-address cap and body cap.** Every public route (`POST /v1/actions-key`, `GET` and `HEAD
/v1/key/health`) first spends one request of `IP_LIMIT`, 300 per 60 seconds per
`CF-Connecting-IP` (an IPv6 caller by its /64), before anything else is read; over it, 429
`rate-limited` with `Retry-After: 60`. The count is Cloudflare's, per location and approximate;
when the binding cannot answer the request passes and an `ip-limit-unavailable` line is logged once
a minute. A JSON body past 16 KiB, or a `Content-Length` claiming more, is refused 413
`body-too-large` before the JWKS or D1 is asked anything. The engine version is cut to 64
characters before it becomes a count blob. Both caps are `packages/http`'s.

**Rate limit.** `OWNER_LIMIT`, 600 requests per 60 seconds per owner, keyed by the token's
`repository_owner` in lower case, is checked once the token verifies and passes the pin, before any
D1 read. Over it, 429 `rate-limited`. An unauthenticated request never spends a bucket.

## Counts and version

Every request whose token verifies, but one the owner limit refuses, writes one Analytics Engine
point to `KEY_COUNTS`: index the repo id, blobs plan (or `none`), outcome (`issued-ok` or
`refused-<reason>`), owner type, engine version and path (`actions`). A request whose token does
not verify writes none, so a stranger cannot fill the dataset. The blob order is `KEY_COUNT_BLOBS` in `packages/licensing`, which
`tools/key-counts.mjs` reads `blob1`…`blob5` back by. That tool queries the dataset through the
Analytics Engine SQL API with a Cloudflare API token, counting `sum(_sample_interval)` grouped by
any of those names over a time range, optionally for one repo id and engine version. A token
without the `Account Analytics: Read` permission answers `unavailable`, naming it, and exits 0.
Points are kept three months.

Every answer, on every route and status, carries `X-Claudinite-Version`, the id of the Cloudflare
version that served it, from the `version_metadata` binding `CF_VERSION_METADATA`; the deploy's
canary probe tells a split's two versions apart by it. The id is public by design.

## Health

`GET /v1/key/health` answers `{ ok, kid, cert_exp, cert_days_left, d1, d1_served_by_primary,
d1_served_by_region, d1_ms, queue, polar, ip_limit, version, alerts }`, and `HEAD` the same status
and headers with no body. `cert_days_left` is the whole days to `cert_exp`; `d1` is `ok` or
`unreadable` after one `SELECT 1`, and `d1_served_by_primary`, `d1_served_by_region` and `d1_ms`
say where and how fast it was served (the result's `meta.served_by_primary`,
`meta.served_by_region` and `meta.duration`), each `null` when D1 does not fill it, reported and
never judged; `queue` is `bound` or `unbound`; `polar` is `configured` when both `POLAR_API_BASE`
and `POLAR_ACCESS_TOKEN` are set, else `unconfigured`; `ip_limit` is what the per-address cap made
of that very read (`counted`, `unavailable` when the limiter threw, `unbound` when the binding is
missing; the deploy reads back `counted`); `version` is the same id as the header. It judges
itself: while any of `cert-expiring` (fewer than 14 days left, the issuing keys' overlap),
`cert-expired` or `d1-unreadable` stands it answers 503 with `ok: false` and those ids in `alerts`,
else 200 with `alerts: []`. The queue and Polar fields are the outside probe's to judge.

## Secrets

Each repository secret `deploy.yml` reads, and the Worker secret it is stored as:

- `KEY_ISSUING_KEY_PRIVATE`, as `ISSUING_KEY_PRIVATE` (the `license` issuing key's seed file)
- `KEY_ISSUING_KEY_CERT`, as `ISSUING_KEY_CERT` (its `license` certificate JSON)
- `POLAR_SANDBOX_TOKEN`, as `POLAR_ACCESS_TOKEN` (the sandbox organization's token, until the commercial track flips both Workers to production)

The vars `POLAR_API_BASE` (`https://sandbox-api.polar.sh`) and `OIDC_ISSUER` are in
`wrangler.jsonc`. The Worker acts as no GitHub App and holds none of the App's secrets.

The `KEY_ISSUING_KEY_*` secrets hold the `license` issuing key ClaudiniteEngine's key ceremony
certified; `deploy.yml` skips while either is unset, as for every other secret here.
