> Approved by Ariel on 2026-10-01. Source: [Claude Doc](https://claude.ai/code/artifact/7baa2177-0a09-4d4d-ba90-e95182350d38). This repo copy is now the canonical version; change it here. Rewritten for fleets-only billing on 2026-10-05, decision 60 of the [record](license-record.md).

# ClaudiniteEngine license management

Sep 30, 2026 · @Ariel Raunstien · revised Oct 5, 2026

One repo, public or private, is free, and the engine asks the license server for nothing when it runs in one. What is sold is the fleet: one repo managing many with Claudinite's fleet management and canon curation. A fleet manager's GitHub Actions run asks the license server for a short-lived key, and the key says whether the repo's owner pays for a fleet. This document replaces the Licensing section of the [ClaudiniteEngine design](https://claude.ai/code/artifact/0b92671a-39a4-4f36-ac26-8c81f4e9b5eb); the decisions, research and alternatives behind it are in the [record](license-record.md).

## At a glance

| Plan | Bought by | Covers | Price | Polar product |
| --- | --- | --- | --- | --- |
| One repo | Nobody; free | Any one repo, public or private, without a fleet | Free | None |
| Personal fleet | A personal GitHub account, never an organization | Fleet management for every repo the account owns | $9 a month or $90 a year, flat, no seats | `personal`, monthly and yearly |
| Organization fleet | A GitHub organization | Fleet management for every repo the organization owns | $99 per user a month or $990 a year, the user count being the seats bought in Polar | `organization`, monthly and yearly |
| Enterprise | Through sales only | Agreed per customer | Agreed per customer | None |

The license server counts no users. An Organization fleet's seats are what the organization buys and changes in Polar's portal; the server reads them for the record and enforces nothing by them. Claudinite's own canary repos hold an `internal` plan, so they get keys like any fleet.

## Who asks for a key

Only a fleet manager does, and only from GitHub Actions. A repo on its own makes no license request: no Claude session asks for a key, and neither does a repo's own Actions run unless it runs fleet management. There is no session key, no item grant and no `cn login` any more, and nothing waits on the license server inside a Claude session.

A fleet manager's run that is about to do fleet work requests a GitHub OIDC token with audience `claudinite` and exchanges it at `POST /v1/actions-key` for an Actions key. The server takes the repo and its owner only from the token's claims, pins `job_workflow_ref` to the member's scheduler, executor and update workflows on the default branch, and refuses tokens from `pull_request` and `pull_request_target` runs. Any other trigger is accepted. The server pins those workflow files by name, so the names are part of the protocol: renaming one needs a server release that accepts the new name first.

## What the key says

A key is a small signed statement from the license server, verified offline by the binary with the public root key it embeds. An Actions key lasts 6 hours and carries the key id and its certificate, the repo id, the owner's id, type and login, the plan, the state, the features it turns on, the engine release states the update needs (held and revoked engine versions, which releases are security fixes, the current pack index serial and the pack signing keys the member accepts), and two links. The [release testing design](https://claude.ai/code/artifact/f2b744d0-f95d-4a65-a6e2-45434b3e9aef) owns what the release states mean.

**The plan is the owner's fleet.** The server reads the owner's subscriptions and takes, in order:

1. `internal`, for an owner with a paying internal row, of either type;
2. `personal`, when the repo's owner is a GitHub user with a paying Personal fleet row;
3. `organization`, when the repo's owner is an organization with a paying Organization fleet row;
4. otherwise the no-fleet answer, plan `public`.

A row pays while its status is active, trialing or past due and Polar has not ended it, so a cancelled subscription keeps its fleet to the end of the paid period. A Personal row on an organization, or an Organization row on a personal account, pays for nothing. The owner's type is the one the sync Worker read from GitHub.

**Every key is `ok`.** A fleet plan carries every feature, `fleet` included; the no-fleet answer carries every feature but `fleet`. There is no grace, no degraded state and no seat count on a key. The no-fleet answer also carries `checkout_url`, a Polar checkout of the fleet the owner's type can buy, and, when the owner has any subscription, `portal_url`, its customer portal. A fleet key carries neither, and asks Polar nothing. The server computes the features from the plan, so a pricing or policy change needs no engine release.

**When the key cannot be obtained** because the server or GitHub does not answer, the engine fails open: the run goes on unverified and says so. A refusal is an answer, and a refused run skips its fleet work and reports why; the engine owns that report. The server refuses a repo the Claudinite App is not installed on (`app-not-installed`) and one whose default branch or owner type it has not read yet (`repo-not-synced`), and answers 503 rather than guessing when its database cannot be read.

## Billing through Polar

Polar sells both fleets and is the merchant of record: it is the seller to the buyer, invoices in its own name, and handles sales tax, VAT, refunds and chargebacks ([Polar merchant of record](https://polar.sh/docs/merchant-of-record/introduction)). It only bills; which plan a key carries stays in the license server, which reads nothing from Polar but a plan per GitHub account.

| Plan | Polar product | What the buyer buys |
| --- | --- | --- |
| Personal fleet | A fixed price, monthly and yearly | The fleet, at one flat price |
| Organization fleet | Seat-based, monthly and yearly | Seats, one per user, set and changed by the buyer |

A Polar product has a single billing interval, so each fleet is two products, monthly and yearly, told apart by their `claudinite_plan` and `claudinite_interval` metadata. The prices live in `billing/plans.json`, and the `polar-products` workflow makes each Polar organization match it, archiving every product it does not list. Enterprise has no product.

**Buying.** The buyer never types an account or organization name, and Polar never matches one. Every checkout is created by the license server for the owner whose key carries its link, with the fleet's two products, the owner's numeric GitHub id as the customer's external id, and metadata naming the owner's login and type; a fleet covers every repo the owner has, so no repo is named. Polar hands the external id and metadata back on every subscription webhook, and the server files the subscription under that GitHub account. Anyone can pay through a link, but paying only buys the fleet for the account it names.

**Changing seats and cancelling.** The buyer uses Polar's hosted customer portal, with seat management turned on and added seats charged pro rata at once ([seat-based pricing](https://polar.sh/docs/features/seat-based-pricing)). Polar's own seat assignment by email is not used.

**Events.** Polar's webhooks `subscription.created`, `.updated`, `.active`, `.canceled`, `.uncanceled`, `.revoked` and `.past_due` update the subscriptions table, looked up by the customer's external id. A cancellation keeps the fleet to the end of the period; a revocation, after cancellation or exhausted payment retries, ends it at once, and the owner's next key is the no-fleet answer. Nothing in the member repo is deleted: paying again restores the fleet at the next key.

**Keeping the table right.** Only the sync Worker writes the subscriptions table, from two sources: Polar's subscription webhooks, which it verifies by signature, and the nightly reconcile, which lists every subscription through Polar's API. Each write stores the whole subscription as Polar sent it, keyed by Polar's subscription id, and is skipped when it is older than the stored row by Polar's own modified time, so a duplicate, retried or out-of-order webhook cannot leave a wrong row, and the reconcile overwrites any row that still differs from Polar. [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) restores the whole database to any minute of its window. A short failure on our side only delays updates, since Polar retries webhook deliveries and the reconcile catches what they miss. A long one is what the alerts catch: `GET /v1/sync/alerts` answers 503, which the outside probe pages on, when the last reconcile is more than 26 hours old, when webhooks fail repeatedly, when the oldest write waiting in the queue is more than 15 minutes old, when a reconcile had to correct a row, or when an account that pays has no repo the App covers.

**When Polar is down.** Issuing a key never waits on Polar: the plan comes from the server's own subscriptions table, and a link Polar does not give within 3 seconds is left out, so a fleet key is unaffected and a no-fleet key arrives without its checkout link. New checkouts and portal changes fail until Polar is back, and subscription changes reach the table late, when their webhooks arrive or the reconcile finds them.

**Not sold through Polar.** Enterprise, for customers who must pay by bank transfer or on invoice terms, which Polar does not offer, or who run GHE.com or GitHub Enterprise Server: sales only. GitHub Marketplace is a possible later channel; a paid listing needs 100 installations of the App first. The subscriptions table keeps a source column so a second channel can feed it without changing the license server.

## The license server

The license server is two Cloudflare Workers sharing one D1 database, built and deployed from their own private repo, ClaudiniteLicenses, which also holds the D1 schema and its migrations, the queue configuration and the outside probe. Its deploy workflow alone holds a Cloudflare API token scoped to those resources, and the signing keys are Worker secrets that never live in a repo.

The **key Worker** issues Actions keys. It holds the `license` issuing key, only reads D1, and hands every incident it reports to a Cloudflare Queue, so it writes nothing itself. The **sync Worker** keeps the data current. It holds the App's credentials and webhook secret and Polar's API token and webhook secret, receives the App's webhooks at the App's one webhook address and Polar's webhooks, runs the nightly reconciles, consumes the queue, and is the only writer of D1. It holds no signing key, so it can never issue one. Neither calls the other.

**What it keeps.**

| Table | One row per | Holds |
| --- | --- | --- |
| Subscriptions | Polar subscription | Owner id and type, plan (`personal`, `organization` or `internal`), Polar's seat count, source, period end, pending cancellation, status, end time, product and interval, and the subscription as Polar sent it |
| Repos | Repo the App is installed on | Repo id, full name, owner id, type and login, visibility, installation, default branch |
| Signing keys | Key id | The public key, its certificate from the root key, validity dates |
| Incidents | Occurrence of an alert marker | The marker, its time and a short detail, pruned after 7 days |
| Sync state | Stamp | When each webhook, reconcile, queue batch and cron last succeeded, and the coverage count |

The number of keys issued is counted in Workers Analytics Engine, one point per key request, by plan, outcome, owner type, engine version and path.

**What it answers.**

| Call | From | Verifies the caller by | Returns |
| --- | --- | --- | --- |
| `POST /v1/actions-key` | A fleet manager's Actions run | The GitHub OIDC token's signature and claims, and the workflow pin | An Actions key |
| `POST /github-webhook` | GitHub, the App's `installation`, `installation_repositories` and `repository` events | The HMAC over the body with the App's webhook secret | The sync Worker updates repos |
| `POST /v1/sync/polar-webhook` | Polar | Polar's Standard Webhooks signature | The sync Worker updates subscriptions |
| `GET` or `HEAD` on `/v1/key/health`, `/v1/sync/health` and `/v1/sync/alerts` | Monitors, the probe, the deploy | Nobody | Each Worker's own judgement, 503 while anything is wrong |
| Nightly reconciles | Their own cron | Not applicable | The sync Worker re-reads every installation and every Polar subscription and repairs missed events |

The App needs metadata read and the installation events; it never needs Contents write or Checks write.

### How it stays up

There is no machine of ours: the Workers run in every Cloudflare data center that receives a request, and D1 has one primary copy that takes every write and read replicas near the Workers ([D1 read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)).

1. **Keys are checked offline.** The binary verifies every key with the root it embeds, so nothing already issued depends on the server.
2. **Issuing a key never waits on a write.** The key Worker decides from reads alone, through one D1 session per request that the nearest replica may serve; its incidents go onto the queue, which the sync Worker writes.
3. **Deploys cannot take it down at once.** The two Workers deploy separately. A new key Worker version serves one tenth of requests until the outside probe has passed against it by version, then all of them, and is rolled back when it fails; the sync Worker deploys at once and is judged by its own health and alerts and by the queue consumer writing a message the deploy pushes. An outside probe checks the live Workers every quarter hour and keeps a standing issue while it fails.

What remains is an outage of Cloudflare's Workers platform or of GitHub. During either, fleet keys already issued keep working until they expire, and a fleet run that cannot get one goes on unverified, since the engine fails open on an unanswered check.

**Capacity.** Only fleet managers' Actions runs ask for keys, a handful per run, so the load is a small fraction of the per-session design this replaces and well inside the Workers Paid allowances. The per-address cap of 300 requests a minute and the per-owner limit of 600 a minute stand in front of D1.

## Signing keys, rotation and security

Every binary ever released can verify every key the server will ever issue, because the binary trusts one long-lived root key rather than the key that signs licenses.

1. **The root key** is embedded in every binary, with one standby root for emergencies, generated and stored apart from it; the binary accepts issuing keys certified by either. Its private half is kept offline and is used only to certify issuing keys.
2. **The issuing key** signs Actions keys. It is a secret of the key Worker alone, valid for 90 days with two weeks of overlap, and certified by the root with a purpose of `license`, which signs a key of any plan. Every key carries its issuing key's certificate, so the binary checks the certificate against the root and the key against the certificate. Rotating it needs no engine release. The `license-public` purpose stays in the certificate format, signing only `public` plan keys, though no Worker holds such a key any more.
3. **The pack index key** is a separate issuing key certified with a purpose of `packs`, held only by the ClaudinitePacks release workflow. The binary refuses a license key used on a pack index, or a pack key used on a license.

**If the root itself is compromised,** we certify new issuing keys with the standby root, which every binary already accepts, and publish a release that drops the compromised root and embeds a fresh standby.

**Abuse limits.**

| Risk | Control |
| --- | --- |
| A key copied into another repo | Keys bind the repo id; the binary compares it with the repo it runs in, and the server issues only for repos the App is installed on |
| A fork's pull request mints an Actions key | OIDC tokens from `pull_request` and `pull_request_target` are refused, and `job_workflow_ref` must name the member's workflow on its default branch |
| An organization's repo takes the cheaper Personal fleet | The plan follows the owner's type as GitHub reports it: a Personal row on an organization pays for nothing |
| Someone patches the binary | Accepted, as for any offline-verified tool; the server still sees every key it issues |
| A flood of unauthenticated requests spends D1 or Polar | Every unauthenticated route but the App's webhook meets a per-address cap before it touches either; the key Worker's per-owner limit stands behind it for authenticated callers |
| Unsigned deliveries to the webhook routes | The App's webhook refuses any delivery whose HMAC does not match before reading the payload; Polar's refuses before any write past the per-address cap, and the refusals it records are capped per hour |

## What changes in the ClaudiniteEngine design

| Engine design before | Becomes |
| --- | --- |
| Every Claude session gets its own key: web sessions through a `repository_dispatch` answered with a check run, desktops through `cn login` | No session asks for a key. A repo on its own runs without any license request |
| Seats counted per user over 30 days, with headroom, a 7-day grace and a degraded state | No seat counting, grace or degraded state: a key is `ok`, with or without the `fleet` feature |
| Four plans: Public, Private repo, Personal, Organization | One repo free; the Personal and Organization fleets paid; Enterprise through sales |
| Routine sessions verify an item grant the executor passes | No item grants |
| Actions keys for the scheduler, executor and update workflows | The same Actions path, asked only by a fleet manager's fleet work |

The command is `cn`, as Ariel asked, wherever the engine design says `claudinite`. Adoption stays free.
