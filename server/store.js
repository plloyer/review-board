"use strict";
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");

// ponytail: flat JSON file + in-memory array, single local user, no DB needed.
const DATA_DIR = process.env.REVIEW_BOARD_DATA_DIR || path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "messages.json");

function load() {
  let raw;
  try {
    raw = fs.readFileSync(DATA_FILE, "utf8");
  } catch {
    return { nextAgentId: 1, nextHumanId: 1, messages: [], history: [] };
  }
  try {
    const s = JSON.parse(raw);
    if (!s.history) s.history = []; // back-compat with files written before history existed
    return s;
  } catch (err) {
    // File exists but is corrupt (e.g. killed mid-write) — never silently drop it.
    const backup = `${DATA_FILE}.corrupt-${Date.now()}`;
    try {
      fs.copyFileSync(DATA_FILE, backup);
    } catch (copyErr) {
      console.error(`review-board: failed to back up corrupt ${DATA_FILE}:`, copyErr);
    }
    console.error(`review-board: ${DATA_FILE} is corrupt, backed up to ${backup} and starting fresh:`, err);
    return { nextAgentId: 1, nextHumanId: 1, messages: [], history: [] };
  }
}

function save(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

const state = load();
const events = new EventEmitter();

function emitChange() {
  events.emit("change");
}

// Collision-proof destination path: if dir/baseName exists, append -1, -2… before
// the extension (same approach as main.js's download dedupedPath).
function uniqueUploadName(dir, baseName) {
  let candidate = path.join(dir, baseName);
  if (!fs.existsSync(candidate)) return candidate;
  const ext = path.extname(baseName);
  const base = baseName.slice(0, baseName.length - ext.length);
  let n = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base}-${n}${ext}`);
    n++;
  }
  return candidate;
}

// Copies a locally-reachable attachment into our own uploads/ so the source (often a
// scratch dir) can be cleaned without breaking the render. Unreachable (e.g. remote-machine)
// paths are left as-is — same collision-proof naming as /api/upload in web.js.
function ingestFile(entry) {
  if (!entry || !entry.path || !fs.existsSync(entry.path)) return entry;
  const dir = path.join(DATA_DIR, "uploads");
  fs.mkdirSync(dir, { recursive: true });
  const safeName = `${Date.now()}-${path.basename(entry.path).replace(/[^a-zA-Z0-9.\-_]/g, "_")}`;
  const dest = uniqueUploadName(dir, safeName);
  fs.copyFileSync(entry.path, dest);
  return { ...entry, path: dest };
}

function addAgentMessage({ title, kind = "review", options, context, details, images, videos, project }) {
  const id = `r${state.nextAgentId++}`;
  const msg = {
    id,
    direction: "agent",
    kind,
    title,
    options: options || [],
    context: context || "",
    details: details || [],
    images: (images || []).map(ingestFile),
    videos: (videos || []).map(ingestFile),
    project: project || "",
    status: "open",
    createdAt: new Date().toISOString(),
    reply: null,
  };
  state.messages.push(msg);
  save(state);
  emitChange();
  return msg;
}

function addHumanMessage(text, images, replyTo) {
  const id = `u${state.nextHumanId++}`;
  const msg = {
    id,
    direction: "human",
    kind: "message",
    title: text,
    images: images || [],
    // Set when this message is the delivery vehicle of a reply typed on another
    // card's thread — the board hides it (the thread note is what's shown) but
    // the agent still receives it through the normal deliverable flow.
    replyTo: replyTo || null,
    status: "open",
    createdAt: new Date().toISOString(),
  };
  state.messages.push(msg);
  save(state);
  emitChange();
  return msg;
}

function reply(id, { text, optionChosen, images, decision }) {
  const msg = state.messages.find((m) => m.id === id);
  if (!msg) throw new Error(`No message ${id}`);
  if (msg.direction !== "agent") throw new Error(`Message ${id} is not an agent message`);
  msg.status = "answered";
  msg.reply = {
    text: text || "",
    optionChosen: optionChosen || null,
    images: images || [],
    decision: decision || null,
    at: new Date().toISOString(),
  };
  save(state);
  emitChange();
  return msg;
}

function list() {
  return state.messages;
}

// Everything "deliverable" to the agent (answered agent-messages + open human-messages).
// At-least-once delivery: this is a non-destructive peek — items stay in the live queue
// (stamped with lastDeliveredAt) until the agent explicitly calls acknowledge().
function peekDeliverable() {
  const deliverable = state.messages.filter(isDeliverable);
  if (deliverable.length === 0) return [];
  const lastDeliveredAt = new Date().toISOString();
  for (const m of deliverable) m.lastDeliveredAt = lastDeliveredAt;
  save(state);
  emitChange();
  return deliverable;
}

function isDeliverable(m) {
  return (
    (m.direction === "agent" && m.status === "answered") ||
    (m.direction === "human" && m.status === "open" && !m.acknowledgedAt)
  );
}

function history() {
  return state.history;
}

function withdraw(ids) {
  const idSet = new Set(ids);
  const before = state.messages.length;
  state.messages = state.messages.filter((m) => !idSet.has(m.id));
  save(state);
  emitChange();
  return before - state.messages.length;
}

// The agent confirms receipt of a deliverable item. An AGENT reply is done at that
// point and moves to history, same as before. A HUMAN message is different: it's an
// issue the human filed, and merely being read shouldn't make it vanish from their
// board — it stays in the live queue (readAt/acknowledgedAt stamped) but stops being
// re-delivered. It leaves the board only via archive() (the human's own action) or
// withdraw().
function acknowledge(ids) {
  const idSet = new Set(ids);
  const acked = state.messages.filter((m) => idSet.has(m.id) && isDeliverable(m));
  if (acked.length === 0) return 0;
  const now = new Date().toISOString();
  // A replyTo human message is a thread reply's delivery vehicle — it has no
  // card on the board, so once acknowledged it retires to history like an
  // agent message instead of lingering invisibly in the live queue.
  const retiring = acked.filter((m) => m.direction === "agent" || m.replyTo);
  for (const m of acked) {
    if (m.direction === "human" && !m.replyTo) {
      m.readAt = now;
      m.acknowledgedAt = now;
    }
  }
  if (retiring.length > 0) {
    const ackedIds = new Set(retiring.map((m) => m.id));
    state.messages = state.messages.filter((m) => !ackedIds.has(m.id));
    state.history.push(...retiring.map((m) => ({ ...m, deliveredAt: now })));
  }
  save(state);
  emitChange();
  return acked.length;
}

// Agent tells the human an issue they filed is resolved, without removing the card —
// the human archives it themselves once satisfied.
function agentReply(id, text, kind = "update") {
  const msg = state.messages.find((m) => m.id === id);
  if (!msg) throw new Error(`No message ${id}`);
  if (msg.direction !== "human") throw new Error(`Message ${id} is not a human message`);
  msg.thread = [...(msg.thread || []), { from: "agent", text, kind, at: new Date().toISOString() }];
  save(state);
  emitChange();
  return msg;
}

// The human's own answer under an issue's thread (their comment/approval) — the
// delivery to the agent still travels as a separate human message; this entry is
// what the board renders in the thread and what moves the card out of "answer me".
function humanThreadNote(id, text) {
  const msg = state.messages.find((m) => m.id === id);
  if (!msg) throw new Error(`No message ${id}`);
  if (msg.direction !== "human") throw new Error(`Message ${id} is not a human message`);
  msg.thread = [...(msg.thread || []), { from: "human", text, at: new Date().toISOString() }];
  save(state);
  emitChange();
  return msg;
}

// Marks a human message's thread as seen by the human — clears the actionable
// badge/notification state for it without touching the message otherwise.
function markThreadSeen(id) {
  const msg = state.messages.find((m) => m.id === id);
  if (!msg) throw new Error(`No message ${id}`);
  msg.threadSeenAt = new Date().toISOString();
  save(state);
  emitChange();
  return msg;
}

// Human archives their own message off the board, regardless of read state.
function archive(id) {
  const msg = state.messages.find((m) => m.id === id && m.direction === "human");
  if (!msg) throw new Error(`No human message ${id}`);
  state.messages = state.messages.filter((m) => m.id !== id);
  const now = new Date().toISOString();
  // deliveredAt means "an agent actually received this" — only true if it was ever
  // peeked. A message dismissed before that only gets archivedAt.
  const archived = { ...msg, archivedAt: now };
  if (msg.lastDeliveredAt) archived.deliveredAt = now;
  state.history.push(archived);
  save(state);
  emitChange();
  return msg;
}

module.exports = {
  DATA_DIR,
  addAgentMessage,
  addHumanMessage,
  reply,
  list,
  peekDeliverable,
  withdraw,
  acknowledge,
  agentReply,
  humanThreadNote,
  markThreadSeen,
  archive,
  history,
  uniqueUploadName,
  events,
};
