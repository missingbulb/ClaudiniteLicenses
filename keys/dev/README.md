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

`deploy.yml` deploys `claudinite-public-key` with this key, and warns, while the repository
secrets `ISSUING_KEY_PRIVATE` and `ISSUING_KEY_CERT` are both unset. A test skips with a warning
once fewer than 14 days remain. Until ClaudiniteEngine#5 lands, renew the certificate before it
expires, from an Engine checkout, and commit the new file:

```
rm <licenses repo>/keys/dev/license-public.cert.json
go run ./cmd/cn-keys certify --root keys/dev/root.key --subject <licenses repo>/keys/dev/license-public.pub --use license-public --days 90 --out <licenses repo>/keys/dev/license-public.cert.json
go run ./cmd/cn-keys verify --roots license/roots <licenses repo>/keys/dev/license-public.cert.json
```

This folder and `deploy.yml`'s fallback to it are removed in the change that sets
`ISSUING_KEY_PRIVATE` and `ISSUING_KEY_CERT` to the ceremony's issuing key.
