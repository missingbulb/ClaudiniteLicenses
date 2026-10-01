# workers/public-key

Issues Public session keys. The router forwards a `repository_dispatch` of type
`claudinite-key-public` to `POST /webhook`; for a public repo and a `User` sender the Worker signs a
7-day Public key (every feature but `fleet`, release states from `release-states.json`) and posts
it as the text of a neutral `Claudinite key` check run whose external id is the session's nonce. A
private repo gets a check run titled `Claudinite key refused` with the reason and no key; a Bot
sender, a malformed nonce or head, or a missing installation get a 4xx and no check run. A GitHub
error answers 502, and a secondary rate limit is logged with the marker `secondary-rate-limit`.

`POST /v1/public/session-key` serves a desktop: `Authorization: Bearer <App user token>`, body
`{ "repo": "owner/name", "nonce", "engine_version" }`. It reads `GET /user` and the repo with the
caller's token, as the paid key Worker's `/v1/session-key` does, refusing the same way (400, 401
`token-missing` or `token-invalid`, 403 `sender-not-user`, `repo-not-visible` or
`no-push-access`, 502 `github-error`). A public repo answers `{ "key", "plan": "public", "state":
"ok" }`, a private one 403 `{ "refused": "refused-private" }`.

`GET /v1/public/health` answers `{ ok, kid, cert_exp, cert_days_left, alerts }` from the issuing
key's certificate without calling GitHub, and judges it: with fewer than 14 days left it answers
503 with `ok: false` and `alerts: ["cert-expiring"]`, once expired `["cert-expired"]`, else 200
with `alerts: []`.

Every answered request writes one Analytics Engine point to `KEY_COUNTS`: index the repo id, blobs
plan, outcome (`issued`, `refused-private`, `refused-sender`, `refused-<reason>` on the desktop
path, `github-error`), owner type, engine version and the path the request came by (`web` or
`desktop`).

## Secrets

Each repository secret `deploy.yml` reads, and the Worker secret it is stored as:

- `CLAUDINITE_GITHUB_APP_ID`, as `GITHUB_APP_ID`
- `CLAUDINITE_GITHUB_APP_PRIVATE_KEY`, as `GITHUB_APP_PRIVATE_KEY` (the App's PEM as GitHub hands it out)
- `ISSUING_KEY_PRIVATE` (the issuing key's seed file, ClaudiniteEngine's key format)
- `ISSUING_KEY_CERT` (its `license-public` certificate JSON)

While both `ISSUING_KEY_*` secrets are unset, `deploy.yml` stores the dev issuing key in
[`keys/dev`](../../keys/dev/README.md) instead and warns; with only one of them set it fails.
