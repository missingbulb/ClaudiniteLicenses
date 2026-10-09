# packages/licensing

The license design's fleet rule as pure functions, and the write messages the key Worker queues.
The key Worker and the sync Worker each bundle this package, so the plan a key carries and the rows
the sync Worker writes follow one definition. Nothing here reads or writes anything: the callers
pass the rows.

## The fleet an owner pays for

`fleetPlan(ownerId, ownerType, subscriptions)` is the plan the owner pays for, or null: `internal`
first, for an owner in `INTERNAL_OWNERS` (Claudinite's own accounts by GitHub id, `missingbulb` today,
granted with no Polar row) or with an internal row, then `personal` for a `User` owner and `organization` for an `Organization` owner.
A row pays while its `status` is `active`, `trialing` or `past_due` and its `ended_at` is null; a
cancelled row keeps paying until Polar ends it, and a revoked one has `ended_at` set. Its seat count
is never read: a fleet covers every repo the owner has, and Polar's seats on the Organization fleet
are billing alone. A `personal` row on an Organization owner, or an `organization` row on a User,
pays for nothing.

`checkoutPlanFor(ownerType)` is the fleet that owner can buy: `personal` for a `User`,
`organization` for an `Organization`.

`planFeatures(plan)` is every feature but `fleet` for `public`, and every feature for `personal`,
`organization` and `internal`.

## Write messages

`WriteMessage` is `{ v: 1, kind: "incident", at, marker, detail? }`, `detail` at most 200
characters. `marker` is one of `INCIDENT_MARKERS`: `d1-unreadable`, `polar-unreachable`,
`app-not-installed`, `polar-webhook-refused`, `write-dead-lettered`, `deploy-read-back`, and the
`RECONCILE_MARKERS` `reconcile-now` and `polar-reconcile-now`. The alerts count none of
`deploy-read-back`, the message every deploy pushes to prove the queue's consumer, or the reconcile
requests, which have the sync Worker's consumer run its GitHub or Polar reconcile at once.
`isWriteMessage` checks a queued body and refuses any other kind or an unknown marker.

## Key counts

`KEY_COUNT_BLOBS` is the blob order of the point the key Worker writes into the
`claudinite_key_counts` Analytics Engine dataset, and `keyCountBlobs` builds one.
