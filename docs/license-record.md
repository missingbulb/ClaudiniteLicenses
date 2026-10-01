> Approved by Ariel on 2026-10-01. Source: [Claude Doc](https://claude.ai/code/artifact/7baa2177-0a09-4d4d-ba90-e95182350d38). This repo copy is now the canonical version; change it here.

# License management: record

The decisions behind the license design, who took each, the research that tested Ariel's model, and the alternatives not chosen. The design itself is on the first tab.

## Decisions

| # | Decision | Decided by | Rationale | Precedent |
| --- | --- | --- | --- | --- |
| 1 | Every Claude session gets its own key from the license server, so the server counts individual users | Ariel | Per-user pricing needs a count of people, not repos or organizations | Seat-based developer tools count people once across repos (GHAS, Snyk, Semgrep) |
| 2 | Web sessions request their key through GitHub: a `repository_dispatch` sent as the person, answered with a check run | Claude, forced by reachability | A web VM on the default network reaches GitHub but no host of ours, and no org-wide setting can add one; GitHub attributes the dispatch to the person, so identity needs no trust in the session | None found; the pattern is ours |
| 3 | A user is a GitHub numeric id; a seat lasts 30 days after the user's last key | Claude | GitHub is the identity every environment already has; 30 days matches monthly billing | GHAS, Snyk and Semgrep count people over 90 days, for committer-based billing |
| 4 | All of a customer's Actions runs are one principal that never takes a seat | Ariel | Automation is not a person | GHAS ignores App bots; GitLab excludes service accounts |
| 5 | Four plans: Public free, Private repo, Personal, Organization | Ariel | As asked; prices are set in another thread | Free for public repos is universal among the products compared |
| 6 | Degraded sessions keep rules, mounted skills and action guards; lose work checks, forced skill loading and in-session growth. Actions keep CI checks and project tasks; lose Claudinite-specific tasks | Ariel | Degrade, don't brick: keep what the team's daily work relies on | GHAS keeps enabled repos working and blocks new ones; CodeRabbit gives unassigned developers summaries only |
| 7 | Action guards stay on in a degraded session | Ariel, on Claude's recommendation | Guards block dangerous commands; switching safety off as a payment lever punishes with risk | None researched |
| 8 | Overuse grace is 7 days, after 10% headroom (at least one user), once per billing month | Ariel (7 days); Claude (headroom, once per month) | 7 days is at the short end of the market but fair here because the degraded state keeps daily work intact; headroom stops a single contractor starting the clock | GitLab 10% headroom and 14-day grace; Atlassian 14 days; Semgrep and Sentry one-time grace |
| 9 | Lapsed payment uses the overuse path with zero paid seats; the 30-day license, 14-day renewal and separate expiry grace are dropped | Claude | One clock instead of two, and short-lived keys need no renewal | JFrog and GitLab go read-only on expiry; GitHub charges nothing for locked time |
| 10 | Public-repo activity never takes a paid seat, under any plan | Claude | Keeps the free promise simple and avoids billing open-source contributors | Snyk, Semgrep and SonarQube exclude public repos from counts |
| 11 | The Public plan has no local packs; its growth lessons go to a `claudinite-lessons` branch the canon's growth-promote reads. Superseded 2026-09-30: Ariel corrected that every plan has local packs; what the Public and Private repo plans lack is a fleet manager. The lessons branch is gone. | Ariel (global packs only, lessons for global growth); Claude (mechanism) | Growth today writes to local packs, which a Public repo does not have | None needed |
| 12 | Polar sells every paid plan as a seat-based product, a Private repo seat being one user in one repo; the license server creates each checkout with the GitHub account as the customer's external id. GitHub Marketplace is a possible later channel, not the plan | Claude | Marketplace cannot sell before 100 installations and bills nothing per repo; Polar is a merchant of record, pays out to Israel, and has seats, a hosted portal and webhooks | Snyk, Zenhub and Mergify sell outside Marketplace |
| 13 | Keys are signed by issuing keys that a long-lived root certifies; the binary trusts only the root | Claude, asked by Ariel to solve the rotation lock-out | Rotation needs no engine release, so no repo can be stranded on an old binary | TUF and code-signing certificate chains |
| 14 | Lapsed repos get no engine updates, security fixes included; every binary accepts keys certified by the standby root, so a root compromise never strands a repo that pays again | Ariel (no updates); Claude (standby root) | Updates are part of what customers pay for; accepting the standby root keeps resubscribing possible | None needed |
| 15 | Executor routine sessions use an item grant; label-triggered executor runs get Actions keys | Claude | Unattended work must not take seats, and the label trigger has a normal OIDC identity | None needed |
| 16 | A task is Claudinite-specific when it is engine code or its pack id starts with `claudinite-`; verify-production is the named exception | Claude, from Ariel's list | Derived from where the task lives, not a field someone must set | None needed |
| 17 | The key carries a feature list the server computes | Claude | Policy and pricing change without an engine release | Nx Powerpack's feature-flag license |
| 18 | A key request in flight keeps every feature for up to 2 minutes; a web session with no answer then runs degraded, and a desktop keeps its last key's features for up to 7 days | Claude | An outage degrades rather than breaks, and an uninstalled App never reads as a free license | JetBrains' 48-hour offline grace |
| 19 | The command is `cn` | Ariel | Short to type | None needed |

## Is every capability possible?

Yes, with two adjustments: web sessions cannot reach our server directly, and guards are better kept on. Checked against GitHub's docs, the Claude Code cloud environment docs, live probes from a default web session and the Claudinite repo.

| Capability asked | Possible | How, or the catch |
| --- | --- | --- |
| Each session gets its own key from the license server | Yes, through GitHub on the web | A default web VM got `502` from the egress proxy for a `workers.dev` host and a custom domain; `registry.npmjs.org` and the GitHub API for attached repos were reachable ([cloud environments](https://code.claude.com/docs/en/cloud-environments)). An App receives `repository_dispatch` with Contents read ([webhook events](https://docs.github.com/en/webhooks/webhook-events-and-payloads#repository_dispatch)). Desktops reach the server directly |
| Count individual users | Yes | The session reads its user with `GET /user` through the proxy, which `packs/claude-code-web-users-support/read_github_login.mjs` already does and which answered live; the server trusts only GitHub's `sender`. Web commits are authored as Claude, so commit authors cannot count people |
| One key for all Actions | Yes | GitHub OIDC gives every run a verifiable repo and owner identity with no stored secret |
| Limit keys to the paid number of users | Yes | Ours to enforce; Marketplace only reports the purchased quantity ([pricing plans](https://docs.github.com/en/apps/github-marketplace/listing-an-app-on-github-marketplace/setting-pricing-plans-for-your-listing)) |
| Tell the refused session, and have it tell the user | Yes | The hook that reads the key adds a line to Claude's context telling it to inform the person |
| Keep rules, skills by hand, CI checks and dispatcher tasks | Yes | Rules are a tracked file, not a hook; CI and project tasks need no key |
| Stop in-session growth, checks and forced skill loading | Yes | Clean switch points today: the forced-skill hooks, the Stop work sweep and the SessionEnd capture; the skill mount stays on |
| Block growth, update, canon-curation and fleet tasks | Yes | Derived from each task's owning pack; 30 tasks classified, see the design |
| 7-day grace with notices to everyone | Yes | The key carries the state and the grace end date |
| Free public repos, always counted | Yes | OIDC's `repository_visibility` claim and the App's `privatized` and `publicized` events |
| Public repos use only global packs | Yes | One switch in the pack registry, which skips `.claudinite/local/packs/` |
| Extract lessons from public repos for global growth | Needs a new lane | growth-promote reads members' local packs today; a Public repo writes lessons to a branch instead |
| Plans on GitHub Marketplace | Yes, billing only | Per-unit plans, restricted to personal accounts or organizations; no repo dimension; 100 installations before any paid plan |

## GitHub Marketplace findings

| Capability | Marketplace does it | Notes |
| --- | --- | --- |
| Free, flat-rate and per-unit plans | Natively | Up to 10 plans, USD, monthly and yearly price on every paid plan, one fixed 14-day trial per plan |
| Per-unit (per seat) pricing | Natively, one quantity | The buyer types a quantity; unit names vary by listing (seat, user). Whether "repo seat" is accepted is unverified |
| Plan for personal accounts only or organizations only | Natively | The plan's "Available for" field |
| A plan for one repo versus all repos | No | Repo selection is an install step independent of the plan |
| Price by repos times users | No | Modelled as one unit per (repo, user) |
| Seat enforcement or metering | No | Marketplace reports `unit_count`; enforcing it is the developer's job |
| Purchase and change events | Natively | `marketplace_purchase`; downgrades and cancellations apply at the next billing date; failed deliveries are not resent, so reconcile nightly ([plan changes](https://docs.github.com/en/apps/github-marketplace/using-the-github-marketplace-api-in-your-app/handling-plan-changes)) |
| Identify a user | Natively | Device flow for GitHub Apps; user tokens last 8 hours with a 6-month refresh ([user tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)) |
| Invoiced enterprises, GHE.com, Enterprise Server | No | Direct sale ([upgrading a Marketplace app](https://docs.github.com/en/billing/how-tos/pay-third-parties/upgrade-marketplace-app)) |
| Listing a paid app | With conditions | Verified publisher, billing-flow review, at least 100 installations; GitHub keeps 5% ([requirements](https://docs.github.com/en/apps/github-marketplace/creating-apps-for-github-marketplace/requirements-for-listing-an-app), [developer agreement](https://docs.github.com/en/site-policy/github-terms/github-marketplace-developer-agreement)) |

## Billing and licensing services

Asked by Ariel on 2026-09-30: is Marketplace really billing only, and should we buy licensing or billing instead? Marketplace is billing only: free, flat-rate and per-unit plans, with seat limits left to the app. It is also the merchant of record, so its 5% includes sales tax handling ([developer agreement §6.1](https://docs.github.com/en/site-policy/github-terms/github-marketplace-developer-agreement)). No deprecation of paid listings was found; that rests on finding none, not on a statement from GitHub.

| Service | Does | Merchant of record | Fees | Why not the licensing core |
| --- | --- | --- | --- | --- |
| [Keygen](https://keygen.sh/pricing/) | Licensing: Ed25519-signed licenses, seats, floating seats; self-hostable community edition | No | Free to 100 active users, $99 a month to 1,000, $299 to 10,000 | No GitHub or OIDC identity; active users counted over 90 days; signed files live at least an hour; overage only in fixed steps such as 1.25x, with no timed grace |
| [Cryptlex](https://cryptlex.com/pricing) | Licensing, RSA-signed offline tokens | No | $100 to $600 a month | Same identity gap |
| [LicenseSpring](https://licensespring.com/pricing) | Licensing | No | $0 to $750 a month | Same identity gap |
| [Paddle](https://www.paddle.com/pricing) | Billing, seats as quantities | Yes | 5% + 50¢ | Billing only |
| [Polar](https://polar.sh/resources/pricing) | Billing, assignable seats, usage meters, open source | Yes | 5% + 50¢, down to 3.4% + 30¢ on its $400 plan | Its GitHub feature grants repo access; it does not bind seats to GitHub users |
| [Stripe](https://stripe.com/pricing) | Billing, on/off entitlements, Tax; usage billing through Metronome | Only with Managed Payments, +3.5% | Cards 2.9% + 30¢, Billing 0.7%, Tax 0.5% | Billing only |
| [Lemon Squeezy](https://www.lemonsqueezy.com/pricing) | Billing, online-checked license keys | Yes | 5% + 50¢ | Being folded into Stripe Managed Payments; avoid a new setup |
| Chargebee, Lago, Orb, Metronome, Zuora | Subscription and usage billing | No | From 0.65% of volume | More than four seat plans need |

Peers mix channels: CodeRabbit and Codecov sell on Marketplace and also bill directly, counting a user from their pull requests; Snyk, Zenhub and Mergify list only free plans on Marketplace and sell elsewhere.

**Decision (Ariel, 2026-09-30: Polar now, Marketplace possibly later):** keep our own license server as the one authority on entitlement, because no service combines GitHub-attributed identity, Actions sign-in, 30-day active users, headroom and a timed grace. Sell through Polar, a merchant of record that pays out to Israel, and keep Marketplace as a possible later channel for discovery. Rejected: Marketplace now, which cannot sell before 100 installations and cannot reach invoiced enterprises or GHE.com; Stripe Managed Payments, which does not accept sellers in Israel; Keygen in place of our server, which still needs the GitHub identity piece and adds lock-in; plain Stripe, which leaves us registering and filing sales tax ourselves.

## Running direct sales through a merchant of record

Asked by Ariel on 2026-09-30. The deciding fact is the selling entity's country: Polar pays out to Israel; Stripe Managed Payments needs a Stripe account in one of 39 countries, and Stripe does not support Israel.

| Question | Polar | Stripe Managed Payments | GitHub Marketplace |
| --- | --- | --- | --- |
| Buyer changes 6 to 8 seats | Hosted customer portal, prorated; or our API call. We build a link and a webhook handler | Hosted Checkout and billing portal (portal support inferred); same link and webhook | On GitHub |
| Refunds and chargebacks | Polar handles them; may refund on its own within 60 days of purchase and 30 days of renewal; $15 per dispute | Stripe handles them; may refund within 60 days | Ours |
| Invoices | Polar sells to the buyer and invoices in its own name, with VAT id and company details; we invoice only Polar, once per payout | Stripe's affiliate invoices the buyer for tax purposes | GitHub bills the buyer |
| Bank transfer, net 30 | No | No | Invoiced enterprises cannot buy; those we invoice ourselves (inferred) |
| Payouts | Manual withdrawal after a 7-day hold, $10 minimum, Stripe payout fees about 0.25% + 25¢ plus conversion | Stripe's normal daily schedule | Monthly once at least $500 |
| Fees | 5% + 50¢, down to 3.4% + 30¢ on its $400 plan | Card fees plus 3.5% | 5% |
| Know-your-customer checks | Business review up to 14 days, ID and selfie through Stripe Identity, a Stripe Connect Express account opened inside Polar's flow | Our own Stripe account in a supported country, then an eligibility review; B2B SaaS qualifies | Verified publisher organization, then GitHub's financial onboarding |
| GDPR | Polar's documents disagree on who controls buyer data; we control the GitHub ids and seat usage in the license server either way | Stripe is controller for payment data | Customer data deleted within 30 days of cancellation |

Polar runs on Stripe, so with Polar we integrate only Polar's API (inferred). Lemon Squeezy's team is building Stripe Managed Payments, so Stripe does offer the service; the obstacle is only the seller's country. Sources are in the research notes this record was written from.

## How comparable products behave

The design sits on the lenient side of the market: seated users never lose anything, and the degraded state keeps daily work intact, where GitLab and Atlassian Data Center go read-only. Its one short number is the 7-day overuse grace, which headroom softens.

| Product | Seat unit | Over the paid count | Expiry or lapsed payment | Free for public repos |
| --- | --- | --- | --- | --- |
| [JFrog self-hosted](https://docs.jfrog.com/administration/docs/manage-licenses) | Servers, not users | Not applicable | Platform read-only until renewed; no separate grace | No |
| [JFrog SaaS](https://jfrog.com/saas-terms-and-conditions/) | Storage and transfer consumption | Overage billed automatically | Data deleted 60 days after termination | No |
| [GitHub Advanced Security](https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-advanced-security/about-billing-for-github-advanced-security) | Active committer, 90 days, once across the org | Enabled repos keep working; no new repos can be enabled | [Paid features locked; no charge for locked time](https://docs.github.com/en/enterprise-cloud@latest/billing/how-tos/troubleshooting/locked-account) | Yes |
| [GitHub Copilot](https://docs.github.com/en/billing/concepts/product-billing/github-copilot-licenses) | Assigned seat | Cannot exceed; adding a seat bills pro rata | Access ends at the cycle's end | Not applicable |
| [Snyk](https://docs.snyk.io/platform-administration/snyk-hierarchy/usage-settings) | Contributing developer, 90 days, private repos only | Invoiced in arrears | Not documented | Open-source programme |
| [SonarQube](https://www.sonarsource.com/plans-and-pricing/) | Lines of code in private projects | New analyses rejected past the limit | [Analyses fail at once; browsing stays](https://community.sonarsource.com/t/what-happens-when-license-expires/19468) | Yes |
| [CodeRabbit](https://docs.coderabbit.ai/management/seat-assignment) | Developer who opens pull requests | Seat added and billed pro rata; unassigned developers get summaries | Not documented | [Yes](https://www.coderabbit.ai/faq) |
| [Atlassian Data Center](https://www.atlassian.com/licensing/data-center) | User tier | Whole instance read-only | Read-only on expiry | No |
| [Docker Desktop](https://www.docker.com/pricing/faq/) | Authorized user, honour system | Not enforced | Business features lost on downgrade | Open-source programme |
| [Nx Powerpack](https://nx.dev/blog/introducing-nx-powerpack) | Licensed workspace | Not applicable | The licensed feature stops; everything else runs | [Yes, for qualifying projects](https://nx.dev/pricing) |
| [GitLab self-managed](https://docs.gitlab.com/administration/license_file/) | Billable user, high-water mark | 10% over accepted and billed at renewal; more refuses the license | 15-day warning, 14-day grace, then read-only | Free tier |
| [Sentry](https://sentry.io/pricing/) | Event volume, users unlimited | Events dropped unless pay-as-you-go; one-time grace | Not documented | [Sponsored](https://sentry.io/for/good) |
| [Semgrep](https://docs.semgrep.dev/usage-and-billing/overview) | Private-repo contributor, 90 days | Scans stop after a one-time 30-day trial | Not documented | Yes |

No compared product mints a key per session; they count people from what they see, and a key per session works here only because the seat count is of distinct GitHub users, never of keys.

## Alternatives not chosen

- **A seat roster in a committed license, with users counted from pushes the App sees.** It needs no new network path, but the server could never refuse a session, it would count committers who never use Claudinite, and it misses people who read and ask without pushing.
- **A device-flow sign-in in every web session.** It is strong proof, but a web VM is fresh every session, so every session would open with a browser step.
- **Our own host on the web VM allowlist.** Every user would have to edit their environment's allowlist; no organization-wide setting exists.
- **The `r2.dev` host, which tunnelled from a web VM.** It is not on the published allowlist, so it could close without notice.
- **Answering web sessions with a git ref or a commit status.** A ref needs Contents write, which customers rightly resist; a commit status holds 140 characters and any writer can forge one. Only Apps can create check runs.
- **A 90-day seat window.** It is the committer-billing norm, but it would bill a one-off contributor for three months on monthly plans.
- **A 14-day overuse grace.** The market norm for tools that lock more; kept at Ariel's 7 because the degraded state is mild.
- **Turning action guards off with the checks.** Rejected as punishing with risk; decision 7.
- **Yearly key rotation with the next public key shipped one release early.** It strands any repo that missed an update; replaced by the root-certified issuing keys.

## Open questions

- Confirm in a spike that a web session's `repository_dispatch` passes the GitHub proxy and that its webhook names the person, not a Bot, as `sender`. This is inferred from the proxy's credential swap and the webhook docs, not run.
- Whether a `Claudinite key` check run per user per commit is acceptable noise on the default branch's commits.
- Whether the Marketplace editor accepts the unit name "repo seat".
- Pricing and the paid-feature list are being settled in another thread; this design treats the dashboard and usage-fold as Claudinite-specific, and moves them if that thread decides otherwise.

## Final review

A Fable review of this design on 2026-09-30 raised 31 findings. The design was corrected for the ones below; the rest are listed as decisions Claude took for Ariel to confirm.

| Finding | What changed |
| --- | --- |
| A web session with no answer ran with every feature, so an uninstalled App read as a free license | No answer within 2 minutes now means degraded, with the reasons listed |
| A dispatch needs Contents write, so read-only people got no key | Stated: people without push access run degraded, including outside contributors to public repos |
| That the web proxy passes a dispatch was stated as fact | Marked as inferred, with a spike before the build |
| A dispatch starts member workflows listening to all dispatch types | A world check requires such workflows to list their types |
| Every hook could poll GitHub; a commit might not be on the remote | Only SessionStart and UserPromptSubmit read the answer; the key names the remote default-branch head |
| The check run could gate pull requests; bots could request keys | Neutral conclusion; Bot senders refused |
| Item grants were issued before the item existed and had no channel | Issued per item and posted on the item's issue |
| Zero paid seats plus headroom gave one free user forever | Headroom only for licensees paying for at least one seat |
| "Beyond the paid count" and "once per billing month" were undefined | Seated users are the first by first key; no new grace within 30 days of the last |
| Grace arrived without warning | A notice starts as soon as the count passes the paid seats |
| A leaked issuing key stayed valid a year | 90-day issuing keys; the standby root is generated and stored apart |
| The change table missed the desktop token now being kept | Added |

Raised and deliberately kept: the Private repo plan covers several private repos, one repo seat per person per repo, because Marketplace sells one purchase per account (Ariel's model said one repo per license); "one Actions key" is one principal with a key per run, since a stored shared key would be a secret in every repo; headroom is not billed, a deliberate leniency GitLab does not offer; the 30-day window is shorter than the 90-day norm; CI checks and project tasks keep running in the degraded state, which weakens the reason to pay and is what Ariel asked for. Claude also took these, unasked: the check-run answer channel, the lessons branch, the 14-day Marketplace trial and treating the dashboard and usage-fold as Claudinite-specific.

## Alignment review with the engine design

On 2026-09-30 the engine design was rewritten to point at this one, and a Fable review of the pair (review) found gaps belonging here. Each is now answered on the Design tab: where a session keeps its key state between hooks, matching the check run by nonce, which hook renews an expiring key, how a routine session knows it is one and finds its grant, grants under a degraded Actions key, the outage trade-off, how the standby root ships, and what fleet repos need. Whether the dispatch sender is a person rather than a Bot is part of the planned spike. Asked whether security fixes should still reach lapsed customers, Ariel chose no updates at all, on 2026-09-30.

**Release states in the key (2026-09-30).** The release testing design (its decision 21, Ariel's question) dropped the signed engine channel index and moved held, revoked and security-fix release states, the pack index serial and the accepted pack signing keys into every session and Actions key. The key's field list now carries them.

**License server availability (2026-09-30, Claude, for Ariel to confirm).** Asked how the server avoids downtime: key issuance reads only from the nearest D1 replica and queues its writes, and when the database is unreachable the Worker issues a 1-hour `unverified` key with every feature on rather than degrading paying customers. Rejected: running our own servers in several regions, which adds machines to operate for no gain over Cloudflare's own spread; and a second hosting provider as a hot standby, which would need the signing keys in two places.

**Polar sync alerts and the KV snapshot (2026-09-30, Ariel asked; Claude chose the shape).** Ariel asked for an alert on a prolonged failure to update from Polar, and whether the Worker could keep the database in memory. The alerts watch reconcile age, webhook failures, queue backlog and reconcile corrections. For the fallback Claude chose per-account records in Workers KV, written after each D1 write and hourly, over holding the database in Worker memory, which Cloudflare does not keep between requests, and over one whole-database snapshot, which would grow past KV's value size as accounts are added.

**Two independent Workers (2026-09-30, Ariel).** The Worker that updates D1 from Polar must be independent of the one that serves keys. The key Worker holds the signing keys and only reads D1 and KV, writing only to the queue; the sync Worker holds the Polar secrets, handles Polar's webhooks, the reconcile and the queue, and is the only writer. They deploy separately and never call each other.

**Capacity and cost estimate (2026-09-30, Claude, estimated not measured).** Ariel asked for elastic capacity, spike behavior and the cost of 10,000 users. At an assumed 20 key requests per user per day the estimate is about $12 a month on Cloudflare's published prices. Found while estimating: GitHub's secondary limit of 500 content-creating requests an hour may apply per installation, which would cap an organization's web session starts; the web key spike now also measures this, and batching several answers into one check run is the fix if it does.

**ClaudiniteLicenses repo (2026-09-30, Ariel).** The license server moves out of ClaudiniteWebsite into its own private repo, so the website keeps only lower-criticality work and the license deploy token, review rules and contributors are separate from the website's.

**Public key Worker (2026-09-30, Ariel; router and routing setting by Claude, for Ariel to confirm).** Public keys come from their own Worker with no database access. Claude added a webhook router, because a GitHub App has one webhook address, and a repo setting that sends a paying owner's public repo to the paid endpoint, because the public Worker cannot see plans.

**Local packs on every plan (2026-09-30, Ariel).** A repo on any plan can have local packs; the Public and Private repo plans differ from Personal and Organization only in having no fleet manager. The design's "global packs only" rule and the `claudinite-lessons` branch it needed are removed.

**Plan in the settings file (2026-09-30, Ariel; Actions path and nightly correction by Claude).** The settings file names the repo's plan and selects the endpoint; it grants nothing. The binary rejects a key whose plan does not fit the repo. Claude chose that Actions runs always ask the paid Worker and that the nightly update corrects the file from the server's answer. Payload-based routing was checked: Cloudflare routes match hostname and path only, so web sessions keep a small router Worker.

**KV snapshot removed (2026-09-30, Ariel asked, Claude agreed).** D1 shares its storage with Workers KV, so the one documented D1 read outage, Cloudflare's June 12, 2025 incident, was a KV storage failure; a KV snapshot fails with D1 and was dropped. When D1 cannot be read, the key Worker fails open directly. This supersedes the KV part of the Polar sync alerts entry.

**License settled at session start (2026-09-30, Ariel; the numbers by Claude, for Ariel to confirm).** Skills and checks load at start, so SessionStart decides the license and no later hook asks again. Claude chose: SessionStart waits up to 15 seconds for a web key, to be set by the spike, and a wait that runs out starts the session degraded, which also catches a repo without the App from the first moment; session keys last 7 days so long sessions need no mid-session renewal, and a resume fetches a fresh key; the fail-open key is now an ordinary session key whose request is counted once the database answers, replacing the 1-hour key.

**No wait at session start (2026-10-01, Ariel).** Supersedes the 15-second wait above. Ariel ruled out any delay at session start in the working case. The key request runs in the background, the session starts with every feature on while it is pending, and the request is cut at 10 seconds, after which the session runs degraded and names the cause. Keys last 7 days, matching grace, and renew in the background once a day old. Claude added the nightly Actions check that files an issue when the App no longer covers a repo; whether a detached background process survives a web SessionStart hook is for the web key spike to confirm.

**Session-start design approved (2026-10-01, Ariel),** on the condition that its claims are checked by hand; the checklist is the Design tab's work notes, passed to the build plan.

**Whole design approved** (2026-10-01, Ariel). This settles the three items left open: the fail-open key is an ordinary session key marked unverified, one webhook router Worker routes App events to the right Worker, and Public keys stay valid on public repos owned by an organization.
