"use strict";
// The public bug-report intake: a second listener in the board process, published alone on the
// Internet (e.g. `tailscale funnel`) so a game anywhere can file a player report, while the board
// itself stays private. It speaks the subset of the board's wire contract the game already uses
// and nothing else:
//
//   POST /api/upload                    a PNG screenshot or a `.tc` save (same checks as the board)
//   POST /mcp                           JSON-RPC tools/call create_task, filed as a player feedback card
//   GET  /api/reviews|history?marker=   the ids of the cards carrying one report marker, never a card list
//
// Every request carries the shared key in `X-Intake-Key`; each source is rate-limited and each body
// capped. Any other method or path is a bare 404.
const crypto = require("crypto");
const express = require("express");
const store = require("./store");
const { PLAYER_REPORT_TITLE_PREFIX, PLAYER_REPORT_TITLE_PREFIXES } = require("../shared/lifecycle");
const { storeUpload } = require("./web");

const KEY_HEADER = "x-intake-key";
const MARKER = /^\[three-crowns-report:[A-Za-z0-9-]{1,64}\]$/;
const PROJECT = "Three Crowns · player report";
const MAX_TITLE = 200;
const MAX_CONTEXT = 64 * 1024;

function keyMatches(expected, given) {
  if (typeof given !== "string") return false;
  const a = Buffer.from(expected), b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Behind the funnel every request arrives from loopback; the proxy names the real client.
function sourceOf(req) {
  const socket = req.socket.remoteAddress || "";
  const loopback = socket === "127.0.0.1" || socket === "::1" || socket === "::ffff:127.0.0.1";
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return loopback && forwarded ? forwarded : socket;
}

function rateLimiter({ max, windowMs, now }) {
  const hits = new Map();
  return (req, res, next) => {
    const at = now();
    const source = sourceOf(req);
    const recent = (hits.get(source) || []).filter((t) => at - t < windowMs);
    if (recent.length >= max) {
      hits.set(source, recent);
      res.set("Retry-After", String(Math.ceil((windowMs - (at - recent[0])) / 1000)));
      return res.status(429).end();
    }
    recent.push(at);
    hits.set(source, recent);
    if (hits.size > 10000) for (const [key, times] of hits) if (at - times[times.length - 1] >= windowMs) hits.delete(key);
    next();
  };
}

function cardsWithMarker(marker) {
  return [...store.list(), ...store.history()].filter((card) =>
    [card.context, card.text, card.title].some((field) => typeof field === "string" && field.includes(marker)));
}

// Every filed report carries the current F7 prefix; an older game's legacy prefix is replaced.
function reportTitle(title) {
  const prefix = PLAYER_REPORT_TITLE_PREFIXES.find((candidate) => title.startsWith(candidate));
  return PLAYER_REPORT_TITLE_PREFIX + (prefix ? title.slice(prefix.length) : title);
}

function rpcError(res, id, code, message) {
  return res.json({ jsonrpc: "2.0", id: id === undefined ? null : id, error: { code, message } });
}

function createIntakeApp({
  key,
  privateUrl,
  maxBodyBytes = 48 * 1024 * 1024,
  rateLimit = { max: 60, windowMs: 10 * 60 * 1000 },
  now = Date.now,
}) {
  if (typeof key !== "string" || key.length < 32) throw new Error("intake key must be at least 32 characters");
  if (!/^https?:\/\/[^/]+$/.test(privateUrl || "")) throw new Error("privateUrl must be the board's own http(s) root");
  const intake = express();
  intake.disable("x-powered-by");
  intake.set("trust proxy", false);
  intake.use(rateLimiter({ ...rateLimit, now }));
  intake.use((req, res, next) => (keyMatches(key, req.headers[KEY_HEADER]) ? next() : res.status(401).end()));
  intake.use(express.json({ limit: maxBodyBytes }));

  intake.post("/api/upload", (req, res) => {
    const stored = storeUpload(req.body, { mediaPattern: /^image\/png$/ });
    // A card reader opens the save on the private board, not through the intake.
    if (stored.status === 200) stored.body.downloadUrl = privateUrl + stored.body.downloadUrl;
    res.status(stored.status).json(stored.body);
  });

  intake.post("/mcp", (req, res) => {
    const call = req.body || {};
    if (call.jsonrpc !== "2.0" || call.method !== "tools/call" || !call.params || call.params.name !== "create_task")
      return rpcError(res, call.id, -32601, "only tools/call create_task is accepted");
    const { title, context } = call.params.arguments || {};
    if (typeof title !== "string" || typeof context !== "string" || title.length > MAX_TITLE || context.length > MAX_CONTEXT)
      return rpcError(res, call.id, -32602, "title and context are required strings within their limits");
    const marker = (context.match(/\[three-crowns-report:[A-Za-z0-9-]{1,64}\]/) || [""])[0];
    if (!marker) return rpcError(res, call.id, -32602, "context must carry the report marker");
    // A resend of a report the board already holds answers the existing card instead of a duplicate.
    const existing = cardsWithMarker(marker)[0];
    const card = existing || store.createTask({
      title: reportTitle(title),
      context,
      project: PROJECT,
      taskKind: "feedback",
    });
    res.json({ jsonrpc: "2.0", id: call.id === undefined ? null : call.id, result: { content: [{ type: "text", text: card.id }] } });
  });

  intake.get(["/api/reviews", "/api/history"], (req, res) => {
    const marker = typeof req.query.marker === "string" ? req.query.marker : "";
    if (!MARKER.test(marker)) return res.status(400).end();
    const matching = new Set(cardsWithMarker(marker));
    const source = req.path === "/api/history" ? store.history() : store.list();
    res.json(source.filter((card) => matching.has(card)).map((card) => ({ id: card.id, context: marker })));
  });

  intake.use((req, res) => res.status(404).end());
  // A body over the cap or malformed JSON: a bare status, never Express's error page.
  // eslint-disable-next-line no-unused-vars
  intake.use((error, req, res, next) => res.status(error.status === 413 ? 413 : 400).end());
  return intake;
}

module.exports = { createIntakeApp, KEY_HEADER, PROJECT };
