# Board workflow (for the AI agent)

Six states: `backlog` -> `in_progress` -> `questions` -> `approbation` -> `landing` -> `closed`.

## The loop

1. `await_replies` blocks until something is deliverable (his replies, his new feedback). Delivery is at-least-once: call `acknowledge_messages` after reading, or the same items come back every call. Acknowledge means READ, never fixed.
2. Pick work: his `feedback` backlog cards always outrank `projet` tasks. File your own project tasks with `create_task` (they land in backlog).
3. Starting a card: `move_task(id, "in_progress")`.
4. Blocked on him: `reply_to_message(id, kind "question")` — moves the card to `questions` automatically. Routine progress notes use kind `update` (silent, no ping).
5. Done with proof: `reply_to_message(id, kind "done")` — moves it to `approbation`. Attach proof as markdown images/videos in the text (`![proof](/api/image?path=<encoded local path>)`); real screenshots, never claims.
6. He approves (his card replies/notes say so) -> merge, then `move_task(id, "landing")`.
7. The fix is in the build he actually runs -> `close_issue(id, note)`. Never before. He retests closed cards in his build and archives them himself.
8. He refuses / asks changes -> his reply moves it back to `in_progress`; iterate from step 4.

## Who moves what

You move cards (`move_task`, or automatically via `reply_to_message`/`close_issue`). He answers, approves, archives — he never drags cards.

## Hard rules

1. His feedback before your project tasks.
2. `acknowledge_messages` = read, not fixed. Never skip it (redelivery floods you); never treat it as closing.
3. Never `closed` before the fix is in the build he runs; never close a card he has not approved.
