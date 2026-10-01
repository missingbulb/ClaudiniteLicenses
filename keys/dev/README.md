# Development keys

Development keys, trusted by no released binary. A stable Engine build refuses to embed the
development roots (`go test -tags stable ./license` in ClaudiniteEngine), so a key signed here
verifies only in a development build of `cn`.

- `roots/root.pub`: a copy of the Engine's `license/roots/` development root (key id
  `4e445e16c1bb8d61`). The tests verify the certificate below against it.
- `license-public.key`, `license-public.pub`: the development `license-public` issuing key (key id
  `c47a2501cf8d3ab0`). This repository is public, so this private key is public; that is
  acceptable only because nothing released trusts its root. The real key never enters this tree.
- `license-public.cert.json`: its `license-public` certificate, issued by the Engine's development
  root for 90 days, until 2026-12-30T14:25:51Z.
- `license.key`, `license.pub`, `license.cert.json`: the development `license` issuing key (key id
  `31c0d966a60bd33a`) and its `license` certificate from the same root, until
  2026-12-30T17:49:26Z, for the paid key Worker.

`deploy.yml` deploys `claudinite-public-key` with the `license-public` key while the repository
secrets `ISSUING_KEY_PRIVATE` and `ISSUING_KEY_CERT` are both unset, and `claudinite-key` with the
`license` key while `KEY_ISSUING_KEY_PRIVATE` and `KEY_ISSUING_KEY_CERT` are both unset, warning
each time. A test skips with a warning once fewer than 14 days remain on either certificate. Until
ClaudiniteEngine#5 lands, renew a certificate before it expires, from an Engine checkout, and commit
the new file (`<use>` is `license-public` or `license`):

```
rm <licenses repo>/keys/dev/<use>.cert.json
go run ./cmd/cn-keys certify --root keys/dev/root.key --subject <licenses repo>/keys/dev/<use>.pub --use <use> --days 90 --out <licenses repo>/keys/dev/<use>.cert.json
go run ./cmd/cn-keys verify --roots license/roots <licenses repo>/keys/dev/<use>.cert.json
```

This folder and `deploy.yml`'s fallbacks to it are removed in the change that sets both pairs of
issuing-key secrets to the ceremony's issuing keys.
