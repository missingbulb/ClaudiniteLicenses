# packages/polar

The Polar API client the sync Worker, the key Worker and the tools share, so each call is written
once. It uses only `fetch` and WebCrypto: a Worker bundles it and Node runs it from `tools/`.
`tools/polar-stub.mjs` answers every call here, and the tests run against it.

## The client

`polarClient({ base, token, version, fetch, timeoutMs, retries })` sends the organization access
token and `Polar-Version: 2026-10` on every call. A refusal is a `PolarError` naming the call and
Polar's status; a call that gets no answer within `timeoutMs` is a `PolarError` whose status is
null. `retries` retries a 429 after Polar's `retry-after` (the tools use 3; the Workers none, since
a key never waits on Polar). `listAll` walks every page.

| Function | Call | Returns |
| --- | --- | --- |
| `listManagedProducts` | `GET /v1/products/?is_archived=false` | the products whose metadata has `managed_by: claudinite-licenses`, by `claudinite_plan`, then `claudinite_interval` |
| `createCheckout` | `POST /v1/checkouts/` | `{ id, url, expires_at }` |
| `createCustomerSession` | `POST /v1/customer-sessions/` | the `customer_portal_url`, or null when Polar has no such customer |
| `listSubscriptions` | `GET /v1/subscriptions/`, every page | every subscription, ended ones included |
| `ensureWebhookEndpoint` | `GET`, `DELETE`, `POST /v1/webhooks/endpoints` | `{ id, kept: true }`, or `{ id, secret, kept: false }` |

`createCheckout` offers both of the plan's products, monthly first, so the buyer picks the interval
on Polar's page. The owner's numeric GitHub id, as a string, is `external_customer_id`; the
metadata holds `claudinite_plan`, `github_owner_id`, `github_owner_login` and `github_owner_type`;
a fleet covers every repo its owner has, so no repo is named. Polar hands the external id and
the metadata back on every subscription it sends, which is how the sync Worker files a subscription
under its GitHub account.

## The webhook endpoint and its secret

`ensureWebhookEndpoint(client, { url, events, rotate })` keeps exactly one `raw` endpoint at `url`
with `api_version` `2026-10`. One already there is kept and its id returned. With none, more than
one, or `rotate`, every endpoint at that url is deleted and a new one created. Polar returns an
endpoint's secret only in the answer to its creation, so whoever calls this with no endpoint, or
with `rotate`, must store the returned secret at once: `tools/ensure-polar-webhook.mjs` writes it to
a file the deploy hands to the sync Worker.

## Verifying a delivery

`verifyWebhook(headers, body, secret, nowS)` follows [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md),
which every secret Polar generated on or after 2026-09-08 uses: `webhook-id`, a
`webhook-timestamp` within 5 minutes of `nowS`, and a `webhook-signature` of space-separated
`v1,<base64>` entries, any one of which must equal HMAC-SHA256 over `${id}.${timestamp}.${body}`
keyed by the base64-decoded secret after its `whsec_` prefix. It returns the parsed event, or the
reason: `signature-missing`, `timestamp-skew`, `signature-mismatch` or `payload-malformed`.
`signDelivery` makes the signature, for the stub and the tests.
