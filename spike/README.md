# Web key spike

Tools for the license design's work notes that a Claude Code web session can check. Record every
run in [docs/spikes/web-key-roundtrip.md](../docs/spikes/web-key-roundtrip.md), and tick the
matching work note in [docs/license-design.md](../docs/license-design.md) in the same commit.

Everything here needs the Claudinite App (#1) and the deployed Workers (#2). The test repo is a
public repo under `missingbulb` with the App installed (ClaudiniteSandbox once
ClaudiniteEngine#1 exists) and **no workflow listening to every `repository_dispatch` type**.

## Installing the heartbeat hook in the test repo

Copy `spike/background-survival.mjs` into the test repo at the same path and add to its
`.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/spike/background-survival.mjs\"" }] }
    ]
  }
}
```

Make sure `.claudinite/temp/` is git-ignored there.

## Procedure per work note

1. **A background process outlives the SessionStart hook.** Start a web session in the test repo,
   wait three minutes, then read `.claudinite/temp/spike-heartbeat.log`. Pass: lines keep coming
   past `elapsed_s` 120, all from the one pid.
2. **The dispatch passes the proxy and its sender is the user.** Run note 3; the summary's
   `senderTypes` must show only `User`.
3. **The round trip takes a few seconds.** In the web session:

   ```
   node spike/web-key-roundtrip.mjs --repo missingbulb/<test-repo> --tries 50
   ```

   Record `medianMs`, `p90Ms`, `maxMs`, and `overCut` (tries slower than the 10-second cut).
5. **Suspend and resume.** After note 1's session has been idle long enough for the VM to suspend,
   resume it and read the log again. Pass: a second run of lines with `source` `resume`, the same
   `session_id`, and the file from before the suspend still there.
6. **No push access fails at once.** Run note 3's command with `--tries 1` as a collaborator
   without push access. Pass: the try records a 403 (or 404) on the dispatch, with no polling.
7. **No App, no check run.** Run note 3's command with `--tries 1 --max-ms 120000` against a public
   repo without the App. Pass: `no check run within 120000 ms`.
10. **Content-creation limits.** With `npx wrangler tail claudinite-public-key` open in another
    terminal, run:

    ```
    node spike/web-key-roundtrip.mjs --repo missingbulb/<test-repo> --tries 100 --burst
    ```

    Count the `secondary-rate-limit` lines in the tail. Whether the limit is per installation or
    per App needs a second installation on another account, which this script cannot provide.

Notes 4, 8 and 9 belong to the desktop, Actions and paid key Worker chunks.
