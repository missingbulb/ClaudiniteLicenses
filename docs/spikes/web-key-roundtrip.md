# Web key spike results

One row per work note this spike checks (see [spike/README.md](../../spike/README.md) for the
procedure). Fill a row only from a real run, never with expected values, and tick the matching
work note in [license-design.md](../license-design.md) in the same commit. The round-trip script's
summaries go beside this file in `web-key-roundtrip.json`, one entry per run.

| Work note | Ran by | Date | Repo | Invocation | Numbers | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| 1. Background process outlives the hook | | | | | | |
| 2. Dispatch passes the proxy; sender is the user | Claude, a Claude Code cloud session (agent proxy) | 2026-10-01 | missingbulb/ClaudiniteLicenses | `--tries 50`, then `--tries 100 --burst` (`claudinite-key-public`) | `senderTypes`: `User` 50 of 50, then 100 of 100; dispatch median 310 ms, then 281 ms | Pass |
| 3. Round trip: median, slowest of 50, share under 10 s | Claude, a Claude Code cloud session (agent proxy) | 2026-10-01 | missingbulb/ClaudiniteLicenses | `--tries 50` (`claudinite-key-public`, the live public key Worker) | median 2405 ms, p90 2568 ms, slowest 3265 ms, 0 of 50 over 10 s | Pass |
| 3. The same, paid key Worker's web path | Claude, a Claude Code cloud session (agent proxy) | 2026-10-02 | missingbulb/ClaudiniteLicenses | `--tries 50 --event claudinite-key --verify` (`claudinite-key`, the live key Worker `0ffafd93`) | median 2327 ms, p90 2604 ms, slowest 4058 ms, 0 of 50 over 10 s; 50 of 50 verified, 0 refusals; `senderTypes` `User` 50 of 50; seen (plan, state, notice): (`public`, `ok`, null) 50 of 50. `/v1/sync/health` the same before and after: `seats` 0, `last_queue_at` 1790909910, `last_queue_version` `8018e718` (the deploy's own read-back) | Pass on timing. Not the paid path: the repo is public, so the key Worker answers `public`/`ok` and queues no write, as its plan resolution does for every public repo. ClaudiniteLicenses#22 expected `private-repo`/`grace`/overused on the premise that this repo is private, which it is not. The private-repo path is still unrun (ClaudiniteLicenses#26) |
| 5. Resume reruns SessionStart; state file survives | | | | | | |
| 6. No push access: dispatch refused at once | | | | | | |
| 7. No App: no check run within 120 s | | | | | | |
| 10. 500-an-hour limit: per installation or per App | Claude, a Claude Code cloud session (agent proxy) | 2026-10-01 | missingbulb/ClaudiniteLicenses | `--tries 100 --burst` (`claudinite-key-public`) | 100 of 100 visible, 0 failures, so no `github-error` and no `secondary-rate-limit` in this burst (`wrangler tail` not run: no `CLOUDFLARE_API_TOKEN` in the session); median 2433 ms, slowest 3531 ms | Burst half: no limit at 100 check runs in about 4 minutes. Per installation or per App needs a second installation on another account. |
