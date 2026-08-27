# Review Board

A local Electron app: a coding-session AI queues reviews, questions, and notes
to you over MCP; you reply, comment, or approve in the board; the session
picks the reply back up and continues right where it was.

## Run it

```bash
npm install
npm start
```

Opens a window on `http://localhost:5677`. Leave it running while you work —
messages sent while it's closed just fail to reach it (v1 has no queue-while-closed
or tray icon; see Skipped below).

## Point a coding session at it

Add to that project's `.mcp.json`:

```json
{
  "mcpServers": {
    "review-board": {
      "type": "http",
      "url": "http://localhost:5677/mcp",
      "timeout": 300000
    }
  }
}
```

`timeout` must exceed the longest `await_replies` wait (max 240s).

## Tools

| Tool | Direction | Notes |
|---|---|---|
| `send_message` | AI → you | Non-blocking, batch of messages, returns ids |
| `await_replies` | you → AI | Blocks (default 120s, max 240s); call again on timeout |
| `list_messages` | — | Current queue with direction/kind/status |
| `withdraw_messages` | — | Retire messages the AI solved itself |

A message: `title` (required), `kind` (`review` default / `question` / `note`),
`options` (one-click answers, max 8), `context`, `details` (bullets), `images`
(absolute local file paths — the board reads them directly, no upload), `project`.

You can also type into the board's own compose box; that lands as a message
*from you* and is delivered on the AI's next `await_replies` call, which is
how a reply becomes a real back-and-forth rather than a one-shot approval.

## Skipped for v1 (ponytail: shortest thing that works)

- No image annotation/markup — before/after images just render side by side.
- No "keep receiving while the window is closed" — the app must be running.
- No packaging/installer — `npm start` only.
- No `Play://`-style deep link into an editor (that needs an editor bridge this
  app doesn't have).

Add any of these when they're actually missed.
