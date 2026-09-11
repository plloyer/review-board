"use strict";
const express = require("express");
const path = require("path");
const fs = require("fs");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { buildServer } = require("./mcp");
const store = require("./store");
const push = require("./push");
const { summarizeTitle } = require("./summarize");

const BUILD_ID = String(Date.now());

// Path comparisons are case-insensitive on win32 (the filesystem is), case-sensitive elsewhere.
function normalizeForCompare(resolved) {
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isUnderDataDir(resolved) {
  const rel = path.relative(normalizeForCompare(path.resolve(store.DATA_DIR)), normalizeForCompare(resolved));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// /api/image discloses only files under our own data dir or actually referenced by a
// message — never an arbitrary path on the host. Cheap to rebuild per request at this scale.
function referencedImagePaths() {
  const set = new Set();
  const add = (p) => p && set.add(normalizeForCompare(path.resolve(p)));
  // Agents also embed proof images as markdown inside thread entries, either as
  // a bare local path or already wrapped in /api/image?path=<encoded> — both count
  // as referenced.
  const addMarkdownTargets = (text) => {
    const s = String(text || "");
    // Any /api/image?path=<encoded> reference, whatever markup carries it
    // (markdown image, raw <img>/<video> tag).
    for (const m of s.matchAll(/\/api\/image\?path=([^"'&)\s]+)/g)) {
      try {
        add(decodeURIComponent(m[1]));
      } catch {}
    }
    // Markdown images with a bare local path target.
    for (const m of s.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const target = m[1];
      if (/^(https?:|data:|\/api\/image)/i.test(target)) continue;
      add(target);
    }
  };
  const collect = (m) => {
    for (const img of m.images || []) add(img.path);
    for (const vid of m.videos || []) add(vid.path);
    if (m.reply) for (const img of m.reply.images || []) add(img.path);
    for (const t of m.thread || []) addMarkdownTargets(t.text);
  };
  store.list().forEach(collect);
  store.history().forEach(collect);
  return set;
}

// Extracted from main.js so it can be exercised with plain HTTP in tests, without
// requiring electron (main.js still owns the window/notification/badge side effects).
function createApp({ clipboard } = {}) {
  const web = express();
  // 4K screenshots pasted as base64 dataURLs easily pass 20 MB — keep headroom.
  web.use(express.json({ limit: "100mb" }));
  web.use(express.static(path.join(__dirname, "..", "public")));

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
    const { dataUrl, filename } = req.body || {};
    const match = typeof dataUrl === "string" && dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!match) return res.status(400).json({ error: "dataUrl (image) required" });
    const dir = path.join(store.DATA_DIR, "uploads");
    fs.mkdirSync(dir, { recursive: true });
    const safeName = `${Date.now()}-${(filename || `image.${match[1]}`).replace(/[^a-zA-Z0-9.\-_]/g, "_")}`;
    const dest = store.uniqueUploadName(dir, safeName);
    fs.writeFileSync(dest, Buffer.from(match[2], "base64"));
    res.json({ path: dest });
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
    res.json({ removed: store.withdraw([req.params.id]) });
  });

  web.post("/api/messages/:id/archive", (req, res) => {
    try {
      res.json(store.archive(req.params.id));
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

  web.get("/api/image", (req, res) => {
    const p = req.query.path;
    if (typeof p !== "string") return res.status(404).end();
    const resolved = path.resolve(p);
    if (!fs.existsSync(resolved)) return res.status(404).end();
    if (!isUnderDataDir(resolved) && !referencedImagePaths().has(normalizeForCompare(resolved))) {
      return res.status(404).end();
    }
    res.sendFile(resolved);
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

module.exports = { createApp, BUILD_ID };
