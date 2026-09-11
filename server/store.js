"use strict";
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const { TASK_STATES, KIND_TO_STATE, stateAfterReply, stateAfterAgentReply, isBlocked } = require("../shared/lifecycle");

// ponytail: flat JSON file + in-memory array, single local user, no DB needed.
const DATA_DIR = process.env.REVIEW_BOARD_DATA_DIR || path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "messages.json");

// Path comparisons are case-insensitive on win32 (the filesystem is), case-sensitive elsewhere.
function normalizeForCompare(resolved) {
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

// True when an already-resolved path sits inside DATA_DIR — a path there was
// necessarily produced by /api/upload or ingestFile, so it's trusted without
// needing a separate "is this actually referenced" check. Shared by web.js's
// /api/image disclosure gate and mcp.js's attachment validation.
function isUnderDataDir(resolved) {
  const rel = path.relative(normalizeForCompare(path.resolve(DATA_DIR)), normalizeForCompare(resolved));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// One-time migration for messages saved before `state` existed. Human replyTo messages
// are thread-reply delivery vehicles, never rendered as their own card, so they're left
// out of task-land entirely (no state). Mutates in place; the caller saves on next write.
function migrateStates(s) {
  for (const m of s.messages) {
    if (m.state) continue;
    if (m.direction === "human") {
      if (m.replyTo) continue;
      const thread = m.thread || [];
      const last = thread[thread.length - 1];
      if (last && last.from === "agent" && last.kind === "question") m.state = "questions";
      else if (last && last.from === "agent" && last.kind === "done") m.state = "approbation";
      else m.state = "in_progress";
    } else if (m.direction === "agent") {
      m.state = KIND_TO_STATE[m.kind] || "questions";
    }
  }
  return s;
}

function load() {
  let raw;
  try {
    raw = fs.readFileSync(DATA_FILE, "utf8");
  } catch {
    return { nextAgentId: 1, nextHumanId: 1, messages: [], history: [], pendingUnblockNotices: [] };
  }
  try {
    const s = JSON.parse(raw);
    if (!s.history) s.history = []; // back-compat with files written before history existed
    if (!s.pendingUnblockNotices) s.pendingUnblockNotices = []; // back-compat, ditto
    return migrateStates(s);
  } catch (err) {
    // File exists but is corrupt (e.g. killed mid-write) — never silently drop it.
    const backup = `${DATA_FILE}.corrupt-${Date.now()}`;
    try {
      fs.copyFileSync(DATA_FILE, backup);
    } catch (copyErr) {
      console.error(`review-board: failed to back up corrupt ${DATA_FILE}:`, copyErr);
    }
    console.error(`review-board: ${DATA_FILE} is corrupt, backed up to ${backup} and starting fresh:`, err);
    return { nextAgentId: 1, nextHumanId: 1, messages: [], history: [], pendingUnblockNotices: [] };
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
    state: KIND_TO_STATE[kind] || "questions",
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
  // A replyTo message is a delivery vehicle, not a card — it stays out of task-land.
  if (!replyTo) {
    msg.taskKind = "feedback";
    msg.state = "backlog";
  }
  state.messages.push(msg);
  save(state);
  emitChange();
  return msg;
}

const PRIORITIES = [1, 2, 3];

function validatePriority(priority) {
  if (priority !== undefined && !PRIORITIES.includes(priority)) throw new Error(`Invalid priority ${priority}`);
}

// DFS over the blockedBy graph (id -> its blocker ids) looking for a path that
// leads back to startId — used to reject a blockedBy assignment that would
// create a cycle. Returns the cycle as an array of ids (startId ... startId),
// or null.
function findBlockerCycle(startId, blockedByMap) {
  function walk(node, path) {
    for (const next of blockedByMap.get(node) || []) {
      if (next === startId) return [...path, next];
      if (path.includes(next)) continue;
      const found = walk(next, [...path, next]);
      if (found) return found;
    }
    return null;
  }
  return walk(startId, [startId]);
}

// Validates a blockedBy assignment (every id must exist as a live message, no
// self-reference, no cycle through the existing graph) and returns it — shared
// by setBlockers, createTask and moveTask so the rule lives in one place.
function assignBlockers(id, ids) {
  for (const bid of ids) {
    if (bid === id) throw new Error(`${id} cannot block itself`);
    if (!state.messages.some((m) => m.id === bid)) throw new Error(`No message ${bid}`);
  }
  const blockedByMap = new Map(state.messages.map((m) => [m.id, m.blockedBy || []]));
  blockedByMap.set(id, ids);
  const cycle = findBlockerCycle(id, blockedByMap);
  if (cycle) throw new Error(`Setting blockers for ${id} would create a cycle: ${cycle.join(" -> ")}`);
  return ids;
}

// Replaces a card's blockers (empty list = unblock). Validated, saved, emitted.
function setBlockers(id, ids) {
  const msg = state.messages.find((m) => m.id === id);
  if (!msg) throw new Error(`No message ${id}`);
  msg.blockedBy = assignBlockers(id, ids);
  // Re-blocking a card makes any earlier "you're unblocked" notice for it
  // stale/misleading — drop it. (A card that's still unblocked keeps its
  // pending notice untouched.)
  if (isBlocked(msg, state.messages)) {
    state.pendingUnblockNotices = state.pendingUnblockNotices.filter((n) => n.id !== id);
  }
  save(state);
  emitChange();
  return msg;
}

function setPriority(id, priority) {
  const msg = state.messages.find((m) => m.id === id);
  if (!msg) throw new Error(`No message ${id}`);
  validatePriority(priority);
  msg.priority = priority;
  save(state);
  emitChange();
  return msg;
}

// A project task the agent files for itself. Reuses the human-message shape
// (direction "human") purely so the existing thread/seen/archive machinery
// (agentReply, humanThreadNote, markThreadSeen, archive) works on it unmodified;
// `createdBy` marks the origin and `taskKind` tells it apart from filed feedback.
function createTask({ title, context, project, blockedBy, priority }) {
  const id = `u${state.nextHumanId++}`;
  validatePriority(priority);
  const msg = {
    id,
    direction: "human",
    kind: "message",
    title,
    context: context || "",
    project: project || "",
    images: [],
    replyTo: null,
    createdBy: "agent",
    taskKind: "projet",
    state: "backlog",
    thread: [],
    status: "open",
    createdAt: new Date().toISOString(),
  };
  if (blockedBy && blockedBy.length) msg.blockedBy = assignBlockers(id, blockedBy);
  if (priority !== undefined) msg.priority = priority;
  state.messages.push(msg);
  save(state);
  emitChange();
  return msg;
}

// A change request an agent files about the board itself, filed as a plain
// human-shaped card so it rides the same thread/seen/archive machinery as any
// other card — never built by the agent, only proposed for the human to action.
function createChangeRequest({ title, details }) {
  const id = `u${state.nextHumanId++}`;
  const msg = {
    id,
    direction: "human",
    kind: "message",
    title,
    context: details || "",
    project: "",
    images: [],
    replyTo: null,
    createdBy: "agent",
    taskKind: "change-request",
    state: "backlog",
    thread: [],
    status: "open",
    createdAt: new Date().toISOString(),
  };
  state.messages.push(msg);
  save(state);
  emitChange();
  return msg;
}

// Moves a task/card to a new kanban state, optionally dropping a thread note
// (same shape agentReply appends) and/or replacing its blockers/priority. Works
// on any card id, human or agent-created.
function moveTask(id, newState, note, opts = {}) {
  const { blockedBy, priority } = opts;
  if (!TASK_STATES.includes(newState)) throw new Error(`Unknown state ${newState}`);
  const msg = state.messages.find((m) => m.id === id);
  if (!msg) throw new Error(`No message ${id}`);
  validatePriority(priority);

  // Snapshot dependents' blocked status BEFORE this card's state changes, so an
  // entry into landing/closed can be told apart from a no-op re-move.
  const dependents = state.messages.filter((m) => (m.blockedBy || []).includes(id));
  const wasBlocked = new Map(dependents.map((d) => [d.id, isBlocked(d, state.messages)]));

  msg.state = newState;
  // Re-ask: an agent card the human already answered, sent back to "questions"
  // for another round. Without this, `status` stays "answered" and the badge/
  // notifier (main.js, keyed off direction=agent + status=open) never fires
  // again — the card would sit there needing a fresh answer with no visible sign.
  if (newState === "questions" && msg.direction === "agent" && msg.status === "answered") {
    msg.status = "open";
    delete msg.acknowledgedAt;
    delete msg.readAt;
  }
  // Closing must also stop redelivery, same as acknowledge() — a card can be closed
  // without ever having gone through await_replies/acknowledge first.
  if (newState === "closed") {
    const now = new Date().toISOString();
    if (!msg.acknowledgedAt) msg.acknowledgedAt = now;
    if (!msg.readAt) msg.readAt = now;
  }
  if (note) msg.thread = [...(msg.thread || []), { from: "agent", text: note, kind: "update", at: new Date().toISOString() }];
  if (blockedBy !== undefined) msg.blockedBy = assignBlockers(id, blockedBy);
  if (priority !== undefined) msg.priority = priority;

  if (newState === "landing" || newState === "closed") queueUnblockNotices(dependents, wasBlocked);

  save(state);
  emitChange();
  return msg;
}

// A blocker landing/closing — or simply disappearing (withdrawn/archived) —
// can fully clear a dependent's blocked state; queue a one-shot notice for
// each dependent that just crossed that line. Shared by every path that can
// change a card's active-blocker status: moveTask (incl. close_issue) and
// reply() gate the call on the new state reaching landing/closed; withdraw()
// and archive() call it unconditionally since removing a card unblocks
// regardless of what state it was in.
function queueUnblockNotices(dependents, wasBlocked) {
  for (const dep of dependents) {
    if (!wasBlocked.get(dep.id) || isBlocked(dep, state.messages)) continue;
    if (state.pendingUnblockNotices.some((n) => n.id === dep.id)) continue;
    state.pendingUnblockNotices.push({ id: dep.id, at: new Date().toISOString() });
  }
}

function setSummary(id, text) {
  const msg = state.messages.find((m) => m.id === id);
  if (!msg) throw new Error(`No message ${id}`);
  msg.summary = text;
  save(state);
  emitChange();
  return msg;
}

function reply(id, { text, optionChosen, images, decision }) {
  const msg = state.messages.find((m) => m.id === id);
  if (!msg) throw new Error(`No message ${id}`);
  if (msg.direction !== "agent") throw new Error(`Message ${id} is not an agent message`);
  const dependents = state.messages.filter((m) => (m.blockedBy || []).includes(id));
  const wasBlocked = new Map(dependents.map((d) => [d.id, isBlocked(d, state.messages)]));
  msg.status = "answered";
  msg.state = stateAfterReply(msg.state, decision);
  msg.reply = {
    text: text || "",
    optionChosen: optionChosen || null,
    images: images || [],
    decision: decision || null,
    at: new Date().toISOString(),
  };
  if (msg.state === "landing" || msg.state === "closed") queueUnblockNotices(dependents, wasBlocked);
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
  const deliverableIds = new Set(deliverable.map((m) => m.id));
  // Unblock notices ride alongside the normal deliverable items — synthetic,
  // never stamped (no lastDeliveredAt of their own), so they keep coming back
  // on every call until acknowledge_messages(cardId) removes them. A card
  // that's independently deliverable this round already carries the real
  // content — the notice would just be a redundant, duplicate-id entry; the
  // real delivery supersedes it (acknowledging the card's own id prunes the
  // notice too, same as always).
  const notices = state.pendingUnblockNotices
    .filter((n) => !deliverableIds.has(n.id))
    .map((n) => ({ id: n.id, unblockNotice: true }));
  if (deliverable.length > 0) {
    const lastDeliveredAt = new Date().toISOString();
    for (const m of deliverable) m.lastDeliveredAt = lastDeliveredAt;
    save(state);
    emitChange();
  }
  return [...deliverable, ...notices];
}

function isDeliverable(m) {
  return (
    (m.direction === "agent" && m.status === "answered" && !m.acknowledgedAt) ||
    (m.direction === "human" && m.status === "open" && !m.acknowledgedAt)
  );
}

function history() {
  return state.history;
}

function withdraw(ids) {
  const idSet = new Set(ids);
  // A withdrawn id can itself be someone's blocker (freeing dependents) and/or
  // carry its own pending unblock notice (now moot — it's leaving the board).
  const dependents = state.messages.filter((m) => !idSet.has(m.id) && (m.blockedBy || []).some((b) => idSet.has(b)));
  const wasBlocked = new Map(dependents.map((d) => [d.id, isBlocked(d, state.messages)]));
  const before = state.messages.length;
  state.messages = state.messages.filter((m) => !idSet.has(m.id));
  state.pendingUnblockNotices = state.pendingUnblockNotices.filter((n) => !idSet.has(n.id));
  queueUnblockNotices(dependents, wasBlocked);
  save(state);
  emitChange();
  return before - state.messages.length;
}

// The agent confirms receipt of a deliverable item. An AGENT reply only retires to
// history once its kanban state is "closed" (or has no state — legacy data): the
// columns are the source of truth now, so a card still active elsewhere (questions/
// in_progress/approbation/landing) stays in the live queue, same as a HUMAN message —
// acknowledgedAt/readAt stamped so it stops being re-delivered. It leaves the board
// only via archive() (the human's own action), close_issue/move_task to closed, or
// withdraw().
function acknowledge(ids) {
  const idSet = new Set(ids);
  const acked = state.messages.filter((m) => idSet.has(m.id) && isDeliverable(m));
  const noticesBefore = state.pendingUnblockNotices.length;
  state.pendingUnblockNotices = state.pendingUnblockNotices.filter((n) => !idSet.has(n.id));
  const noticesRemoved = noticesBefore - state.pendingUnblockNotices.length;
  if (acked.length === 0 && noticesRemoved === 0) return 0;
  const now = new Date().toISOString();
  // A replyTo human message is a thread reply's delivery vehicle — it has no card on
  // the board, so once acknowledged it retires to history like a closed agent card.
  const retiring = acked.filter((m) => m.replyTo || (m.direction === "agent" && (!m.state || m.state === "closed")));
  const retiringIds = new Set(retiring.map((m) => m.id));
  for (const m of acked) {
    if (!retiringIds.has(m.id)) {
      m.readAt = now;
      m.acknowledgedAt = now;
    }
  }
  if (retiring.length > 0) {
    state.messages = state.messages.filter((m) => !retiringIds.has(m.id));
    state.history.push(...retiring.map((m) => ({ ...m, deliveredAt: now })));
  }
  save(state);
  emitChange();
  return acked.length + noticesRemoved;
}

// Agent tells the human an issue they filed is resolved, without removing the card —
// the human archives it themselves once satisfied. Also applies the kind's kanban
// transition (question -> questions, done -> approbation, update -> no move) so
// callers (mcp.js) don't have to — the transition policy lives here, once.
function agentReply(id, text, kind = "update") {
  const msg = state.messages.find((m) => m.id === id);
  if (!msg) throw new Error(`No message ${id}`);
  if (msg.direction !== "human") throw new Error(`Message ${id} is not a human message`);
  msg.thread = [...(msg.thread || []), { from: "agent", text, kind, at: new Date().toISOString() }];
  const next = stateAfterAgentReply(kind);
  // Never backward out of closed/landing, same as stateAfterReply's guard — a
  // card that already shipped or is on its way stays put; the reply itself is
  // still recorded above.
  if (next && msg.state !== "closed" && msg.state !== "landing") msg.state = next;
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
  // His answer IS what a questions-state card was waiting for — it goes back to
  // work automatically instead of squatting the Questions column answered.
  if (msg.state === "questions") msg.state = "in_progress";
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

// Human archives any live card off the board, regardless of direction or read state —
// it's the human's own board-cleanup action.
function archive(id) {
  const msg = state.messages.find((m) => m.id === id);
  if (!msg) throw new Error(`No message ${id}`);
  // Same as withdraw(): archiving an active blocker can free its dependents;
  // archiving a card cancels its own now-moot pending notice, if any.
  const dependents = state.messages.filter((m) => m.id !== id && (m.blockedBy || []).includes(id));
  const wasBlocked = new Map(dependents.map((d) => [d.id, isBlocked(d, state.messages)]));
  state.messages = state.messages.filter((m) => m.id !== id);
  state.pendingUnblockNotices = state.pendingUnblockNotices.filter((n) => n.id !== id);
  queueUnblockNotices(dependents, wasBlocked);
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
  isUnderDataDir,
  TASK_STATES,
  addAgentMessage,
  addHumanMessage,
  createTask,
  createChangeRequest,
  moveTask,
  setBlockers,
  setPriority,
  setSummary,
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
