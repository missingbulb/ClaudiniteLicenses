# workers/router

The Claudinite App's webhook address, `license.claudinite.com/github-webhook`. It checks
`X-Hub-Signature-256` and passes each webhook to its Worker over a service binding: a
`repository_dispatch` of type `claudinite-key-public` to `PUBLIC_KEY`, `claudinite-key` to `KEY`,
and `installation`, `installation_repositories` and `repository` to `SYNC`. It answers `ping` itself
and 204 to anything else, and returns the bound Worker's status and body. A binding not configured
yet answers 202 `unrouted: <event>`, so GitHub keeps the delivery redeliverable.

## Secrets

- `GITHUB_APP_WEBHOOK_SECRET`
