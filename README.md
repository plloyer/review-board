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

On an always-on server, run it without Electron instead:

```bash
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
REVIEW_BOARD_DATA_DIR=/var/lib/review-board REVIEW_BOARD_NO_SUMMARY=1 node headless.js
```

Same web app, MCP endpoint and Web Push; no window, desktop notification or clipboard paste.
It listens on `127.0.0.1:5677` (`REVIEW_BOARD_HOST`, `REVIEW_BOARD_PORT`): put a reverse proxy
such as `tailscale serve` in front, since the board has no authentication. Player-filed
F7 reports land straight in the backlog as feedback cards; there is no intake approval
and no owner sign-in (`REVIEW_BOARD_PL_SECRET` is no longer read).
`REVIEW_BOARD_ICON` (a PNG path) and `REVIEW_BOARD_TITLE` replace the icon and the name a
phone shows for the board added to its home screen (and the notification icon).

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
and `videos` (absolute local file paths — the board reads them directly, no
upload; videos render as `<video controls>`), `project`.

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

## Testing

Run `node --test tests/*.test.js` (or `npm test`) before restarting the app after
changes to `server/`. Tests run against a temp data dir and never touch `data/`.

Player bug reports can upload a Three Crowns save with `POST /api/upload`
using JSON `{dataUrl: "data:application/octet-stream;base64,...", filename: "save.tc"}`.
Saves are limited to 32 MiB. Existing image/video uploads still work. The response
contains `path` and a relative `downloadUrl`; resolve that URL against the board's
network address. `GET /api/file?path=...` serves identical bytes as an octet-stream
attachment, restricted to `.tc` saves and media (png/jpg/jpeg/gif/webp/mp4) inside
`data/uploads/` (including real-path checks). `GET /api/image?path=...` serves only
that media, from `data/uploads/` or the Game Bar `~/Videos/Captures` folder; anything
else on either route is a bare 404. MCP delivery (`await_replies`, `recent_history`)
inlines the same media only and skips any other attachment.

Call the MCP `create_task` tool with `taskKind: "feedback"`, `title`, and `context`
(Markdown, optionally linking to `downloadUrl`) to file a real feedback card in
the backlog/retours group. The HTTP MCP endpoints are `/mcp` and `/mcp-live`;
there is no separate REST create-task endpoint. Omitting `taskKind` still creates
a `projet` card, and the first MCP result block remains the bare card id.
Feedback context appears on compact cards and in full in expanded cards/overlays.
`projet` and `change-request` cards now also show their context (a change request's
`details`) on the sent card and in the overlay, and `await_replies` delivers it with the card.
