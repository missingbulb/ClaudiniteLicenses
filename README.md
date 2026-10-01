# ClaudiniteLicenses
The license server for Claudinite

## Documents

- [License management design](docs/license-design.md) and its [record](docs/license-record.md).
- The engine design and build plan live in [ClaudiniteEngine](https://github.com/missingbulb/ClaudiniteEngine/tree/main/docs).

## Layout

- `packages/signing`: the license key format and its vectors; its README is the spec.
- `workers/router`, `workers/public-key`: the webhook router and the public key Worker.
- `db/`: the D1 schema and migrations.
- `tools/`: dev key chains, the App webhook re-pointer, a local GitHub API stub, the local round trip.
- `spike/`: the web key spike, run in a Claude Code web session; results in `docs/spikes/`.

## Local verification

```
npm ci
npm run typecheck
npm test
npm run dry-run
node tools/keys.mjs dev-chain --out .dev
node tools/local-roundtrip.mjs
```
