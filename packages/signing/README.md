# packages/signing

The one place the license key format is specified. Every Worker that issues keys and the `cn`
binary that verifies them implement this; `vectors/keys.json` is the case set both replay.

## Certificates

The certificate encoding is ClaudiniteEngine's (`shared/sign`, ClaudiniteEngine#6), whose
`shared/sign/testdata/vectors.json` is the cross-repo contract. In short:
`{"payload": b64(body JSON), "signature": b64(Ed25519("claudinite-cert-v1\n" || body bytes))}`, the
body `{"v":1,"keyId","publicKey","use","issuer","notBefore","notAfter"}` with RFC 3339 UTC times,
uses `manifest`, `packs`, `license`, `license-public`. `b64` is base64url without padding; a key id
is the first 16 hex characters of SHA-256 over the raw 32-byte public key.

Key files are Engine's too: a private key is the base64url 32-byte seed, a public key the base64url
raw 32 bytes, each followed by a newline. The root ceremony (ClaudiniteEngine#5) certifies the
issuing keys with Engine's `cn-keys`; `tools/keys.mjs` here makes development chains only.

`certStanding(notAfter, now)` is what each key Worker's health reports about its own certificate:
the whole days left, and `cert-expiring` once fewer than `CERT_RENEW_DAYS` (14, the design's two
weeks of overlap) remain, `cert-expired` once it has ended.

## Keys

A key's wire form is the JSON text of

```
{"certificate": <certificate>, "payload": b64(key JSON), "signature": b64(Ed25519("claudinite-license-v1\n" || key JSON bytes))}
```

signed by the issuing key the certificate certifies. The payload:

| Field | Value |
| --- | --- |
| `v` | `1` |
| `typ` | `session`, `actions` or `grant` |
| `kid` | the certificate's `keyId` |
| `repo_id`, `owner_id` | numeric GitHub ids |
| `owner_type` | `User` or `Organization` |
| `owner_login` | the owner's login when issued |
| `plan` | `public`, `personal`, `organization` or `internal`; any other plan, the retired `private-repo` among them, is refused for shape |
| `user_id`, `nonce` | session keys only: the GitHub user and the session's nonce |
| `iat`, `exp` | unix seconds |
| `state` | `ok`, `grace`, `degraded` or `unverified` |
| `grace_until` | unix seconds, `null` unless `state` is `grace` |
| `features` | distinct names; only `work-checks`, `forced-skill-loading`, `in-session-growth`, `claudinite-tasks`, `updates` and `fleet` turn a feature on, and any other name is ignored, so the server may add one without an engine release; a Public key carries all but `fleet` |
| `release` | `{"held": [], "revoked": [], "security_fixes": [], "pack_index_serial": 0, "pack_keys": []}`: `held`, `revoked` and `security_fixes` are engine version strings, `pack_index_serial` a non-negative integer, and `pack_keys` the key ids of the accepted pack-index signing certificates |
| `seats` | optional: `null`, or `{"paid", "counted", "headroom"}` of non-negative integers: the licensee's paid seat count, the distinct users counted in the 30-day window including this one, and the headroom |
| `checkout_url` | optional: `null` or an `https` URL, the checkout of the fleet plan the owner can buy |
| `portal_url` | optional: `null` or an `https` URL, the owner's Polar customer portal |
| `issue` | optional, grant keys only: a positive integer, the work item's issue number |
| `notice` | optional: `null` or a non-empty string, what the licensee's seat state asks the binary to say; `over-within-headroom`, `overused` and `seat-refused` have a meaning, and any other name is carried and ignored, as an unknown feature is, so the server may add a notice without an engine release |

The five optional fields are absent or `null` on a key that has nothing to say; a verifier treats
absence as `null`, so a key issued before they existed still verifies.

The key Worker now issues only `actions` keys, each `state` `ok` with `seats` and `notice` `null`
(the license record's decision 60). The other key types, states, the seat counts and the notices
stay in the format, so the vectors and every verifier built before it still read them.

## Verifying a key

In order, the first failure naming the reason:

1. `shape`: the envelope, payload JSON or certificate body is malformed, or a known payload field
   is outside the Keys table: `v`, `typ`, `plan` or `state` not one of its values, `features` not
   distinct non-empty strings, or `release` missing one of its five fields or holding one of the
   wrong type, or `seats`, `checkout_url`, `portal_url`, `issue` or `notice` present, not `null` and
   outside the Keys table. An unknown feature name, release field or payload field is ignored, so the server
   may add one without an engine release; only a name from the Keys table turns a feature on.
2. The certificate, as Engine verifies it, against any trusted root (`untrusted-root`,
   `cert-key-id`, `cert-validity`, `cert-not-yet-valid`, `cert-expired`).
3. `kid-mismatch`: the payload's `kid` is not the certificate's `keyId`.
4. `bad-signature`: the key signature does not verify with the certificate's subject key.
5. `key-not-yet-valid` more than 5 minutes (300 seconds) before `iat`, so a verifier whose clock
   runs behind the issuer's still accepts a fresh key; `key-expired` at or after `exp`.
6. `purpose`: a `license-public` certificate signs only a `public` plan key; a `license`
   certificate signs a key of any plan; `packs` and `manifest` certificates never sign a key.

## Vectors

`vectors/keys.json` is generated by `scripts/gen-vectors.ts` from fixed seeds and times, and the
suite fails when it differs from a fresh generation. Engine's certificate vectors run here too when
`CLAUDINITE_ENGINE_VECTORS` names a copy of that file (or one is committed at `vectors/engine.json`).
