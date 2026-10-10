# Exact-card decision reads

`get_message` is a read-only MCP tool for a single known card id. It fixes the
missing focused reader: `list_messages` gives titles/statuses, while
`await_replies` and `recent_history` return unrelated messages along with the
decision a caller needs. After a denied broad read, those global readers are
not fallback routes. This tool must first be published, explicitly configured,
and exposed through the normal supported connector before it can be used.

## Request and access boundary

```json
{"id":"r293","threadLimit":20}
```

The schema rejects additional properties, batches, wildcards, search terms,
paths, prefixes and coercion. Ids match `^[ru][1-9]\\d{0,11}$`. `threadLimit` is an
integer from 0 to 50, default 20; zero still returns the exact primary reply.

The operator configures `REVIEW_BOARD_TARGETED_READ_IDS` as comma-separated
exact ids, for example `r293`. Empty/missing configuration denies every targeted
read. Malformed scope fails closed; there is no wildcard. The client cannot
supply scope or expand it. The authorization check runs before card lookup, so
a denied id does not reveal existence, title, thread or other allowed ids.

This is a deployment-wide allowlist behind the board's existing MCP/network
access boundary. The board has no authenticated caller identity, and this
change does not invent one or implement per-person permissions. It does not
weaken the public intake, expose a new HTTP route, alter existing readers, or
grant native execution/approval permissions. The operator must approve any
configuration extension separately. A new reader is not evidence that the
earlier native refusal has been lifted.

## Exact content and bounded output

The server projects only the requested live card (or its archived version),
its primary `reply.text`, `optionChosen`, `decision` and `at`, inline thread
entries, and direct human delivery vehicles whose `replyTo` equals that id.
It never expands a delivery vehicle into its parent, siblings, blockers,
project, unrelated cards, history window or execution journal. Live delivery
records take precedence over historical duplicates of the same id.

The primary decision fields are returned unchanged. `answered`, a choice such
as `A`, a read, or an acknowledgement is never converted into approval. The
maximum UTF-8 JSON projection is 32 KiB (the MCP text envelope is below 64 KiB).
The newest optional thread entries fit within both the requested count and
byte limit; `thread.total` and `thread.omittedItems` explicitly report omissions.
If the primary card/decision itself exceeds the bound, the tool returns an
explicit error, without a truncated decision that could be misread as consent.

Images, videos, attachment paths, unknown fields and file bytes are excluded.
References already written in text remain literal; the reader never resolves
or opens files. Reading makes no delivery, acknowledgement, badge, state,
disk-write or journal-cursor changes.

## Validation and publication

The synthetic reducer and MCP transport tests cover exact text/choice/null
decision, live/archive selection, direct-reply isolation, no parent/sibling
expansion, default denial, inaccessible-id indistinguishability, hostile
arguments, UTF-8 limits, omissions and unchanged stored bytes/journal state.
No real card content is needed to run them.

This is a separate revision from the traceability delivery approved on r294.
It needs its own scoped publication/deployment consent, a pinned production
base check, controlled source backup, the explicit exact-id configuration,
service-only restart and focused read verification. Never deploy it using r294
or dump the board to discover the answer to its publication question.
