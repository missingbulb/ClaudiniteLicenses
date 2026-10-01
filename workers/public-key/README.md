# workers/public-key

Issues Public session keys. The router forwards a `repository_dispatch` of type
`claudinite-key-public` to `POST /webhook`; for a public repo and a `User` sender the Worker signs a
7-day Public key (every feature but `fleet`, release states from `release-states.json`) and posts
it as the text of a neutral `Claudinite key` check run whose external id is the session's nonce. A
private repo gets a check run titled `Claudinite key refused` with the reason and no key; a Bot
sender, a malformed nonce or head, or a missing installation get a 4xx and no check run. A GitHub
error answers 502, and a secondary rate limit is logged with the marker `secondary-rate-limit`.

`GET /v1/public/health`, its one public route, answers `{ ok, kid, cert_exp }` from the issuing
key's certificate without calling GitHub.

Every answered request writes one Analytics Engine point to `KEY_COUNTS`: index the repo id, blobs
plan, outcome (`issued`, `refused-private`, `refused-sender`, `github-error`), owner type and engine
version.

## Secrets

Each repository secret `deploy.yml` reads, and the Worker secret it is stored as:

- `CLAUDINITE_GITHUB_APP_ID`, as `GITHUB_APP_ID`
- `CLAUDINITE_GITHUB_APP_PRIVATE_KEY`, as `GITHUB_APP_PRIVATE_KEY` (the App's PEM as GitHub hands it out)
- `ISSUING_KEY_PRIVATE` (the issuing key's seed file, ClaudiniteEngine's key format)
- `ISSUING_KEY_CERT` (its `license-public` certificate JSON)
