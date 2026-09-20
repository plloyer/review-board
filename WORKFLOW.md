# Board workflow (for the AI agent)

Six states: `backlog` -> `in_progress` -> `questions` -> `approbation` -> `landing` -> `closed`.

## The loop

1. `await_replies` blocks until something is deliverable (his replies, his new feedback). Delivery is at-least-once: call `acknowledge_messages` after reading, or the same items come back every call. Acknowledge means READ, never fixed.
2. Pick work: his `feedback` backlog cards always outrank `projet` tasks. File your own project tasks with `create_task` (they land in backlog). Pass `no_review: true` for a task that legitimately never needs his review before landing.
3. Starting a card: `move_task(id, "in_progress", agent: {vendor, model, effort})`. `vendor` is `claude`, `codex` or `antigravity`; the board draws that icon on the card with the model and effort (optional) in its tooltip. Required the first time a card enters `in_progress`; `reply_to_message` also takes `agent` when a card changes hands. A card sent back to `backlog` loses its agent.
4. Blocked on him: `reply_to_message(id, kind "question")` — moves the card to `questions` automatically. Routine progress notes use kind `update` (silent, no ping).
5. Done with proof: `reply_to_message(id, kind "done")` — moves it to `approbation`. Attach proof as markdown images/videos in the text (`![proof](/api/image?path=<encoded local path>)`); real screenshots, never claims. Proof files must be readable by the board machine - from another machine, POST /api/upload {dataUrl, filename} first and use the returned path.
6. He approves (his card replies/notes say so) -> merge, then `move_task(id, "landing")`.
7. The fix is in the build he actually runs -> `close_issue(id, note)`. Never before. He retests closed cards in his build and archives them himself.
8. He refuses / asks changes -> his reply moves it back to `in_progress`; iterate from step 4.

## Who moves what

You move cards (`move_task`, or automatically via `reply_to_message`/`close_issue`). He answers, approves, archives — he never drags cards.

## Dependencies & priority

Dependencies: `set_blockers` / `blocked_by` on `create_task`/`move_task` (blocked until blockers reach `landing`/`closed`; you get a "débloquée" delivery). Priority: `set_priority` / `priority` 0-3 (0 = critical, 1 = highest, then in order).

## Hard rules

1. His feedback before your project tasks.
2. `acknowledge_messages` = read, not fixed. Never skip it (redelivery floods you); never treat it as closing.
3. Never `closed` before the fix is in the build he runs; never close a card he has not approved.
4. Board bug or missing tool? `request_change` — never patch the board yourself.
5. Entering `landing`/`closed` requires his approval unless the task was created `no_review` — `move_task`/`close_issue` refuse otherwise. Closing a card already in `landing` is free (the approval was paid at the landing door).
6. Every card needs a retrospective before it can close. The work is usually a subagent's, and it's gone by close time — so require your subagent to end its final report with the three points below, and attach them to your `kind:"done"` delivery (`reply_to_message`'s `retro` param). `close_issue` also accepts one late, but refuses a card with none stored and none passed — and so does `move_task(id, "closed")`, the same way, so there's no bypass around the gate:
   - Friction encountered — what slowed the work down or took trial and error.
   - Config/skill gaps — any rule, tool, or instruction that was missing, wrong, or unclear.
   - What to do differently — the one change that would have made this task faster or cleaner.

   A few sentences per point; state "none" explicitly rather than omitting a point. (Canonical wording: `shared/lifecycle.js`'s `RETRO_TEMPLATE_TEXT`.)
