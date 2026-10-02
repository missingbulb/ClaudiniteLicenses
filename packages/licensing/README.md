# packages/licensing

The license design's seat rules as pure functions, and the write messages the key Worker queues.
The key Worker and the sync Worker each bundle this package, so the verdict a key carries and the
rows the sync Worker writes follow one definition. Nothing here reads or writes anything: the
callers pass the rows.

## Who a seat belongs to

`licenseeOf(plan, ownerId, repoId)` is the id `seats` rows are keyed by: the repo under
`private-repo`, where a seat is one person in one repo, and the owner under `personal`,
`organization` and `internal`. The `overuse` row is always keyed by the owner, since the grace clock
and the 30 days without a new grace belong to the paying account.

## Paid seats and headroom

`paidSeats(subscriptions, now, { plan, repoId })` sums `seats` over the owner's rows of that plan,
counting a row while its `status` is `active`, `trialing` or `past_due` and its `ended_at` is null,
and a `private-repo` row only when its `repo_ids` name the repo. A cancelled row keeps paying until
Polar ends it; a revoked one has `ended_at` set and pays nothing.

`headroom(paid)` is `max(1, ceil(paid / 10))`, and `0` for a licensee paying for nothing.

`planFeatures(plan)` is every feature but `fleet` for `public` and `private-repo`, and every feature
for `personal`, `organization` and `internal`.

## Seats and overuse

`resolveSeats({ plan, paid, seatRows, userId, overuse, now })` applies the design's rules to one
licensee. `seatRows` count only while their `last_key_at` is within 30 days; they are ranked by
`first_key_at`, then `user_id`. The caller's rank is its row's place, or one past the rows when it
has none, and it is seated when its rank is within `paid`. With `userId` null, as for an Actions
key, only the rows count and nobody is seated.

1. **Within the paid count** (`counted ≤ paid`): `ok`. A grace start still stored asks for a
   `grace-reset` write.
2. **Within headroom** (`counted ≤ paid + headroom`): `ok`, notice `over-within-headroom`. A
   licensee back within headroom but still over the paid count keeps its grace start, so going
   over headroom again resumes the same clock; only dropping within the paid count resets it.
3. **Over headroom, grace**: with a grace start under 7 days old, `grace` until start + 7 days,
   notice `overused`. With no start and no spent grace (`grace_spent_until` null or past), `grace`
   until now + 7 days and a `grace-start` write: the first key beyond headroom starts the clock and
   assumes the start it asks for.
4. **After grace**: the seated stay `ok` (notice `overused`); the rest are `degraded`, notice
   `seat-refused`, with no features.
5. **Back within the count** clears the start (rule 1); `grace_spent_until`, 30 days after the start,
   stays, so a licensee over again before then goes straight to rule 4.

`ok` and `grace` carry `planFeatures(plan)`; `degraded` carries none.

## Write messages

`WriteMessage` is `{ v: 1, kind, at, … }`, `kind` one of `usage` (`repo_id`, `user_id`, `owner_id`,
`plan`, `day`), `grace-start` and `grace-reset` (`owner_id`), and `incident` (`marker`, and an
optional `detail` of at most 200 characters, no `owner_id`). An incident's `marker` is one of
`INCIDENT_MARKERS`: `d1-unreadable`, `polar-unreachable`, `app-not-installed`,
`polar-webhook-refused`, `write-dead-lettered`, `secondary-rate-limit`, `deploy-read-back`, and the
`RECONCILE_MARKERS` `reconcile-now` and `polar-reconcile-now`; the alerts count none of
`deploy-read-back`, the message every deploy pushes to prove the queue's consumer, or the reconcile
requests, which have the sync Worker's consumer run its GitHub or Polar reconcile at once. `isWriteMessage` checks a queued body and refuses an unknown marker. `dayOf(at)` is the UTC
day `usage` rows are keyed by.
