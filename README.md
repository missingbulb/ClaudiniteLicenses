# ClaudiniteLicenses
The license server for Claudinite

## Documents

- [License management design](docs/license-design.md) and its [record](docs/license-record.md).
- The engine design and build plan live in [ClaudiniteEngine](https://github.com/missingbulb/ClaudiniteEngine/tree/main/docs).

## Layout

- `packages/signing`: the license key format and its vectors; its README is the spec.
- `packages/licensing`: the fleet rule (which plan an owner's subscriptions pay for), the checkout plan by owner type, and the writes queue's messages, bundled by the key and sync Workers.
- `packages/polar`: the Polar client (checkouts, customer sessions, subscriptions, webhook endpoints) and the Standard Webhooks check.
- `packages/github-app`: the Claudinite App's GitHub client (App JWT, installation tokens), a source package the sync Worker and the tools that act as the App bundle.
- `packages/http`: what each Worker does to a request before spending anything on it: the per-address cap (`IP_LIMIT`), the 16 KiB and 1 MiB body caps, and the engine version's 64-character cut.
- `packages/version`: the `X-Claudinite-Version` header every Worker puts on each answer, from its `version_metadata` binding.
- `workers/key`: the key Worker, the Actions key a fleet manager's run asks for, carrying the fleet its owner pays for.
- `workers/sync`: the sync Worker, D1's only writer and the App's one webhook address: repos from the App's installation webhooks and a nightly reconcile, subscriptions from Polar's webhooks and reconcile, incidents from the writes queue.
- `db/`: the D1 schema and its migrations; `deploy.yml` creates the database and applies them.
- `billing/plans.json`: the two fleets and their prices, Personal flat and Organization per seat, read by the Polar products tool.
- `tools/`: dev key chains, the D1, queue, DNS and Polar webhook deploy helpers, a Polar checkout maker, the App webhook re-pointer, the Polar products tool, the outside probe (`tools/probe.mjs`), the staged deploy's version tool (`tools/stage.mjs`), the retired Workers' remover (`tools/retire-workers.mjs`), the D1 restore rehearsal (`tools/d1-restore-rehearsal.mjs`), local GitHub and Polar API stubs, the local round trip and its route front (`tools/dev-routes`).

## Local verification

```
npm ci
npm run typecheck
npm test
npm run dry-run
npm run e2e
```

`npm run e2e` runs the Actions key path for a User and an Organization, with and without a fleet,
against the GitHub and Polar stubs, the two Workers, the local writes queue and a local D1, then an
incident from a slow Polar, the alerts firing and clearing and the outside probe, with
the dev chain in `.dev` (`node tools/keys.mjs dev-chain --out .dev`) or a throwaway one. `npm run
dev` serves the same set on port 8787 until interrupted.

## Deploying

`deploy.yml` runs on every push to `main`. It records D1's restore point before the migrations,
uploads a new version of the key Worker with its secrets without serving it, deletes the retired
`claudinite-router` and `claudinite-public-key` Workers when they are still there, deploys the sync
Worker at once with its secrets file and judges it by its health, a message it
pushes onto the writes queue that the consumer must write on the deployed version, and its alerts,
then serves the new
key Worker version to one tenth of requests. The canary probe (`tools/probe.mjs --expect-version`)
reaches it through Cloudflare's version-affinity header and must pass on it; it is then promoted to
all requests and both Workers' routes and crons applied. A failed canary, promotion or read-back
rolls the key Worker back to the version that was live when the run started, so a run ends either
with the new version passing from outside or with the previous one live and the run red.

The account gets a real percentage split: the first staged deploy (run 36927209537) served each new
version at 10% beside the live one at 90%, never `stage.mjs split`'s 100% fallback. The sync Worker
deploys at 100% with `wrangler deploy --secrets-file`, so its secrets travel with its version as the
key Worker's do and no step runs `wrangler secret bulk`. Its cron and queue versions are stamped into `/v1/sync/health`
(`last_cron_version`, `last_queue_version`); whether it can join the split is still open
(`workers/sync/README.md`).

The run summary carries the restore point as the exact dispatch that returns D1 to it, inside the
Time Travel window of 7 days on Workers Free or 30 on Workers Paid:

```
gh workflow run d1-restore.yml -f bookmark=<bookmark from the summary>
```

A restore is in place and reverts every row written after the bookmark; see `db/README.md` before
running it. The `rehearse_d1_restore` dispatch input runs the same restore command on a throwaway
database first, with read replication on.

Right after the rehearsal step, `Turn on D1 read replication when D1_READ_REPLICATION says so`
reads D1's read replication mode and writes it to the summary. It changes the mode only when the
repository variable `D1_READ_REPLICATION` is `auto`. The variable stays unset until a
`rehearse_d1_restore` run, which waits on the owner's approval, has proven the restore on a
replicated database (`db/README.md`). The read-back requires `/v1/key/health` to carry
`d1_served_by_primary`, `d1_served_by_region` and `d1_ms`, then reads the mode by lookup alone,
never creating a database, and prints the mode and the three fields to the summary. While the
variable is `auto`, both steps require the mode `auto` and fail otherwise. While it is unset or
`off`, a mode that is missing or unknown only warns, because the API reference makes
`read_replication` optional and a failed read-back would roll back a healthy release.

The read-back proves the per-address cap is wired: the key Worker's health answer, and the sync
Worker's in its own judge, report `ip_limit: counted`, what the cap made of that very
read, so the live version carries the binding and its route calls it. It then observes the cap from
outside, 400 reads of `/v1/key/health` paced eight a second across 50 seconds, and warns, never
fails, when no 429 carrying a version header comes back: Cloudflare's limiter is per
location, permissive and eventually consistent, so meeting no 429 is no verdict on the release. It
then waits a minute for the window to clear before the final
probe. The canary probe's pinned walks can meet the cap too once both versions carry it; it waits
out a 429 `rate-limited` and asks again rather than failing.

`Read back the key counts`, after the D1 read-back, reads the key counts dataset with
`tools/key-counts.mjs`. It first looks for the one point the read-back's own `actions-key` refusal
wrote (engine version `deploy-read-back`, this repository's id), asking for about 95 seconds, then
prints the last 7 days' counts by plan, outcome and path to the summary's `## Key counts` section.
A token without `Account Analytics: Read` prints `unavailable` there and warns, naming #30; a
dataset no point has created yet, a point not yet queryable, and the tool itself failing each only
warn too. The step runs after promotion and reads, never judges, so it never fails the deploy.
Anyone holding a token with that permission can read the same counts:

```
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node tools/key-counts.mjs --since 7d --group plan,outcome,path
```

`--probe` only says whether the token can read and the dataset exists; `--json` and `--markdown`
change the output; `--repo-id` and `--engine-version` narrow it.

Two rules keep this safe:

- Migrations are additive, so the version a rollback returns to still reads the schema
  (`db/test/migrations-additive.test.ts`). `0005_fleets_only.sql` is the one exception, named there
  with its reason (`db/README.md`).
- A split left standing by an interrupted run is rolled back by hand before the next deploy, which
  refuses to stack on it:
  `node tools/stage.mjs rollback --config workers/<worker>/wrangler.jsonc --id <the version that should be live>`.

## The outside probe

Each Worker judges its own health and the sync Worker judges the shared state, so three URLs on
`license.claudinite.com` answer a non-200 while anything is wrong: `/v1/key/health`,
`/v1/sync/health` and `/v1/sync/alerts`, to `GET` or `HEAD`. An HTTP monitor polling them needs no
API key.

`tools/probe.mjs` checks the same from outside Cloudflare, plus the App webhook's signature check on
the sync Worker, Polar's webhook refusing an unsigned delivery and, with an OIDC token, the Actions
verifier and pin; the key health check also requires `ip_limit: counted`, so a version without its
per-address cap fails the canary at one tenth. The `key-health` row carries the health's `d1_served_by_primary`,
`d1_served_by_region` and `d1_ms`, each `null` when absent, without judging them. The `probe`
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

The `polar-products` workflow makes a Polar organization sell exactly the plans in `billing/plans.json`: the Personal fleet at a flat price (`price`) and the Organization fleet per seat (`price_per_seat`). Polar gives each product a single billing interval, so every plan is two subscription products, monthly and yearly, each with one price and no benefits, carrying the metadata `claudinite_plan`, `claudinite_interval` and `managed_by: claudinite-licenses`. Every other unarchived product, the retired Private repo products among them, is archived, never deleted, and seat management is turned on in the customer portal. A run that finds nothing to change writes nothing.

A changed price of the same kind is set on the existing product: Polar archives the old price, existing subscribers keep it, and new checkouts get the new one, so product ids stay put while price ids change. A managed product whose price is of the other kind, flat where the plan is per seat or the reverse, is archived and a new product made in its place.

Dispatch it from Actions with `env` (`sandbox` uses the `POLAR_SANDBOX_TOKEN` secret, `production` uses `POLAR_TOKEN`) and `apply` (off prints the plan only). The job summary lists each product's id and price id. Locally:

```
POLAR_ACCESS_TOKEN=... node tools/polar-products.mjs --env sandbox
POLAR_ACCESS_TOKEN=... node tools/polar-products.mjs --env sandbox --apply
```
