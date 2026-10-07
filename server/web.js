"use strict";
const express = require("express");
const path = require("path");
const fs = require("fs");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { buildServer, originalName } = require("./mcp");
const store = require("./store");
const push = require("./push");
const { summarizeTitle } = require("./summarize");

const BUILD_ID = String(Date.now());
const MAX_SAVE_BYTES = 32 * 1024 * 1024;

// Validates and writes one `/api/upload` body; shared by the board and the public intake.
// Answers {status, body}: 200 with {path, downloadUrl}, else the refusal.
function storeUpload(requestBody, { mediaPattern = /^(?:image|video)\/\w+$/ } = {}) {
  const { dataUrl, filename } = requestBody || {};
  const match = typeof dataUrl === "string" && dataUrl.match(/^data:((?:image|video)\/\w+|application\/octet-stream);base64,(.+)$/);
  if (!match || (filename && typeof filename !== "string")
    || (match[1] !== "application/octet-stream" && !mediaPattern.test(match[1]))) {
    return { status: 400, body: { error: "dataUrl (image, video, or application/octet-stream with a .tc filename) required" } };
  }
  const isSave = match[1] === "application/octet-stream";
  if (isSave) {
    if (!filename || !/\.tc$/i.test(filename)) return { status: 400, body: { error: "save filename must end in .tc" } };
    if (match[2].length > Math.ceil(MAX_SAVE_BYTES / 3) * 4) {
      return { status: 413, body: { error: "save exceeds 32 MiB" } };
    }
    if (match[2].length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(match[2])) {
      return { status: 400, body: { error: "invalid save base64" } };
    }
  }
  const bytes = Buffer.from(match[2], "base64");
  if (isSave && bytes.length > MAX_SAVE_BYTES) return { status: 413, body: { error: "save exceeds 32 MiB" } };
  const dir = path.join(store.DATA_DIR, "uploads");
  fs.mkdirSync(dir, { recursive: true });
  const safeName = `${Date.now()}-${(filename || match[1].replace("/", ".")).replace(/[^a-zA-Z0-9.\-_]/g, "_")}`;
  const dest = store.uniqueUploadName(dir, safeName);
  fs.writeFileSync(dest, bytes);
  return { status: 200, body: { path: dest, downloadUrl: `/api/file?path=${encodeURIComponent(dest)}` } };
}

// Extracted from main.js so it can be exercised with plain HTTP in tests, without
// requiring electron (main.js still owns the window/notification/badge side effects).
function createApp({ clipboard } = {}) {
  const web = express();
  // Markdown comes from players and agents. It must never execute script using
  // PL's signed session; all application scripts already load from this origin.
  web.use((_req, res, next) => {
    res.set("Content-Security-Policy", "script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'");
    next();
  });
  // 4K screenshots pasted as base64 dataURLs easily pass 20 MB — keep headroom.
  web.use(express.json({ limit: "100mb" }));
  // Branding for a deployment (home-screen icon, notification icon, installed app name):
  // REVIEW_BOARD_ICON is a PNG path served as /icon.png, REVIEW_BOARD_TITLE the page title.
  if (process.env.REVIEW_BOARD_ICON) {
    web.get("/icon.png", (req, res) => res.sendFile(path.resolve(process.env.REVIEW_BOARD_ICON)));
  }
  if (process.env.REVIEW_BOARD_TITLE) {
    const title = process.env.REVIEW_BOARD_TITLE.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    web.get(["/", "/index.html"], (req, res) => {
      const page = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
      res.type("html").send(page
        .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
        .replace(/(name="apple-mobile-web-app-title" content=")[^"]*/, `$1${title}`));
    });
  }
  web.use(express.static(path.join(__dirname, "..", "public")));
  web.use("/shared", express.static(path.join(__dirname, "..", "shared")));

  // Stateless: one McpServer per request, no session to leak or lose messages across.
  const mcpHandler = async (req, res) => {
    const server = buildServer();
    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => {
        transport.close();
        server.close();
      });
    } catch (err) {
      console.error("MCP request error:", err);
      if (!res.headersSent) res.status(500).json({ error: String(err) });
    }
  };

  web.post("/mcp", mcpHandler);
  // /mcp-live used to keep a stateful session open (and drop messages when it did) —
  // kept only as an alias so an old client config pointed at it still works.
  web.post("/mcp-live", mcpHandler);
  web.get("/mcp-live", (_req, res) => res.status(405).end());
  web.delete("/mcp-live", (_req, res) => res.status(405).end());

  // Long poll: immediately replay persisted events, otherwise wait for a committed change.
  // No destructive MCP acknowledgement; each consumer owns its durable cursor.
  web.get("/api/event-journal", (req, res) => {
    const after = Number(req.query.after || 0);
    const timeout = Number(req.query.timeout || 0);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isFinite(timeout) || timeout < 0 || timeout > 25)
      return res.status(400).json({ error: "invalid cursor or timeout" });
    if (after > store.replayEvents(0).sequence)
      return res.status(409).json({ error: "cursor ahead of journal" });
    let timer;
    const cleanup = () => { clearTimeout(timer); store.events.off("change", changed); };
    const respond = () => { cleanup(); res.json(store.replayEvents(after)); };
    const changed = () => { if (store.replayEvents(after).events.length) respond(); };
    if (store.replayEvents(after).events.length || timeout === 0) return respond();
    store.events.on("change", changed);
    timer = setTimeout(respond, timeout * 1000);
    res.on("close", cleanup);
  });

  web.post("/api/events/completion", (req, res) => {
    try { res.json(store.publishCompletion(req.body || {})); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });

  web.get("/api/reviews", (_req, res) => res.json(store.list()));
  web.get("/api/history", (_req, res) => res.json(store.history()));

  web.post("/api/reviews/:id/reply", (req, res) => {
    try {
      const msg = store.reply(req.params.id, req.body || {});
      push.closeNotification(req.params.id).catch((err) => console.error("push close error:", err));
      res.json(msg);
    } catch (err) {
      res.status(404).json({ error: String(err.message || err) });
    }
  });

  web.post("/api/upload", (req, res) => {
    const stored = storeUpload(req.body);
    res.status(stored.status).json(stored.body);
  });

  // Same gate and bare 404s as /api/image, as an attachment download under the
  // uploader's own file name.
  web.get("/api/file", (req, res) => {
    const file = store.servableDownload(req.query.path);
    if (!file) return res.status(404).end();
    res.type("application/octet-stream");
    res.download(file, originalName(file), (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  });

  web.post("/api/messages", (req, res) => {
    const text = (req.body && req.body.text) || "";
    const images = (req.body && req.body.images) || [];
    const replyTo = (req.body && req.body.replyTo) || null;
    if (!text.trim() && images.length === 0) return res.status(400).json({ error: "text or images required" });
    const msg = store.addHumanMessage(text, images, replyTo);
    // Title summary is only for human-composed cards, not thread-reply delivery
    // vehicles — fire-and-forget, never blocks the response.
    if (!replyTo) summarizeTitle(msg.id, msg.title, store).catch(() => {});
    res.json(msg);
  });

  web.post("/api/messages/:id/move", (req, res) => {
    const { state, note } = req.body || {};
    if (!store.TASK_STATES.includes(state)) return res.status(400).json({ error: "invalid state" });
    try {
      res.json(store.moveTask(req.params.id, state, note));
    } catch (err) {
      res.status(404).json({ error: String(err.message || err) });
    }
  });

  web.delete("/api/messages/:id", (req, res) => {
    const msg = store.list().find((m) => m.id === req.params.id);
    if (msg && msg.direction !== "human") return res.status(400).json({ error: "not a human message" });
    res.json({ removed: store.withdraw([req.params.id], "human") });
  });

  web.post("/api/messages/:id/archive", (req, res) => {
    try {
      res.json(store.archive(req.params.id));
    } catch (err) {
      res.status(404).json({ error: String(err.message || err) });
    }
  });

  // Human-only priority triage: mirrors /move's shape (validate the value up
  // front -> 400, store errors -> 404) so a bad body never has to sniff
  // store.setPriority's error text to tell "unknown id" from "bad value" apart.
  web.post("/api/messages/:id/priority", (req, res) => {
    const { priority } = req.body || {};
    if (!Number.isInteger(priority) || priority < 0 || priority > 3) {
      return res.status(400).json({ error: "invalid priority" });
    }
    try {
      res.json(store.setPriority(req.params.id, priority, "human"));
    } catch (err) {
      res.status(404).json({ error: String(err.message || err) });
    }
  });

  // Human-only: sends a closed (or landing) card back to backlog — see
  // store.reopen for why the prior approval is retracted. Never exposed over MCP.
  web.post("/api/messages/:id/reopen", (req, res) => {
    const { note } = req.body || {};
    try {
      res.json(store.reopen(req.params.id, note));
    } catch (err) {
      res.status(404).json({ error: String(err.message || err) });
    }
  });

  web.post("/api/messages/:id/seen", (req, res) => {
    try {
      res.json(store.markThreadSeen(req.params.id));
    } catch (err) {
      res.status(404).json({ error: String(err.message || err) });
    }
  });

  web.post("/api/messages/:id/thread-note", (req, res) => {
    const text = (req.body && req.body.text) || "";
    if (!text.trim()) return res.status(400).json({ error: "text required" });
    try {
      res.json(store.humanThreadNote(req.params.id, text));
    } catch (err) {
      res.status(404).json({ error: String(err.message || err) });
    }
  });

  // One bare 404 for every refusal, so the answer never says why or echoes a path;
  // a send error (file gone mid-request) gets the same instead of Express's
  // stack-trace page.
  web.get("/api/image", (req, res) => {
    const file = store.servableMedia(req.query.path);
    if (!file) return res.status(404).end();
    res.sendFile(file, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  });

  web.get("/api/events", (req, res) => {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.flushHeaders();
    const onChange = () => res.write("data: change\n\n");
    store.events.on("change", onChange);
    req.on("close", () => store.events.off("change", onChange));
  });

  web.get("/api/build-id", (_req, res) => res.json({ buildId: BUILD_ID }));

  web.get("/api/clipboard-image", (req, res) => {
    const addr = req.socket.remoteAddress;
    const isLocal = addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
    // A reverse proxy (e.g. tailscale serve) forwards from loopback too, but stamps
    // these headers — reject it so a remote client can't ride the localhost gate.
    const proxied = req.headers["x-forwarded-for"] || req.headers["x-forwarded-host"] || req.headers["via"];
    if (!isLocal || proxied) return res.status(403).end();
    if (!clipboard) return res.status(204).end();
    const img = clipboard.readImage();
    if (img.isEmpty()) return res.status(204).end();
    res.json({ dataUrl: img.toDataURL() });
  });

  web.get("/api/push-public-key", (_req, res) => res.json({ publicKey: push.publicKey }));

  web.post("/api/push-subscribe", (req, res) => {
    push.addSubscription(req.body);
    res.json({ ok: true });
  });

  return web;
}

module.exports = { createApp, storeUpload, BUILD_ID };
