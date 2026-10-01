# Web key spike results

One row per work note this spike checks (see [spike/README.md](../../spike/README.md) for the
procedure). Fill a row only from a real run, never with expected values, and tick the matching
work note in [license-design.md](../license-design.md) in the same commit. The raw output of the
round-trip script goes beside this file as `web-key-roundtrip.json`.

| Work note | Ran by | Date | Repo | Invocation | Numbers | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| 1. Background process outlives the hook | | | | | | |
| 2. Dispatch passes the proxy; sender is the user | | | | | | |
| 3. Round trip: median, slowest of 50, share under 10 s | | | | | | |
| 5. Resume reruns SessionStart; state file survives | | | | | | |
| 6. No push access: dispatch refused at once | | | | | | |
| 7. No App: no check run within 120 s | | | | | | |
| 10. 500-an-hour limit: per installation or per App | | | | | | Needs a second installation on another account; the burst run alone cannot say. |
