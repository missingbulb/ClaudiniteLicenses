# workers/router

The Claudinite App's webhook address, `license.claudinite.com/github-webhook`. It checks
`X-Hub-Signature-256` and passes each webhook to its Worker over a service binding: a
`repository_dispatch` of type `claudinite-key-public` to `PUBLIC_KEY`, `claudinite-key` to `KEY`,
and `installation`, `installation_repositories` and `repository` to `SYNC`. It answers `ping` itself
and 204 to anything else, and returns the bound Worker's status and body. `PUBLIC_KEY`, `KEY` and
`SYNC` are bound to `claudinite-public-key`, `claudinite-key` and `claudinite-sync`; a binding a
future config drops answers 202 `unrouted: <event>`, so GitHub keeps the delivery redeliverable.

A body past 1 MiB, or a `Content-Length` claiming more, is refused before the HMAC is computed
(`packages/http`'s cap). The router has no per-address cap: the signature check is its gate, and
GitHub's deliveries come from a few addresses that a cap would throttle.

Every answer carries `X-Claudinite-Version`, the router's own Cloudflare version id from the
`version_metadata` binding `CF_VERSION_METADATA`, replacing the one a bound Worker's answer named,
so the canary probe judges the router's version on the signature check.

## Secrets

Each repository secret `deploy.yml` reads, and the Worker secret it is stored as:

- `CLAUDINITE_GITHUB_APP_WEBHOOK_SECRET`, as `GITHUB_APP_WEBHOOK_SECRET`
