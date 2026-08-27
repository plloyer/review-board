"use strict";
const { app, BrowserWindow, Notification } = require("electron");
const path = require("path");
const fs = require("fs");
const express = require("express");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { buildServer } = require("./server/mcp");
const store = require("./server/store");

const PORT = 5677;

function startServer() {
  const web = express();
  web.use(express.json({ limit: "10mb" }));
  web.use(express.static(path.join(__dirname, "public")));

  // MCP endpoint (stateless: one server instance per request, matching the SDK's
  // own stateless example — this app has no concurrent-session needs).
  web.post("/mcp", async (req, res) => {
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
  });

  web.get("/api/reviews", (_req, res) => res.json(store.list()));

  web.post("/api/reviews/:id/reply", (req, res) => {
    try {
      const msg = store.reply(req.params.id, req.body || {});
      res.json(msg);
    } catch (err) {
      res.status(404).json({ error: String(err.message || err) });
    }
  });

  web.post("/api/messages", (req, res) => {
    const text = (req.body && req.body.text) || "";
    if (!text.trim()) return res.status(400).json({ error: "text required" });
    res.json(store.addHumanMessage(text));
  });

  // Local image passthrough so <img> can show an absolute path the agent gave us,
  // without wrestling file:// access rules on an http-origin page.
  web.get("/api/image", (req, res) => {
    const p = req.query.path;
    if (typeof p !== "string" || !fs.existsSync(p)) return res.status(404).end();
    res.sendFile(p);
  });

  // Live push for the board UI.
  web.get("/api/events", (req, res) => {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.flushHeaders();
    const onChange = () => res.write("data: change\n\n");
    store.events.on("change", onChange);
    req.on("close", () => store.events.off("change", onChange));
  });

  store.events.on("change", () => {
    const open = store.list().filter((m) => m.direction === "agent" && m.status === "open");
    const latest = open[open.length - 1];
    if (latest && Notification.isSupported()) {
      new Notification({ title: "Review board", body: latest.title }).show();
    }
  });

  // Bind to loopback only: this is a single-user local tool, not a network service.
  web.listen(PORT, "127.0.0.1", () => console.log(`Review board listening on http://localhost:${PORT}`));
}

function createWindow() {
  const win = new BrowserWindow({ width: 1100, height: 800, title: "Review Board" });
  win.loadURL(`http://localhost:${PORT}/`);
}

app.whenReady().then(() => {
  startServer();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
