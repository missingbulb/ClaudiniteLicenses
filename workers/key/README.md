# workers/key

The paid key Worker, answering a web session, a desktop and an Actions run, and exchanging an
Actions key for an item grant. It signs every key with the `license` issuing key, whatever the
plan, and decides from D1 reads alone. It writes nothing to D1: each key's usage, seat and grace
records go onto the writes queue, which the sync Worker consumes as D1's only writer. A test pins
that no `INSERT`, `UPDATE` or `DELETE` appears under `src/`, since D1 has no read-only binding.

Every read goes through `reader(env)` (`src/db.ts`): one D1 session per request, opened
`first-unconstrained`, so the first read may be served by the nearest read replica and every later
read in that request is at least as fresh. The key Worker reads nothing it wrote, so it needs no
bookmark and never opens a `first-primary` session, which a test pins. A replica behind the primary
can make it queue a `usage` or `grace-start` message the primary already holds. Every seat
statement is idempotent, so that costs one extra message, never a wrong row. The item grant reads
no D1 and opens no session. Whether replication is on is the deploy's `D1_READ_REPLICATION`
(`db/README.md`).

## Plans

One function, `resolvePlan` (`src/plan.ts`, with the seat reads in `src/seats.ts`), serves every
path. Visibility is the caller's, as GitHub reported it on that path, never the table's; `internal`
counts as private. A repo with no `repos` row is refused `app-not-installed`.

The plan comes from the owner's `subscriptions` rows, a row paying while its `status` is `active`,
`trialing` or `past_due` and it has not ended: an `internal`, `organization` or `personal` row with
paid seats, in that order, covers every repo of the owner; else a `private-repo` row naming the
repo; else a private repo is `private-repo` with zero paid seats, and a public repo `public`. A
public repo's users take no seat, whatever its plan: `state: ok`, `seats: null`, no seat read and no
write. For a private repo the Worker reads the licensee's `seats` rows in the 30-day window (the
licensee is the repo under `private-repo`, the owner otherwise), the owner's `overuse` row and, for
a session key, today's `usage` row, and `packages/licensing`'s `resolveSeats` gives the state:

| Licensee | State | Notice | Features |
| --- | --- | --- | --- |
| Counted users within paid seats | `ok` | none | the plan's |
| Within the headroom (`max(1, ceil(paid / 10))`, 0 when nothing is paid) | `ok` | `over-within-headroom` | the plan's |
| Beyond it, during the 7 days of grace (the first such key starts it) | `grace` | `overused` | the plan's |
| Beyond it, grace over or spent within 30 days: a seated user | `ok` | `overused` | the plan's |
| The same, a user ranked past the paid seats | `degraded` | `seat-refused` | none |

Every key carries its notice in the signed payload as `notice` (`null` when there is none), and the
HTTP answer and the check-run summary name the same word, so a binary reading any of the three sees
one fact. A grant carries its Actions key's notice.

The plan's features are every feature but `fleet` on Public and Private repo, every feature on the
owner-wide plans. An Actions key has no user: its state is the licensee's from the seat rows alone,
and it writes nothing.

When D1 cannot be read and the var `FAIL_OPEN` is `"true"`, the key is issued anyway, plan `public`
for a public repo and `private-repo` for a private one (the binary refuses a Public key on a
private repo), state `unverified`, every feature, and the Worker reports a `d1-unreadable`
incident (below); with any other value the request is refused `server-error`. The committed value
is `"true"`; the repository variable `KEY_FAIL_OPEN`, `true` or `false`, overrides it at the next
deploy without a commit (the repo README's deploy section has the two commands), and the health
body's `fail_open` says which value is live.

## Writes

A session key on a private repo queues, on `WRITES` (`claudinite-licenses-writes`), a `usage`
message when today's `usage` row is missing or the user has no seat under this licensee yet, then
the `grace-start` or `grace-reset` its verdict asks for; a fail-open key on a private repo queues
one `usage` message with the plan it assumed. The messages are `packages/licensing`'s
`WriteMessage`, sent with one `sendBatch` inside `waitUntil`, so the answer never waits on the
queue; a send that fails logs `{ "marker": "queue-send-failed" }` and the key stands. Public repos
and Actions keys send no seat records.

## Incidents

Each marker the alerts count is logged as a line and, when `WRITES` is bound, queued as an
`incident` message (`{ v: 1, kind: "incident", at, marker, detail }`) in its own `sendBatch` inside
`waitUntil`, so an answer never waits on it. The sync Worker writes it as an `incidents` row.

| Marker | When | `detail` |
| --- | --- | --- |
| `d1-unreadable` | a key path cannot read D1, failing open or refusing | the path: `web`, `desktop` or `actions` |
| `polar-unreachable` | a link call fails, runs out of time, or Polar is unconfigured | the call: `checkout`, `customer-session` or `unconfigured` |
| `app-not-installed` | a desktop or Actions request for a repo with no row | the path |
| `secondary-rate-limit` | GitHub refuses the web path's check run for its secondary rate limit | GitHub's call |
| `deploy-read-back` | the deploy's judge of the sync Worker, through the Queues API; never queued by this Worker | the deploy run's URL |

A fail-open key therefore queues its `usage` and its incident, and both wait in the queue until D1
answers. `queue-send-failed` is never an incident, since a Worker that cannot reach the queue
cannot report through it: the probe's `queue: "bound"` check and a `queue_lag_s` that stops moving
are its signal.

## Links

A key that is not plainly `ok` (state `grace` or `degraded`, or a notice) carries `checkout_url`,
a Polar checkout for the owner, the plan and, under `private-repo`, the repo, offering the monthly
and yearly products; and, when the owner has any subscription row, `portal_url`, a customer
portal session. Both come from `packages/polar` with `POLAR_API_BASE` and `POLAR_ACCESS_TOKEN`,
under one 3-second deadline, which the Polar client also takes as its own timeout so an abandoned
call is aborted, cached in the isolate for an hour per owner, plan and repo (the managed products
too); a link Polar did not give is not cached. A call that fails or runs out of time reports a
`polar-unreachable` incident and leaves its link `null`; the key is answered either way. An `internal` plan has no checkout; an `unverified` key asks Polar nothing.

## Paths

**Web.** The router forwards a `repository_dispatch` of type `claudinite-key` to `POST /webhook`.
The checks are the public key Worker's (a `User` sender, the nonce, the head, the installation, the
payload's shapes); the webhook came through an installation, so a missing row is not a refusal
here. The answer is one neutral `Claudinite key` check run whose external id is the nonce and whose
text is a 7-day session key, its summary `<plan> key for @<login> (sender type User), state
<state>[, <notice>], issued <time>`; or `Claudinite key refused` whose summary is
`<refusal>: <text>`, spelled by `packages/github-app`'s `refusalSummary`, since the binary takes
what precedes the first colon as the cause.

**Desktop.** `POST /v1/session-key`, `Authorization: Bearer <App user token>`, body
`{ "repo": "owner/name", "nonce", "engine_version" }`. The Worker reads `GET /user` (must be a
`User`; its id is the key's user) and `GET /repos/{owner}/{name}` (the repo id, owner, visibility
and the caller's push access) with the caller's token. It answers
`{ "key", "plan", "state", "notice", "checkout_url", "portal_url" }`, or
`{ "refused": "<reason>" }`: 400 `malformed-body`, `bad-repo` or `bad-nonce`, 413 `body-too-large`, 401 `token-missing` or `token-invalid`, 403
`sender-not-user`, `repo-not-visible` (GitHub's 404: the App is not installed there or the person
has no access), `no-push-access` or `app-not-installed`, 502 `github-error`, 503
`server-error`.

**Actions.** `POST /v1/actions-key`, `Authorization: Bearer <OIDC token>` requested with audience
`claudinite`, body `{ "engine_version" }`. The token is verified RS256 against the key its `kid`
names in `${OIDC_ISSUER}/.well-known/jwks` (cached in the isolate for an hour, refetched on an
unknown `kid` at most once every 30 seconds), with `iss` equal to `OIDC_ISSUER`, `aud` `claudinite`, and `exp`, `nbf` and `iat`
within the signing spec's 5 minutes of skew; then `repository_id`, `repository_owner_id`,
`repository`, `repository_owner`, `repository_visibility`, `event_name` and `job_workflow_ref` must
be present. Each failure is a 401 naming it (`token-missing`, `token-malformed`,
`token-unknown-key`, `token-signature`, `token-issuer`, `token-audience`, `token-expired`,
`token-not-yet-valid`, `token-claims`), or 502 `jwks-unavailable`. Then, each a 403: `event_name`
`pull_request` or `pull_request_target` is `pull-request-trigger`; a `job_workflow_ref` other than
`{repository}/.github/workflows/{name}.yml@refs/heads/{default branch}`, `name` one of
`claudinite-scheduler`, `claudinite-executor` and `claudinite-update`, is `workflow-not-pinned`; no
row is `app-not-installed`; a row whose default branch the sync Worker has not read yet is
`repo-not-synced`. `claudinite-ci` is deliberately not pinned: it runs on `pull_request`, which is
refused outright, and on a dispatch against the update PR's branch, which the default-branch half
refuses whatever the name, so pinning it would mint nothing for that run and widen the files that
can mint for every member. The key is a 6-hour `actions` key, no user or nonce, the owner type from the
row, the visibility from the `repository_visibility` claim and the state the licensee's, answered
as `{ "key", "plan", "state", "notice", "checkout_url", "portal_url" }`. An Actions key never fails open: without D1 the workflow pin cannot be
checked, so an unreadable D1 answers 503 `server-error`. There is no per-`jti` replay store, so the
engine design's "accepting each token once" is not implemented: a replayed token mints the same
principal's key for the same run, and a token outlives its job by minutes.

**Item grants.** `POST /v1/item-grant`, `Authorization: Bearer <Actions key>` (its JSON wire
form), body `{ "issue": <positive integer> }`. The Actions key must verify against the var
`TRUST_ROOTS`, a JSON array of root public keys (`deploy.yml` passes `tools/keys.mjs trust-roots`:
`packages/signing/roots/*.pub` once that directory exists, the dev root until then), and be an
unexpired `actions` key. `TRUST_ROOTS` is parsed once per isolate; a value that is not a non-empty
JSON array of non-empty strings refuses every grant with 503 `trust-roots-invalid`. The answer is `{ "grant" }`, a `grant` key carrying the Actions key's
repo, owner, plan, state, grace end, features, seats and links, the body's `issue`, no user or
nonce, lasting 6 hours and never past the Actions key's `exp`. A degraded Actions key gets a
degraded grant. Refusals: 401 `{ "refused": "key-invalid", "reason" }` with `verifyKey`'s reason
(`shape` for no key), 403 `key-not-actions`, 400 `issue-invalid`. There is no replay store.

**Per-address cap and body caps.** Every public route (`/v1/session-key`, `/v1/actions-key`,
`/v1/item-grant`, `/v1/login/config`, `/v1/login/refresh`, `/v1/key/health`) first spends one
request of `IP_LIMIT`, 300 per 60 seconds per `CF-Connecting-IP` (an IPv6 caller by its /64), before anything else is read;
over it, 429 `rate-limited` with `Retry-After: 60`. The count is Cloudflare's, per location and approximate; when the
binding cannot answer the request passes and an `ip-limit-unavailable` line is logged once a
minute. A JSON body past 16 KiB, or a `Content-Length` claiming more, is refused 413
`body-too-large` before GitHub, the JWKS or D1 is asked anything; the service-binding `POST
/webhook` takes up to 1 MiB, answering a larger dispatch 413 `payload-too-large`. The engine
version is cut to 64 characters before it becomes a usage blob. Both caps are `packages/http`'s.

**Rate limit.** `OWNER_LIMIT`, 600 requests per 60 seconds per owner, keyed by the owner's login in
lower case as GitHub or the token names it, is checked only once the caller is authenticated: on
the desktop path after GitHub has read the caller and the repo, on the Actions path once the token
verifies, both before any D1 read, and on a grant once the Actions key verifies, by its
`owner_login`. Over it, 429 `rate-limited`. An unauthenticated request never
spends a bucket.

Every answered request writes one Analytics Engine point to `KEY_COUNTS`, the dataset the public key
Worker writes: index the repo id, blobs plan (or `none`), outcome (`issued-<state>`,
`refused-<reason>`, `github-error`), owner type, engine version and path (`web`, `desktop`,
`actions`, `grant`). A desktop request nobody authenticated writes none: a malformed or oversized
body, a bad repo or nonce, and GitHub refusing the token (`token-invalid`) answer without a point,
so a stranger cannot fill the dataset.

The blob order is `KEY_COUNT_BLOBS` in `packages/licensing`, which both key Workers write with and
`tools/key-counts.mjs` reads `blob1`…`blob5` back by. That tool queries the dataset through the
Analytics Engine SQL API with a Cloudflare API token, counting `sum(_sample_interval)` grouped by
any of those names over a time range, optionally for one repo id and engine version. A token
without the `Account Analytics: Read` permission answers `unavailable`, naming it, and exits 0.
Points are kept three months.

Every answer, on every route and status, carries `X-Claudinite-Version`, the id of the Cloudflare
version that served it, from the `version_metadata` binding `CF_VERSION_METADATA`; the deploy's
canary probe tells a split's two versions apart by it. The id is public by design.

`GET /v1/key/health` answers `{ ok, kid, cert_exp, cert_days_left, d1, d1_served_by_primary,
d1_served_by_region, d1_ms, queue, polar, trust_roots, fail_open, ip_limit, version, alerts }`.
`d1_served_by_primary`, `d1_served_by_region` and `d1_ms` say where and how fast its `SELECT 1`
was served (the result's `meta.served_by_primary`, `meta.served_by_region` and `meta.duration`).
Each is `null` when D1 does not fill it, as the local runtime leaves the first two, and while D1
is unreadable. They are reported, never judged. `fail_open` the live `FAIL_OPEN` as a boolean, `ip_limit` what the per-address cap made of that very read (`counted`, `unavailable` when the limiter threw, `unbound` when the binding is missing; the deploy reads back `counted`), `version` the same id as the header: `cert_days_left` is the whole days to `cert_exp`, `d1` is `ok` or `unreadable` after one
`SELECT 1`, `queue` is `bound` or `unbound`, `polar` is `configured` when both `POLAR_API_BASE`
and `POLAR_ACCESS_TOKEN` are set, else `unconfigured`, and `trust_roots` is `ok` or `invalid`. It
judges itself: while any of `cert-expiring` (fewer than 14 days left, the issuing keys' overlap),
`cert-expired`, `trust-roots-invalid` or `d1-unreadable` stands it answers 503 with `ok: false` and
those ids in `alerts`, else 200 with `alerts: []`. A status-only monitor therefore pages on the
Worker's own conditions; the queue and Polar fields are the outside probe's to judge.

## Contract for `cn login`

What ClaudiniteEngine implements for a desktop:

1. `GET /v1/login/config` answers `{ "client_id", "device_code_url", "token_url" }`, so the binary
   embeds no App id.
2. The binary runs GitHub's device flow against those URLs directly with that client id, and keeps
   the App user token and its refresh token in its cache folder, mode 0600.
3. It calls `POST /v1/session-key` with the token. When GitHub's answer makes that a 401
   `token-invalid`, it calls `POST /v1/login/refresh` with `{ "refresh_token" }`; the Worker adds
   the App's client secret, sends GitHub's refresh grant and returns GitHub's answer and status
   verbatim (`access_token`, `expires_in`, `refresh_token`, `refresh_token_expires_in`). While the
   secret is unset that route answers 503 `refresh-not-configured` (a body without a
`refresh_token` is 400 `no-refresh-token` first, so an unauthenticated probe learns nothing of the
secret), and the binary runs the device
   flow again.

## Secrets

Each repository secret `deploy.yml` reads, and the Worker secret it is stored as:

- `CLAUDINITE_GITHUB_APP_ID`, as `GITHUB_APP_ID`
- `CLAUDINITE_GITHUB_APP_PRIVATE_KEY`, as `GITHUB_APP_PRIVATE_KEY`
- `CLAUDINITE_GITHUB_APP_CLIENT_SECRET`, as `GITHUB_APP_CLIENT_SECRET` (optional: only `/v1/login/refresh` needs it)
- `KEY_ISSUING_KEY_PRIVATE`, as `ISSUING_KEY_PRIVATE` (the `license` issuing key's seed file)
- `KEY_ISSUING_KEY_CERT`, as `ISSUING_KEY_CERT` (its `license` certificate JSON)
- `POLAR_SANDBOX_TOKEN`, as `POLAR_ACCESS_TOKEN` (the sandbox organization's token, until the commercial track flips both Workers to production)

The vars `POLAR_API_BASE` (`https://sandbox-api.polar.sh`) and `TRUST_ROOTS` are in
`wrangler.jsonc`; the deploy passes the real `TRUST_ROOTS` with `--var`.

While both `KEY_ISSUING_KEY_*` secrets are unset, `deploy.yml` stores the dev `license` key in
[`keys/dev`](../../keys/dev/README.md) instead and warns; with only one of them set it fails.
