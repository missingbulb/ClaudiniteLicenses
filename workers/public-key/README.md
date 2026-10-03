# workers/public-key

Issues Public session keys. The router forwards a `repository_dispatch` of type
`claudinite-key-public` to `POST /webhook`; for a public repo and a `User` sender the Worker signs a
7-day Public key (every feature but `fleet`, release states from `release-states.json`, `notice: null`) and posts
it as the text of a neutral `Claudinite key` check run whose external id is the session's nonce. A
private repo gets a check run titled `Claudinite key refused` and no key, its summary
`refused-private: this repo is private; the Public plan covers public repos only`, spelled by
`packages/github-app`'s `refusalSummary` so the binary cuts the cause at the first colon, the same
word the desktop route refuses with; a Bot
sender, a malformed nonce or head, or a missing installation get a 4xx and no check run. A GitHub
error answers 502, and a secondary rate limit is logged with the marker `secondary-rate-limit`.

`POST /v1/public/session-key` serves a desktop: `Authorization: Bearer <App user token>`, body
`{ "repo": "owner/name", "nonce", "engine_version" }`. It reads `GET /user` and the repo with the
caller's token, as the paid key Worker's `/v1/session-key` does, refusing the same way (400, 401
`token-missing` or `token-invalid`, 403 `sender-not-user`, `repo-not-visible` or
`no-push-access`, 502 `github-error`). A public repo answers `{ "key", "plan": "public", "state":
"ok" }`, a private one 403 `{ "refused": "refused-private" }`.

Both public routes first spend one request of `IP_LIMIT`, 300 per 60 seconds per
`CF-Connecting-IP` (an IPv6 caller by its /64), answering 429 `rate-limited` with `Retry-After: 60` over it and letting the request through when the
binding cannot answer. The desktop body is refused 413 `body-too-large` past 16 KiB, before GitHub
is asked, and GitHub refusing the token (`token-invalid`) writes no usage point; the
service-binding `POST /webhook` answers a dispatch past 1 MiB 413 `payload-too-large`. Both caps
are `packages/http`'s.

Every answer carries `X-Claudinite-Version`, the serving Cloudflare version's id from the
`version_metadata` binding `CF_VERSION_METADATA`, which the deploy's canary probe reads.

`GET /v1/public/health` answers `{ ok, kid, cert_exp, cert_days_left, ip_limit, version, alerts }` from the issuing
key's certificate without calling GitHub, and judges it (`ip_limit` is what the per-address cap made of that very read: `counted`, `unavailable` when the limiter threw, `unbound` when the binding is missing; the deploy reads back `counted`.): with fewer than 14 days left it answers
503 with `ok: false` and `alerts: ["cert-expiring"]`, once expired `["cert-expired"]`, else 200
with `alerts: []`.

Every answered request writes one Analytics Engine point to `KEY_COUNTS`: index the repo id, blobs
plan, outcome (`issued`, `refused-private`, `refused-sender`, `refused-<reason>` on the desktop
path, `github-error`), owner type, engine version and the path the request came by (`web` or
`desktop`). The order is the key Worker's, `KEY_COUNT_BLOBS` in `packages/licensing`.

## Secrets

Each repository secret `deploy.yml` reads, and the Worker secret it is stored as:

- `CLAUDINITE_GITHUB_APP_ID`, as `GITHUB_APP_ID`
- `CLAUDINITE_GITHUB_APP_PRIVATE_KEY`, as `GITHUB_APP_PRIVATE_KEY` (the App's PEM as GitHub hands it out)
- `ISSUING_KEY_PRIVATE` (the issuing key's seed file, ClaudiniteEngine's key format)
- `ISSUING_KEY_CERT` (its `license-public` certificate JSON)

The `ISSUING_KEY_*` secrets hold the `license-public` issuing key ClaudiniteEngine's key ceremony
certified; `deploy.yml` skips while either is unset, as for every other secret here.
