"use strict";
// The board without Electron, for an always-on server (no window, no desktop notification, no
// clipboard): the same web app, MCP endpoint and Web Push as main.js.
//
//   REVIEW_BOARD_DATA_DIR=/var/lib/review-board REVIEW_BOARD_HOST=127.0.0.1 node headless.js
//
// REVIEW_BOARD_HOST defaults to 127.0.0.1: put a reverse proxy (e.g. `tailscale serve`) in front
// rather than exposing the board, which has no authentication. REVIEW_BOARD_PORT defaults to 5677.
// Set REVIEW_BOARD_NO_SUMMARY=1 where no claude/codex CLI is logged in.
const { createApp } = require("./server/web");
const push = require("./server/push");
const { watchForNotifications } = require("./server/notifier");

const HOST = process.env.REVIEW_BOARD_HOST || "127.0.0.1";
const PORT = Number(process.env.REVIEW_BOARD_PORT || 5677);

watchForNotifications((title, body, tag) => {
  push.notifyAll(title, body, tag).catch((err) => console.error("push error:", err));
});

const server = createApp().listen(PORT, HOST, () => console.log(`Review board listening on http://${HOST}:${PORT}`));
server.on("error", (err) => {
  console.error(`listen error: ${err.code || err.message}`);
  process.exit(1);
});
