# Board workflow

Six states: `backlog` -> `in_progress` -> `questions` -> `approbation` -> `landing` -> `closed`.

- `backlog` — filed, not started.
- `in_progress` — you're working it.
- `questions` — you're blocked on the human. Use `reply_to_message` kind `question`; it moves the card here automatically.
- `approbation` — done, proof attached, awaiting his approval.
- `landing` — approved AND merged.
- `closed` — present in the build he runs.

## Who moves what

The agent moves cards (`move_task`, or automatically via `reply_to_message`). The human never drags cards — he answers, approves, or archives.

## Three rules

1. His feedback cards always outrank project tasks — work feedback first.
2. `acknowledge_messages` means read, not fixed.
3. Never mark `closed` before the fix is actually delivered in the build he runs.
