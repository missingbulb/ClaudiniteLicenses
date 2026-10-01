# workers/key

The paid key Worker, answering a web session, a desktop and an Actions run. It signs every key with the `license` issuing key, whatever the plan, decides
from D1 reads alone and writes nothing; the sync Worker is D1's only writer. A test pins that no
`INSERT`, `UPDATE` or `DELETE` appears under `src/`, since D1 has no read-only binding.

## Plans

One function, `resolvePlan`, serves every path. Visibility is the caller's, as GitHub reported it
on that path, never the table's. A repo with no `repos` row is refused `app-not-installed`; a
public repo gets the Public plan (`state: ok`, every feature but `fleet`); a private or internal
repo is refused `no-plan` until the seats chunk reads subscriptions. When D1 cannot be read and the
var `FAIL_OPEN` is `"true"`, the key is issued anyway, plan `public`, state `unverified`, every
feature, and the Worker logs `{ "marker": "d1-unreadable" }` for the alerts; with any other value
the request is refused `server-error`.

## Paths

**Web.** The router forwards a `repository_dispatch` of type `claudinite-key` to `POST /webhook`.
The checks are the public key Worker's (a `User` sender, the nonce, the head, the installation, the
payload's shapes); the webhook came through an installation, so a missing row is not a refusal
here. The answer is one neutral `Claudinite key` check run whose external id is the nonce and whose
text is a 7-day session key, or `Claudinite key refused` whose summary starts with the refusal.

**Desktop.** `POST /v1/session-key`, `Authorization: Bearer <App user token>`, body
`{ "repo": "owner/name", "nonce", "engine_version" }`. The Worker reads `GET /user` (must be a
`User`; its id is the key's user) and `GET /repos/{owner}/{name}` (the repo id, owner, visibility
and the caller's push access) with the caller's token. It answers `{ "key", "plan", "state" }`, or
`{ "refused": "<reason>" }`: 400 for a malformed body, 401 `token-missing` or `token-invalid`, 403
`sender-not-user`, `repo-not-visible` (GitHub's 404: the App is not installed there or the person
has no access), `no-push-access`, `app-not-installed` or `no-plan`, 502 `github-error`, 503
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
`repo-not-synced`; a private repo is `no-plan`. The key is a 6-hour `actions` key, no user or nonce,
the owner type from the row, the plan from the `repository_visibility` claim, answered as
`{ "key", "plan", "state" }`. An Actions key never fails open: without D1 the workflow pin cannot be
checked, so an unreadable D1 answers 503 `server-error`. There is no per-`jti` replay store, so the
engine design's "accepting each token once" is not implemented: a replayed token mints the same
principal's key for the same run, and a token outlives its job by minutes.

**Rate limit.** `OWNER_LIMIT`, 600 requests per 60 seconds per owner, keyed by the owner's login in
lower case as GitHub or the token names it, is checked only once the caller is authenticated: on
the desktop path after GitHub has read the caller and the repo, on the Actions path once the token
verifies, both before any D1 read. Over it, 429 `rate-limited`. An unauthenticated request never
spends a bucket.

Every answered request writes one Analytics Engine point to `KEY_COUNTS`, the dataset the public key
Worker writes: index the repo id, blobs plan (or `none`), outcome (`issued`, `refused-<reason>`,
`github-error`), owner type, engine version and path (`web`, `desktop`, `actions`).

`GET /v1/key/health` answers `{ ok, kid, cert_exp, d1 }`, `d1` being `ok` or `unreadable` after one
`SELECT 1`.

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
   secret is unset that route answers 503 `refresh-not-configured`, and the binary runs the device
   flow again.

## Secrets

Each repository secret `deploy.yml` reads, and the Worker secret it is stored as:

- `CLAUDINITE_GITHUB_APP_ID`, as `GITHUB_APP_ID`
- `CLAUDINITE_GITHUB_APP_PRIVATE_KEY`, as `GITHUB_APP_PRIVATE_KEY`
- `CLAUDINITE_GITHUB_APP_CLIENT_SECRET`, as `GITHUB_APP_CLIENT_SECRET` (optional: only `/v1/login/refresh` needs it)
- `KEY_ISSUING_KEY_PRIVATE`, as `ISSUING_KEY_PRIVATE` (the `license` issuing key's seed file)
- `KEY_ISSUING_KEY_CERT`, as `ISSUING_KEY_CERT` (its `license` certificate JSON)

While both `KEY_ISSUING_KEY_*` secrets are unset, `deploy.yml` stores the dev `license` key in
[`keys/dev`](../../keys/dev/README.md) instead and warns; with only one of them set it fails.
