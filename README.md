# ClaudiniteLicenses
The license server for Claudinite

## Documents

- [License management design](docs/license-design.md) and its [record](docs/license-record.md).
- The engine design and build plan live in [ClaudiniteEngine](https://github.com/missingbulb/ClaudiniteEngine/tree/main/docs).

## Layout

- `packages/signing`: the license key format and its vectors; its README is the spec.
- `packages/github-app`: the Claudinite App's GitHub client (App JWT, installation tokens, the key check run), a source package each Worker that acts as the App bundles.
- `workers/router`: the App's one webhook address, forwarding each webhook to the Worker it is for.
- `workers/public-key`: the public key Worker, Public keys for public repos on the web and desktop paths.
- `workers/key`: the paid key Worker, the web, desktop and Actions key paths and `cn login`'s config and refresh.
- `workers/sync`: the sync Worker, D1's only writer, from the App's installation webhooks and a nightly reconcile.
- `db/`: the D1 schema and migrations; `deploy.yml` creates the database and applies them.
- `billing/plans.json`: the paid plans and their prices per seat, read by the Polar products tool and later by the license server.
- `tools/`: dev key chains, the D1 and DNS deploy helpers, the App webhook re-pointer, the Polar products tool, local GitHub and Polar API stubs, the local round trip and its route front (`tools/dev-routes`).
- `spike/`: the web key spike, run in a Claude Code web session; results in `docs/spikes/`.

## Local verification

```
npm ci
npm run typecheck
npm test
npm run dry-run
npm run e2e
```

`npm run e2e` runs every key path against the GitHub stub, the four Workers and a local D1, with
the dev chain in `.dev` (`node tools/keys.mjs dev-chain --out .dev`) or a throwaway one. `npm run
dev` serves the same set on port 8787 until interrupted.

## Polar products

The `polar-products` workflow makes a Polar organization sell exactly the plans in `billing/plans.json`. Polar gives each product a single billing interval, so every plan is two seat-based subscription products, monthly and yearly, each one fixed price per seat and no benefits, carrying the metadata `claudinite_plan`, `claudinite_interval` and `managed_by: claudinite-licenses`. Every other unarchived product is archived, never deleted, and seat management is turned on in the customer portal. A run that finds nothing to change writes nothing.

A changed price is set on the existing product: Polar archives the old price, existing subscribers keep it, and new checkouts get the new one, so product ids stay put while price ids change.

Dispatch it from Actions with `env` (`sandbox` uses the `POLAR_SANDBOX_TOKEN` secret, `production` uses `POLAR_TOKEN`) and `apply` (off prints the plan only). The job summary lists each product's id and price id. Locally:

```
POLAR_ACCESS_TOKEN=... node tools/polar-products.mjs --env sandbox
POLAR_ACCESS_TOKEN=... node tools/polar-products.mjs --env sandbox --apply
```
