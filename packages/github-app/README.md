# packages/github-app

The Claudinite App's GitHub client, a source package each Worker that acts as the App bundles: the
App JWT, installation tokens scoped to exactly the repositories and permissions a call needs, the
`Claudinite key` check run, and the desktop path's reads of the caller and the repo.

`refusalSummary(reason, text)` spells a `Claudinite key refused` check run's summary,
`<reason>: <text>`, for the key Worker and the public key Worker alike. The binary takes what
precedes the first colon as the cause, so the reason is one lower-case word and the function throws
on a text holding a colon: a link belongs in the key, never in a refusal.
