> Approved by Ariel on 2026-10-01. Source: [Claude Doc](https://claude.ai/code/artifact/7baa2177-0a09-4d4d-ba90-e95182350d38). This repo copy is now the canonical version; change it here.

# ClaudiniteEngine license management

Sep 30, 2026 · @Ariel Raunstien

Every Claude session and every repo's GitHub Actions asks the license server for its own short-lived key, so the server sees each person who works with Claudinite and can hold a paid license to the number of people it pays for. This document replaces the Licensing section of the [ClaudiniteEngine design](https://claude.ai/code/artifact/0b92671a-39a4-4f36-ac26-8c81f4e9b5eb); the research, decisions and rejected alternatives behind it are on the Record tab.

## At a glance

There are four plans. Every plan checks licenses, including the free one, because the server counts users on every repo.

| Plan | Bought by | Repos covered | Seats counted across | Packs | Fleet management and local canon curation | Price basis |
| --- | --- | --- | --- | --- | --- | --- |
| Public | Nobody; free | Any public repo, each on its own | Counted, never capped | Global and local | No | Free |
| Private repo | A personal account or an organization | The private repos chosen when installing the App, each licensed on its own | Each repo separately | Global and local | No | Per repo, per user, per month |
| Personal | A personal GitHub account | Every repo the account owns | All of the account's repos together | Global and local | Yes | Per user, per month |
| Organization | A GitHub organization | Every repo the organization owns | The whole organization | Global and local | Yes, plus enterprise features | Per user, per month |

A user is one GitHub account. A person who works in three repos under a Personal or Organization plan takes one seat; under a Private repo plan each repo is its own license, so the same person takes a seat in each.

## Keys and who counts as a user

A key is a small signed statement from the license server that says who may use which Claudinite features in one repo, for a short time. The binary verifies it offline with the public root key it embeds, so a key needs no network to check, only to obtain.

| Key | Obtained by | Proves who | Lifetime | Takes a seat |
| --- | --- | --- | --- | --- |
| Session key | Each Claude session, at SessionStart, for the repo it runs in | The GitHub user the session acts as | 7 days, fetched in the background at session start and renewed once it is a day old | Yes, under paid plans on private repos |
| Actions key | Each GitHub Actions run that is about to do Claudinite-specific work | The repo and its owner, through GitHub's OIDC token | The run, at most 6 hours | No; all of a customer's Actions runs are one principal |
| Item grant | The executor, for each work item it hands to a Claude Code Remote routine session | The work item and the Actions key it came from | The item, at most 6 hours | No |

What a key carries: the key id and its certificate, the repo id, the owner id, the plan, the GitHub user id (session keys only), the session's nonce, the issue and expiry times, the license state (`ok`, `grace` with its end date, or `degraded`), the list of features it turns on, and the engine release states the update needs: held and revoked engine versions, which releases are security fixes, the current pack index serial, and the pack signing keys the member accepts. Carrying these in the key replaces a separate signed engine index; the [release testing design](https://claude.ai/code/artifact/f2b744d0-f95d-4a65-a6e2-45434b3e9aef) owns what they mean. Claudinite's own canary repos hold an internal plan, so they get keys like any member. The server computes the features from the plan and the state, so a pricing or policy change needs no engine release.

**A user is one GitHub account, counted by numeric id.** GitHub is the one identity every place Claudinite runs already signs in with, and a numeric id survives renames. A user holds a seat from their first session key in a licensed private repo until 30 days pass without one; seats free themselves, so nobody has to remember to release a contractor.

- The same person in twenty sessions, on a web VM and a desktop, is one seat.
- Under a Personal or Organization plan a person is one seat across every repo of that account. Under a Private repo plan a seat is one person in one repo, so the same person in two licensed repos is two seats.
- Activity in public repos never takes a paid seat, even under a paid plan. It is still counted, so we know how many people use each public repo.
- Actions runs, item grants, and sessions the executor starts are never seats.

The window is 30 days because every paid plan bills monthly; a seat is a monthly active user.

## How each place gets its key

A web session cannot call the license server, so it asks through GitHub; a desktop and GitHub Actions call the server directly. A Claude Code web VM on the default Trusted network reaches GitHub, npm and a fixed list of hosts, and nothing of ours; no organization-wide setting can add a host ([cloud environments](https://code.claude.com/docs/en/cloud-environments)). What it does reach is the GitHub API for its own repo, with the user's real GitHub credential swapped in by the VM's proxy, so a request it makes there arrives at GitHub as that person. That the proxy lets a dispatch request through is inferred, not yet run; a spike proves it before the build.

&#91;embedded content: web session key request · 4 steps\]

### A Claude Code web session

1. SessionStart runs the binary. It reads the session's GitHub user with `GET /user` through the proxy, as the web-users-support pack does today, and makes a random nonce.
2. It sends `POST /repos/{owner}/{repo}/dispatches` with event type `claudinite-key` and a payload of the nonce, the engine version and the remote head commit of the default branch, which exists on GitHub even when the session's own work is unpushed. The session starts at once with every feature on while the answer is on its way.
3. GitHub delivers the `repository_dispatch` webhook to the Claudinite GitHub App. Its `sender` is the person, attributed by GitHub, so nothing the session says about itself is trusted; a sender of type Bot is refused.
4. The license server checks the repo's visibility, the owner's plan and the seat count, and answers by creating or updating one check run named `Claudinite key` on that commit, one per user per commit, with the signed key in its output and a neutral conclusion, so it never gates a pull request.
5. SessionStart does not wait for that check run. It starts a background process that looks for the check run every half second and writes the key into the session's state file, and returns at once. The binary verifies the signature, that the user id is the one `GET /user` returned, and that the nonce is its own. From then on every hook applies the key's features. When the server refused a seat, that hook tells Claude to tell the person why and who can fix it.

### A desktop, or a Remote Control session

The first session on a machine runs `cn login`, a GitHub device-flow sign-in to the Claudinite App: one browser step per machine. The binary keeps the App's user token (8 hours, refreshed for 6 months) in its cache folder, mode 0600, and calls the license server directly with it; the server reads the user from GitHub, never from the caller. Keys are cached per repo and user, so a desktop that goes offline keeps working on its last key.

### GitHub Actions

A run that is about to do Claudinite-specific work requests a GitHub OIDC token with audience `claudinite` and exchanges it for an Actions key. The server takes the repo, owner and visibility only from the token's claims, pins `job_workflow_ref` to the member's scheduler, executor and update workflows on the default branch, and refuses tokens from `pull_request` and `pull_request_target` runs. Any other trigger is accepted, including the executor's label trigger. CI checks and project tasks need no key, so most runs never ask.

### Work the executor hands to a routine session

The executor's agentic phase runs in a Claude Code Remote routine session. When the executor hands an item to a routine session, it asks the server for an item grant with its Actions key and posts the grant as a comment on the item's issue. A routine session knows it is one because Claude Code marks it unattended (\`CLAUDE\_CODE\_SESSION\_ATTENDED=0\`); it then sends no key request, so it never takes the routine owner's seat. It finds the issue from the item reference in its fire prompt, reads the grant through the GitHub API and verifies it. The prompt is untrusted, but the grant is signed and names its repo and issue, so a wrong pointer finds nothing valid and the session runs degraded. Grants are issued under a degraded Actions key too, carrying that key's features, so project tasks keep running. Unattended work therefore never takes a seat.

### Key state within a session

**Session start never waits for the key.** SessionStart reads the session's state file under the git-ignored `.claudinite/temp/` folder, named by the Claude session id, starts the background key request when there is no usable key, and returns in milliseconds. Skills and checks load their indexes at once, with every feature on while the first key is pending. Every later hook reads the same file, one local read, and applies what it says: the key's features once it has landed, or the degraded state once the background process has written that the request failed. Hooks never call GitHub or the server themselves.

**Ten seconds, then name the problem.** A desktop's key arrives in one direct call, well under a second; a web session's key makes a round trip through GitHub, which should take a few seconds and is the number the web key spike measures. Nobody waits for either. If the background process has no key after 10 seconds, it writes the degraded state with the likeliest cause, and the next hook tells Claude to tell the person: the Claudinite App is not installed on this repo, with the install link, or the person lacks push access, or GitHub or our server did not answer. If GitHub refuses the dispatch outright, it says so at once. So a session in a repo without the App runs with every feature for at most 10 seconds, and is told why it then stops. The background process keeps looking for 2 more minutes after the cut, so a key that lands late, at 15 seconds say, turns the features back on at the next hook. All of this needs that process to keep running after the SessionStart hook returns, which the web key spike confirms; if it cannot, the fallback is one GitHub read in each hook while the key is pending, and none once it has landed.

**Keeping the App installed.** The App is installed once per personal account or organization, by its owner or an admin, never by each user; it covers all of the account's repos or a chosen list, so a repo added later must be added to that list. Three checks keep a missing App rare in sessions. `cn init` requests a real key and will not finish until the App answers. The nightly Actions run asks the paid key Worker for its key over OIDC, which works with or without the App, and the Worker refuses a repo the App is not installed on, so the run files an issue naming the install link within a day of the App being removed or the repo being left out. And the server alerts us when an account that pays has repos the App no longer covers.

**Long and resumed sessions.** A session key lasts 7 days, the same length as the overuse grace, so a key never carries features further past the server's last word than grace would. It is renewed once it is a day old: any hook that reads a key older than a day, with no request in flight, starts the same background request and goes on using the old key until the new one lands, so nothing waits. A resume runs SessionStart again, which does the same. A key is bound to the nonce of the request that fetched it, so it works only in its own session.

**Work notes: check by hand before building on this.** Each is a claim the session-start design rests on, checked in a real Claude Code web session and a real desktop session against a test repo; a failed check changes the design before any code depends on it.

- [ ] A background process started by a web SessionStart hook keeps running after the hook returns, for at least the 2 minutes past the cut. If not, switch to the fallback of one GitHub read per hook while the key is pending.
- [x] A `repository_dispatch` sent from a web session passes the proxy, and its webhook's `sender` is the real user, not a Bot.
- [x] The web round trip, dispatch to a readable check run, takes a few seconds: record the median and the slowest of 50 tries, and confirm 10 seconds clears nearly all of them.
- [ ] A desktop key request answers in under a second.
- [ ] After the VM is suspended and the session resumes, SessionStart runs again with source `resume`, the session id is unchanged, and the state file under `.claudinite/temp/` is still there.
- [ ] GitHub refuses the dispatch at once, with a recognizable error, when the person lacks push access.
- [ ] In a repo without the App, no webhook reaches us and no check run appears, so the 10-second cut fires and names the App with its install link.
- [ ] The nightly Actions run's OIDC key request reaches the paid key Worker in a repo without the App, the Worker refuses it, and the run files the install issue.
- [ ] Installing the App once on an organization covers its repos for every member, and a repo outside a selected-repos install is caught by `cn init` and the nightly check.
- [ ] Whether GitHub's 500-an-hour limit on content-creating requests applies per installation or per App, measured against check-run creation.

Several `Claudinite key` check runs can sit on one commit, one per user and session. The server writes the session's nonce as the check run's external id, and the binary reads only the check run whose external id is its own nonce.

### When the key cannot be obtained

A web session that gets no answer within 10 seconds runs degraded and says why: the App may not be installed on the repo, the person may lack push access (a dispatch needs Contents write), GitHub may have rate-limited the dispatch, or the server may be down. It asks again at its next SessionStart, including a resume. This keeps an uninstalled App from reading as a free license, at a price: a license server outage degrades every web session that starts during it, turning off work checks, forced skill loading and in-session growth until the server answers. Rules, skills and guards keep working, so the outage costs features, never the work itself. A desktop that cannot reach the server keeps the features of its last key for at most 7 days after that key was issued, then runs degraded until it reaches the server again. An Actions run that cannot get a key skips its Claudinite-specific work for that run and reports it; project tasks run as usual.

## Seats and overuse

People who already hold a seat never lose features to overuse; only the people beyond the paid count do, and only after 7 days. The license server keeps, per licensee (a Private repo license, a personal account or an organization), the set of seated users in the last 30 days and the paid seat count.

1. **Within the paid count.** A new user's session gets a seat and an `ok` key.
2. **Over the paid count, within headroom.** A licensee paying for at least one seat is allowed 10% more users than it pays for, at least one, so a single visiting contractor never starts the clock. A licensee paying for no seats gets no headroom. Those users get `ok` keys, and SessionStart tells every user of the licensee that it is over its paid count and within tolerance, so the grace clock never arrives unannounced.
3. **Over headroom: grace.** The first user beyond the headroom starts the licensee's grace clock. Seated users are the first ones, in order of their first key, up to the paid count; everyone after them is over the count. For 7 days every user's session gets a `grace` key: all features run, and SessionStart tells every user of that licensee that the license is overused, by how many, the date grace ends and who can add seats. Actions runs file or update one issue in the repo saying the same, and the subscription's billing contact gets it by email too.
4. **After grace: degraded.** Users beyond the paid count get `degraded` session keys, and the licensee's Actions key loses Claudinite-specific tasks (the next section lists both). Seated users keep full features.
5. **Back within the count.** The moment the count drops back, through added seats or seats expiring after 30 days of inactivity, new keys are `ok` and the grace clock resets. A licensee that goes over again within 30 days of its last grace gets no new grace.

The same path handles payment. A subscription that is cancelled or fails to renew leaves the licensee with zero paid seats when Polar revokes it, at the end of the paid period or once payment retries are exhausted, so every user of its private repos is over the count, grace runs 7 days, and the private repos degrade. Public repos fall back to the Public plan. Nothing is deleted: the repo keeps its pinned engine, its packs and everything growth added, and paying again restores full keys at the next session or run.

## What runs in each state

A degraded key turns off what makes Claudinite smarter over time and leaves on everything the team's day-to-day work depends on. The binary gates each surface at the command that runs it, not in prose, because rules stay loaded and a rule telling Claude to run a check would otherwise still be followed.

| Surface | Where it runs | `ok` or `grace` | `degraded` |
| --- | --- | --- | --- |
| Rules | Session context | On | On |
| Skills by hand or by description | Session | On | On: skills stay mounted, so Claude loads them by description or when asked |
| Forced skill loading | The hooks that force a skill before a matching tool call or path | On | Off: skills stay mounted, but no hook forces one |
| Action guards | PreToolUse | On | On (see below) |
| Work checks | Stop hook | On | Off |
| In-session growth | SessionEnd capture, and the capture command a skill runs | On | Off |
| License notices | SessionStart | Grace notice to every user | Tells the person their seat was refused and who can add seats |
| CI checks | Actions on pull requests | On, no key needed | On |
| Project tasks | Scheduler and executor | On, no key needed | On |
| Claudinite growth tasks | Scheduler and executor | On | Off |
| Engine and pack updates | Nightly update | On | Off, security fixes included |
| Fleet management and canon curation | Scheduler and executor, Personal and Organization plans only | On | Off |
| Key requests | Everywhere | On | On |

**Action guards stay on.** They are the safety layer, the rules that block a dangerous command before it runs, and turning safety off would punish the team with risk rather than with missing features. Ariel confirmed this on 2026-09-30.

**Which tasks are Claudinite-specific.** The engine decides from the task's owner, never from a field someone sets: a task is Claudinite-specific when it is folded engine code (growth, the update, usage-fold) or belongs to a pack whose id starts with `claudinite-`. That covers every task in growth, canon-curation, fleet-sheepdog and the dashboard, and the lifecycle pack's update and adopt-requested-packs. One exception is named in the engine: verify-production checks the member's own production URL, which is project work, so it always runs. License key requests are engine code, not a task, and always run.

The executor still claims a Claudinite-specific item under a degraded key; it parks the item with a comment naming the plan and who can add seats, so the queue shows why the work stopped.

**Fleet management** runs from a fleet-manager repo, which needs the Claudinite App installed and a Personal or Organization plan covering it; without one, its fleet items park naming the plan. The server pins the scheduler, executor and update workflow files by name, so those names become part of the protocol: renaming one needs a server release that accepts the new name first.

## The Public plan

Every public repo is free, for any number of users, and still asks for a key in every session, so we know how many people use each one. It needs no purchase: the repo's owner installs the Claudinite App for free, and the public key Worker, described below, issues a Public key whenever GitHub says the repo is public. People without push access, such as outside contributors, cannot send a key request and run degraded.

- **Visibility comes from GitHub only.** A session key request carries the repo's visibility in the webhook GitHub sends; an Actions key request carries the `repository_visibility` claim of the OIDC token. The App also receives the `repository` webhook's `privatized` and `publicized` events and updates the repo at once.
- **No fleet management or canon curation.** Those features are never in a Public key or a Private repo key; a fleet manager needs a Personal or Organization plan.
- **Going private.** When a Public repo turns private and the owner has no paid plan, the next key is over the paid count (zero), and the 7-day grace of the Seats section runs. Going public is immediate at the next key.

A public repo under a paid Personal or Organization plan gets the paid features, fleet management included, but its users still take no paid seat.

**The plan is in the settings file.** `.claudinite-settings.json` records the plan the repo is on: Public, Private repo, Personal or Organization. It selects the endpoint, so a session in a Public repo asks the public key Worker and every other plan asks the paid one; a missing plan means the paid one. The file is committed and anyone with push access can edit it, so it never grants anything: the paid key Worker issues only what its own tables say, and the public one issues only Public keys, only for repos GitHub reports as public. `cn init` writes the plan the server reports for the repo. Actions runs always ask the paid key Worker, whatever the file says, and the nightly update writes the plan the server reported into the file when they differ, so a purchase, a cancellation or a repo changing owner corrects the file within a day with no one running anything.

**The binary checks the key against the repo.** Before it uses a key, the binary compares the key's plan with the repo it runs in, as GitHub describes it at session start: a Public key only on a public repo; a Private repo key only on the repo id it names; a Personal key only on repos the named personal account owns; an Organization key only on repos the named organization owns. A key that fails the check is treated as no key, the degraded state applies, and the notice names the mismatch and the plan's checkout link. The check also runs when the key's plan differs from the file's, so an edited file cannot pull a key for the wrong plan into a repo.

**The public key endpoint.** Public keys come from a third Worker in ClaudiniteLicenses, the public key Worker, with no database and no queue, and nothing shared with the paid key Worker at runtime: the two share only source packages, the signing library and the App's GitHub client, which each bundles on its own. It serves sessions in repos whose settings name the Public plan, and decides from GitHub alone: the webhook's `repository.private` for a web session, and GitHub's answer for the repo, read with the App user token, for a desktop. It signs with its own issuing key, certified by the root for Public keys only, so a leak there can never mint a paid key. It counts usage without a database by writing one Workers Analytics Engine data point per key, which the usage counts read. Workers already scale each Worker by its own traffic, so the gain is isolation: a surge of public traffic, such as a popular public repo, cannot use D1's capacity, the paid Worker's rate limits or its deploys, and a D1 outage never touches public keys. It also costs little, since a Public key is one short CPU call and one data point.

**Routing.** Cloudflare routes a request to a Worker by its hostname and path only, never by headers or body ([Workers routes](https://developers.cloudflare.com/workers/configuration/routing/routes/)). Desktops need nothing more: the binary calls the public or the paid endpoint by path, as the settings file says. Web sessions are the one case that needs a look inside the body, because every Claudinite App webhook arrives at one address. So the webhook router, a Worker of a few dozen lines with no database and no signing key, checks the webhook signature and passes each webhook to its Worker through a [service binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/), which Cloudflare runs on the same machine with no added latency and no extra charge. The session names its plan in the dispatch's event type, `claudinite-key-public` or `claudinite-key`, and the router reads only that and the event name.

## Billing through Polar

Polar sells every paid plan and is the merchant of record: it is the seller to the buyer, invoices in its own name, and handles sales tax, VAT, refunds and chargebacks ([Polar merchant of record](https://polar.sh/docs/merchant-of-record/introduction)). It only bills; counting users, holding repos to a plan and every grace period stay in the license server, which reads nothing from Polar but a plan and a seat count per GitHub account.

| Plan | Polar product | What the buyer buys | What the license server enforces |
| --- | --- | --- | --- |
| Public | None | Nothing | Visibility from GitHub; one Public key per public repo |
| Private repo | Seat-based, monthly and yearly | Repo seats: one user in one private repo | The private repos named at checkout are the licensed ones; distinct (repo, user) pairs in 30 days up to the seats |
| Personal | Seat-based, monthly and yearly | Seats: one user | Distinct users across all the personal account's private repos, up to the seats |
| Organization | Seat-based, monthly and yearly | Seats: one user | Distinct users across the organization's private repos, up to the seats |

A Polar product has a single billing interval, so each paid plan is two products, monthly and yearly, told apart by their `claudinite_plan` and `claudinite_interval` metadata. The prices per seat live in `billing/plans.json`, and the `polar-products` workflow makes each Polar organization match it.

**Buying.** The buyer never types a repo, account or organization name, and Polar never matches one. Every checkout is created by the license server for the place its link appears, so the link already knows which GitHub account, and which repo, it pays for. The server calls Polar's Checkout API with the plan's product, the GitHub account's numeric id as the customer's external id, and metadata holding the account's login and, for a Private repo plan, the repo's id and full name; the names are only there so the checkout page, the Polar dashboard and support can show who is paying for what. Polar hands the external id and metadata back on every subscription webhook, and the server files the subscription under that GitHub account. The link appears where someone needs it: `cn init` prints it after the first key request, a session refused a seat shows it, and the overuse notice and issue carry it, each made for that repo and its owner. Anyone can pay through a link, but paying only adds seats to the account it names. A Private repo link from a second repo of an account that already pays starts a second subscription for that repo; each repo's seats are its own subscription's.

**Changing seats and cancelling.** The buyer uses Polar's hosted customer portal, with seat management turned on and added seats charged pro rata at once ([seat-based pricing](https://polar.sh/docs/features/seat-based-pricing)). Polar's own seat assignment by email is not used: the license server seats people by GitHub identity and needs only the count.

**Events.** Polar's webhooks `subscription.created`, `subscription.updated`, `subscription.canceled`, `subscription.uncanceled`, `subscription.revoked` and `subscription.past_due` update the subscriptions table, looked up by the customer's external id. A cancellation keeps the seats to the end of the period; a revocation, after cancellation or exhausted payment retries, sets paid seats to zero at once, which starts the overuse grace. The server also reconciles nightly by listing subscriptions through Polar's API.

**Keeping the table right.** Only the sync Worker writes the subscriptions table, from two sources: Polar's subscription webhooks, which it verifies by signature, and the nightly reconcile, which lists every subscription through Polar's API. Each write stores the whole subscription as Polar sent it, keyed by Polar's subscription id, and is skipped when it is older than the stored row by Polar's own modified time, so a duplicate, retried or out-of-order webhook cannot leave a wrong row, and the reconcile overwrites any row that still differs from Polar. What remains is a bug of ours writing bad rows: the reconcile repairs subscriptions, and [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) restores the whole database to any minute of the last 30 days. A short failure on our side only delays updates, since Polar retries webhook deliveries and the reconcile catches what they miss. A long one is what the alerts catch: the sync Worker records when its last webhook and last reconcile succeeded, and the outside probe pages us when the last reconcile is more than 26 hours old, when webhooks fail repeatedly, when the oldest write waiting in the queue is more than 15 minutes old, or when a reconcile had to correct a row, which means a webhook was lost.

**When Polar is down.** Issuing and checking keys never calls Polar: the license server decides from its own subscriptions table, and the binary verifies keys offline, so a Polar outage changes nothing for existing customers. Only what happens on Polar itself stops: new checkouts and portal seat changes fail until it is back. Subscription changes that happened just before or during the outage reach the table late, when their webhooks arrive or the reconcile finds them; the reconcile runs nightly and again as soon as Polar's API answers after a failure. The cost of lateness is small either way: a late purchase is covered by the 7-day overuse grace, and a late cancellation only leaves a customer paid up a little longer.

**Not sold yet.** Enterprises that must pay by bank transfer or on invoice terms, which Polar does not offer, and customers on GHE.com or GitHub Enterprise Server. GitHub Marketplace is a possible later channel for discovery and card buyers: it bills per-seat plans and is also a merchant of record, but a paid listing needs 100 installations of the App first. The subscriptions table keeps a source column so a second channel can feed it without changing the license server.

## The license server

The license server is three Cloudflare Workers, two of them sharing one D1 database, built and deployed from their own private repo, ClaudiniteLicenses. The key Worker answers paid key requests from three places. The public key Worker, which has no database, answers public repos' key requests. A small webhook router receives the Claudinite App's webhooks, since an App has one webhook address, checks their signature and hands each to the Worker it is for, with no database and no signing key of its own. The sync Worker keeps the database current from Polar and from the records the key Worker queues. Neither calls the other.

**Why a repo of its own.** The license server is the most critical thing we run, and ClaudiniteWebsite keeps only the lower-criticality website. ClaudiniteLicenses holds both Workers, the D1 schema and its migrations, the queue configuration, and the outside probe. Its deploy workflow alone holds a Cloudflare API token scoped to those resources, so a website change, a website contributor or a leaked website token cannot touch key issuance, and the repo can require stricter review and branch protection than the website does. The signing keys are Worker secrets and never live in either repo.

**What it keeps.**

| Table | One row per | Holds |
| --- | --- | --- |
| Subscriptions | Paying account | Owner id and type, plan, purchased seats, Private repo plan's repo ids, source (Polar today), Polar subscription id, period end, pending cancellation |
| Repos | Repo the App is installed on | Repo id, owner id, visibility, whether it is licensed under a Private repo plan |
| Seats | Licensee and user | User id, first and last key date; a seat lapses 30 days after the last |
| Overuse | Licensee | Date grace started, whether this billing month's grace is spent |
| Usage | Repo, user and day | That the user used a private repo that day, written once a day; the number of keys issued is counted in Workers Analytics Engine, on every plan, Public included |
| Signing keys | Key id | The public key, its certificate from the root key, validity dates |

**What it answers.**

| Call | From | Verifies the caller by | Returns |
| --- | --- | --- | --- |
| `repository_dispatch` webhook, event `claudinite-key` | A web session, through GitHub | The webhook signature; the user is GitHub's `sender` | A session key in a `Claudinite key` check run |
| `POST /v1/session-key` | A desktop or Remote Control session | The App user token, checked against GitHub for the user and their access to the repo | A session key |
| `POST /v1/actions-key` | An Actions run | The GitHub OIDC token's signature and claims | An Actions key, and item grants on request |
| Checkout link, inside a key or `cn init` output | The license server itself, when a key needs one | Not applicable | A Polar checkout session for that GitHub account and plan |
| `installation`, `installation_repositories` and `repository` webhooks | GitHub | The webhook signature | The webhook router queues them; the sync Worker updates repos |
| `subscription.*` webhooks | Polar | Polar's webhook signature | The sync Worker updates subscriptions |
| Nightly reconcile | Its own cron | Not applicable | The sync Worker re-reads every Polar subscription and repairs missed events |

The App's permissions grow from metadata only to what these calls need: Checks write, to answer web sessions; Contents read, which GitHub requires before an App receives `repository_dispatch`; and the installation events. It never needs Contents write.

### How it is built, and how it stays up

There is no machine of ours. "The license server" is two Cloudflare Workers: our code, run by Cloudflare in every data center that receives a request, with nothing to patch, scale or restart. They share D1, Cloudflare's SQLite database, which has one primary copy that takes every write and read replicas near the Workers ([D1 read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)).

The two Workers are independent: separate code, separate deploys, separate secrets, and no call from one to the other. The **key Worker** issues keys. It holds the signing keys, only reads D1, and hands every record it produces to a Cloudflare Queue, so it writes nothing itself. The **sync Worker** keeps the data current. It holds Polar's API token and webhook secret, receives Polar's webhooks, runs the nightly reconcile, and consumes the queue, and it is the only writer of D1. It holds no signing key, so it can never issue one. When the sync Worker fails or a bad deploy breaks it, keys keep issuing from the last data it wrote, and the alerts under Billing report how stale that data is getting.

No service can promise it is never down, and Cloudflare itself has had global outages. So the goal is that an outage never stops anyone's work and rarely costs a feature, and the design gets there in four layers.

1. **Keys are checked offline.** The binary verifies every key with the root it embeds, so nothing already issued depends on the server. A desktop keeps its last key's features for 7 days; a session's key is fetched at its start and lasts 7 days, so a session running when the server goes down keeps its features.
2. **Issuing a key never waits on a write.** The key Worker decides from reads alone, served by the nearest D1 replica. The seat and usage record a user's first key in a repo each day produces goes onto a Cloudflare Queue, which delivers it to the sync Worker, retrying until it has written them to the primary, so a slow or unavailable primary does not slow or fail a key.
3. **When D1 cannot be read, the key Worker fails open.** It issues a session key with every feature on and the state `unverified`, logs the request to the queue for counting later, and alerts us. Nothing is kept for such a key: it is an ordinary signed key, bound like any key to its user, repo and session, and the next session started after the database is back gets a normal key. The request still reaches the queue, so the seat is counted once the database answers, and an account found over its count then enters the usual grace. The per-owner rate limit, kept in Cloudflare's rate-limiting binding rather than the database, still caps requests, and a key Worker setting turns failing open off if it is ever abused. Paying customers are never degraded by our outage; the cost is that sessions started during the outage skip the seat check.
4. **Deploys cannot take it down at once.** The two Workers deploy separately, so a sync deploy never touches key issuance. New versions of each roll out gradually through Cloudflare's versioned deployments and roll back on errors, and an outside probe requests a test key every minute from outside Cloudflare and pages us when it fails.

What remains is an outage of Cloudflare's Workers platform, or of GitHub, which carries every web session's key request. During either, sessions already running keep their keys; web sessions that start then get no answer and run degraded 10 seconds after they start, as the key-request section describes; desktops and Actions runs keep their last keys.

### Capacity, spikes and cost

**Elastic capacity.** Workers have no request-rate limit on the paid plan ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)): each data center runs as many copies of the key Worker as its requests need, with nothing for us to size. The finite parts are behind it. A D1 database runs one query at a time, about 1,000 a second when each takes a millisecond ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/)); a key takes about five short reads, and read replicas add read capacity on top of the primary. Writes never meet a spike directly: they wait in the queue, and the sync Worker writes them in batches of up to 100 per transaction, so a burst becomes a backlog that drains in minutes. If reads ever saturate, requests slow down and then fall to the fail-open layer above rather than failing.

**What one user costs the server.** A user starts about 20 new sessions a day, Ariel's estimate, and each takes one key; the repo's Actions runs add about 10 more, an estimate of ours. So about 30 key requests a day, or 900 a month. Each key request is one key Worker call of about 5 ms of CPU, about 5 D1 queries reading about 20 rows, one Workers Analytics Engine data point that counts it, and one or two GitHub API calls. The key Worker writes nothing. Seats must still be remembered, since a seat is a user who got a key in the last 30 days, so among its reads the key Worker checks whether the user already has today's usage row for the repo. Only when it is missing, on the user's first key in that repo that day, does it put one message on the queue, and the sync Worker then writes the row and the seat's last-use date. Every later key that day sends nothing. Keys for public repos write nothing at all: their users take no seat, so the Analytics Engine data point is their whole record, whether the public key Worker issues them or the paid one does for a public repo under a paid plan.

**10,000 users.** About 9 million key requests a month, 300,000 a day. Sessions start in working hours, so the busiest hour carries perhaps 45,000, about 12 a second, with bursts of perhaps 75 a second. That is under 400 D1 queries a second at the burst, less than half of one database's capacity before replicas.

| Item | Monthly use at 10,000 users | Included in Workers Paid | Cost |
| --- | --- | --- | --- |
| Workers Paid base |  |  | $5.00 |
| Worker requests | 9.2 million | 10 million | $0 |
| Worker CPU | 50 million ms | 30 million ms, then $0.02 per million | $0.40 |
| D1 rows read | 180 million | 25 billion | $0 |
| D1 rows written | about 2 million | 50 million, then $1.00 per million | $0 |
| Analytics Engine data points (key counts) | 9 million | 10 million, then $0.25 per million (not billed yet) | $0 |
| D1 storage | under 1 GB | 5 GB | $0 |
| Queue operations (3 per message) | about 2 million | 1 million, then $0.40 per million | $0.30 |
| **Total** |  |  | **about $6, under 0.1 cent per user** |

Prices are from [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) as of 2026-09-30. The total leaves out the outside probe's monitoring service and Polar's fees. Cost grows with key requests, not users: at ten times the usage per user, Worker requests become the largest line, about $25 of a total near $60 a month. Queue messages and D1 writes barely move, since they grow with users, repos and days rather than with keys.

**The ceiling is GitHub, not Cloudflare.** Every web session's key comes back as a check run the App creates. The App's rate limit is per customer installation, 5,000 to 12,500 requests an hour, or 15,000 on GitHub Enterprise Cloud ([GitHub rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)), which a customer reaches only with thousands of web sessions an hour. GitHub also limits content-creating requests to 80 a minute and 500 an hour without saying whether per installation or per App. If that applies per installation, an organization starting more than 500 web sessions in one hour would wait; the fix is for the key Worker to answer every key request a repo made in the last few seconds in one check run. The spike on web key requests measures which it is.

## Signing keys, rotation and security

Every binary ever released can verify every key the server will ever issue, because the binary trusts one long-lived root key rather than the key that signs licenses. This removes the lock-out the design review found, where a repo that missed an engine update could not verify its new license and so could not get the update.

**Two tiers of Ed25519 keys.**

1. **The root key** is embedded in every binary, with one standby root for emergencies, generated and stored apart from it; the binary accepts issuing keys certified by either. Its private half is kept offline and is used only to certify issuing keys. It changes only if it is compromised.
2. **Issuing keys** sign session keys, Actions keys and item grants. Each is a secret of the key Worker alone, never in D1, valid for 90 days with two weeks of overlap, so a leaked one expires quickly, and certified by the root with a purpose of `license`. Every key the server issues carries its issuing key's certificate, so the binary checks the certificate against the root and the key against the certificate. Rotating an issuing key needs no engine release. The public key Worker has its own issuing key, certified for Public keys only. A `license` certificate signs a key of any plan, Public included, because the paid key Worker also answers Actions runs and desktops in public repos; a `license-public` certificate signs nothing but Public keys.
3. **The pack index key** is a separate issuing key certified with a purpose of `packs`, held only by the ClaudinitePacks release workflow. The binary refuses a license key used on a pack index, or a pack key used on a license.

**If the root itself is compromised,** we certify new issuing keys with the standby root, which every binary already accepts, and publish a release that drops the compromised root and embeds a fresh standby. Lapsed repos get no engine updates, security fixes included, so they keep trusting the compromised root until they pay again; on resubscribing, their old binary still verifies the standby-certified keys, and the nightly update brings them current. A repo whose update pull request cannot merge, because its CI is red, still needs a person to fix CI, as for any update.

**No renewal clock and no rollback cache.** Keys live 7 days for sessions, fetched at every session start, and one run for Actions, and are fetched when needed, so the committed license file, its 30-day expiry, the renew-under-14-days PR and the cache of the newest issue date are all gone. A key bound to another session's nonce or another user does not verify, so an old key cannot be replayed into another session.

**Abuse limits.**

| Risk | Control |
| --- | --- |
| A session claims to be someone else | The user is GitHub's `sender` on the web path and GitHub's answer to the App token on the desktop path; the binary also checks the key's user against `GET /user` |
| A key copied into another repo | Keys bind the repo id; the binary compares it with the repo it runs in, and the server issues only for repos the App is installed on |
| A fork's pull request mints an Actions key | OIDC tokens from `pull_request` and `pull_request_target` are refused, and `job_workflow_ref` must name the member's workflow on its default branch |
| A team rotates people to stay under the count | The 30-day window counts everyone who held a seat in it; seats cannot be released early |
| Someone blocks the license server on a desktop | The desktop runs on its last key for 7 days, then applies the degraded state |
| Someone patches the binary | Accepted, as for any offline-verified tool; the server still sees every key it issues |

Two side effects of the web path are handled in the member repo. A key request is a `repository_dispatch`, which also starts any member workflow listening to every dispatch type, so a world check requires such workflows to list their `types`. The server keeps its per-owner rate limit and its alert on keys requested for repos without the App.

## What changes in the ClaudiniteEngine design

The licensing model fits the engine design with two adjustments, web sessions asking through GitHub and action guards staying on; eight statements in the engine design change.

| Engine design today | Becomes |
| --- | --- |
| Only Actions talks to the license Worker; sessions read a committed `.claudinite/license` | Every session gets its own key: web sessions through GitHub, desktops directly. There is no committed license file |
| A license is issued per repo, about 30 days long, renewed under 14 days left, with 7 days of grace | Session keys are fetched in the background at session start, last 7 days and renew daily, Actions keys one run; the only grace is the 7-day overuse grace, which also covers lapsed payment |
| Guards and checks run with or without a license; the task runner, growth, the dashboard and updates stop past grace | The per-state table above: rules, guards, CI checks and project tasks always run; work checks, forced skill loading, in-session growth and Claudinite-specific tasks stop for users beyond the paid count |
| The Worker accepts only `schedule` and dispatch OIDC tokens | It refuses only pull request triggers and pins the workflow file, so label-triggered executor runs get keys |
| The executor's routine sessions hold only the committed license | They verify an item grant the executor passes with the work item |
| The GitHub App asks for metadata read only | It adds Checks write and Contents read, and subscribes to installation, repository and dispatch events; billing events come from Polar |
| At least two embedded keys, rotated yearly, the next shipped one release early; a license older than the newest cached one is refused | One embedded root and a standby; issuing keys certified by the root rotate with no release; no issue-date cache |
| `claudinite login` fetches a personal license for a desktop with no repo license | `cn login` signs the desktop's user in once; that user's keys then come per repo like any session's |

One more reversal: the engine design discarded the desktop's GitHub token after sign-in; now the binary keeps the App's user token, 0600 in its cache folder, because every desktop key request needs it. The token can read only what the Claudinite App may read.

The command is `cn`, as Ariel asked, wherever the engine design says `claudinite`. Adoption stays free, so a new repo adopts before it has any key.
