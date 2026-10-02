# ClaudiniteLicenses
The license server for Claudinite

## Documents

- [License management design](docs/license-design.md) and its [record](docs/license-record.md).
- The engine design and build plan live in [ClaudiniteEngine](https://github.com/missingbulb/ClaudiniteEngine/tree/main/docs).

## Layout

- `packages/signing`: the license key format and its vectors; its README is the spec.
- `packages/licensing`: the seat, headroom, grace and paid-seat rules, and the writes queue's messages, bundled by the key and sync Workers.
- `packages/polar`: the Polar client (checkouts, customer sessions, subscriptions, webhook endpoints) and the Standard Webhooks check.
- `packages/github-app`: the Claudinite App's GitHub client (App JWT, installation tokens, the key check run), a source package each Worker that acts as the App bundles.
- `packages/http`: what each Worker does to a request before spending anything on it: the per-address cap (`IP_LIMIT`), the 16 KiB and 1 MiB body caps, and the engine version's 64-character cut.
- `packages/version`: the `X-Claudinite-Version` header every Worker puts on each answer, from its `version_metadata` binding.
- `workers/router`: the App's one webhook address, forwarding each webhook to the Worker it is for.
- `workers/public-key`: the public key Worker, Public keys for public repos on the web and desktop paths.
- `workers/key`: the paid key Worker, the web, desktop and Actions key paths in every seat state, item grants, and `cn login`'s config and refresh.
- `workers/sync`: the sync Worker, D1's only writer: repos from the App's installation webhooks and a nightly reconcile, subscriptions from Polar's webhooks and reconcile, seats and usage from the writes queue.
- `db/`: the D1 schema and its additive migrations; `deploy.yml` creates the database and applies them.
- `billing/plans.json`: the paid plans and their prices per seat, read by the Polar products tool.
- `tools/`: dev key chains, the D1, queue, DNS and Polar webhook deploy helpers, a Polar checkout maker, the App webhook re-pointer, the Polar products tool, the outside probe (`tools/probe.mjs`), the staged deploy's version tool (`tools/stage.mjs`), the D1 restore rehearsal (`tools/d1-restore-rehearsal.mjs`), local GitHub and Polar API stubs, the local round trip and its route front (`tools/dev-routes`).
- `spike/`: the web key spike, run in a Claude Code web session; results in `docs/spikes/`.

## Local verification

```
npm ci
npm run typecheck
npm test
npm run dry-run
npm run e2e
```

`npm run e2e` runs every key path against the GitHub and Polar stubs, the four Workers, the local
writes queue and a local D1, then an incident, the alerts firing and clearing and the outside probe, with
the dev chain in `.dev` (`node tools/keys.mjs dev-chain --out .dev`) or a throwaway one. `npm run
dev` serves the same set on port 8787 until interrupted.

## Deploying

`deploy.yml` runs on every push to `main`. It records D1's restore point before the migrations,
uploads a new version of the public key, key and router Workers with their secrets without serving
it, deploys the sync Worker at once and judges it by its health and alerts, then serves each new
version to one tenth of requests. The canary probe (`tools/probe.mjs --expect-version`) reaches each
new version through Cloudflare's version-affinity header and must pass on it; the versions are then
promoted to all requests and every Worker's routes and crons applied. A failed canary, promotion or
read-back rolls every staged Worker back to the version that was live when the run started, so a run
ends either with the new versions passing from outside or with the previous ones live and the run
red.

The account gets a real percentage split: the first staged deploy (run 36927209537) served each new
version at 10% beside the live one at 90%, never `stage.mjs split`'s 100% fallback, and the canary
reached all three new versions before promotion. The sync Worker deploys at 100%; its cron and
queue `version` lines are in its Cloudflare logs, not the job log, and whether it can join the
split is still open (`workers/sync/README.md`).

The run summary carries the restore point as the exact dispatch that returns D1 to it, inside the
Time Travel window of 7 days on Workers Free or 30 on Workers Paid:

```
gh workflow run d1-restore.yml -f bookmark=<bookmark from the summary>
```

A restore is in place and reverts every row written after the bookmark; see `db/README.md` before
running it. The `rehearse_d1_restore` dispatch input runs the same restore command on a throwaway
database first.

The key Worker's fail-open (`FAIL_OPEN`, `workers/key/README.md`) can be turned off without a
commit: set the repository variable and run a deploy, then delete the variable and deploy again to
return to the committed value. The read-back checks `/v1/key/health`'s `fail_open` against the value
the deploy chose.

```
gh variable set KEY_FAIL_OPEN --body false
gh workflow run deploy.yml
```

```
gh variable delete KEY_FAIL_OPEN
gh workflow run deploy.yml
```

The read-back also proves the per-address cap from outside: it reads `/v1/key/health` until a
429 arrives, failing the run if none has within 400 reads, then waits a minute for the window to
clear before the final probe.

Three rules keep this safe:

- A change to the contract between the router and a Worker it binds promotes the callee first: two
  deploys, or the callee's change behind a flag.
- Migrations are additive, so the version a rollback returns to still reads the schema
  (`db/test/migrations-additive.test.ts`).
- A split left standing by an interrupted run is rolled back by hand before the next deploy, which
  refuses to stack on it:
  `node tools/stage.mjs rollback --config workers/<worker>/wrangler.jsonc --id <the version that should be live>`.

## The outside probe

Each Worker judges its own health and the sync Worker judges the shared state, so four URLs on
`license.claudinite.com` answer a non-200 while anything is wrong: `/v1/public/health`,
`/v1/key/health`, `/v1/sync/health` and `/v1/sync/alerts`. An HTTP monitor polling them needs no
API key.

`tools/probe.mjs` checks the same from outside Cloudflare, plus the router's signature check, the
desktop path reaching GitHub and, with an OIDC token, the Actions verifier and pin. The `probe`
workflow runs it at minutes 7, 22, 37 and 52 of every hour and on dispatch, and keeps one standing
issue titled `License server probe`, labelled `probe`: opened or commented on by a failing run,
closed by the next passing one. GitHub fires a cron late or not at all under load and disables it
after 60 days without repository activity, so it is the best-effort interim to a monitor polling
every minute. `deploy.yml` runs the probe too, without the issue: pinned to the new versions as its canary, and
unpinned after reading the alerts back.

```
node tools/probe.mjs --base https://license.claudinite.com
```

## Polar products

The `polar-products` workflow makes a Polar organization sell exactly the plans in `billing/plans.json`. Polar gives each product a single billing interval, so every plan is two seat-based subscription products, monthly and yearly, each one fixed price per seat and no benefits, carrying the metadata `claudinite_plan`, `claudinite_interval` and `managed_by: claudinite-licenses`. Every other unarchived product is archived, never deleted, and seat management is turned on in the customer portal. A run that finds nothing to change writes nothing.

A changed price is set on the existing product: Polar archives the old price, existing subscribers keep it, and new checkouts get the new one, so product ids stay put while price ids change.

Dispatch it from Actions with `env` (`sandbox` uses the `POLAR_SANDBOX_TOKEN` secret, `production` uses `POLAR_TOKEN`) and `apply` (off prints the plan only). The job summary lists each product's id and price id. Locally:

```
POLAR_ACCESS_TOKEN=... node tools/polar-products.mjs --env sandbox
POLAR_ACCESS_TOKEN=... node tools/polar-products.mjs --env sandbox --apply
```
