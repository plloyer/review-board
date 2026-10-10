"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const {
  TASK_STATES,
  KIND_TO_STATE,
  stateAfterReply,
  stateAfterAgentReply,
  isBlocked,
  agentMoveNeedsApproval,
  agentApprovalRequiredText,
  retroRequiredText,
  APPROVAL_TEXT_RE,
  currentPlayerReportTitle,
} = require("../shared/lifecycle");
const { agentRequiredText } = require("../shared/agents");
const Questions = require("../shared/questions");

// ponytail: flat JSON file + in-memory array, single local user, no DB needed.
const DATA_DIR = process.env.REVIEW_BOARD_DATA_DIR || path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "messages.json");

// Path comparisons are case-insensitive on win32 (the filesystem is), case-sensitive elsewhere.
function normalizeForCompare(resolved) {
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

// True when an already-resolved path sits inside DATA_DIR — a path there was
// necessarily produced by /api/upload or ingestFile, so it's trusted without
// needing a separate "is this actually referenced" check. Used by mcp.js's
// attachment validation (handing bytes out goes through the narrower gate below).
function isUnderDataDir(resolved) {
  const rel = path.relative(normalizeForCompare(path.resolve(DATA_DIR)), normalizeForCompare(resolved));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function isInsideDirectory(dir, file) {
  const rel = path.relative(normalizeForCompare(dir), normalizeForCompare(file));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

// Every place that hands a file's bytes out (web.js's file routes, mcp.js's
// image blocks) serves only an allowlisted extension under its own roots —
// never the rest of DATA_DIR (VAPID private key, push subscriptions,
// messages.json), never a host path a message merely mentions (anyone on the
// network can post such a message). The extension check holds inside uploads/
// too: ingestFile copies in whatever file the caller points it at.
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
// Inline media (/api/image, MCP image blocks): our uploads/ plus the Windows
// Game Bar captures folder (an archived card still embeds a recording straight
// from it). What real cards use (png/jpg/mp4) plus the other plain web image
// types — never html/svg, which would run script on the board's origin.
const MEDIA_ROOTS = [UPLOADS_DIR, path.join(os.homedir(), "Videos", "Captures")];
const MEDIA_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".mp4"]);
// Downloads (/api/file): uploads/ only — a .tc save, or the media every
// upload's downloadUrl also points at.
const DOWNLOAD_EXTENSIONS = new Set([...MEDIA_EXTENSIONS, ".tc"]);

// The real path to serve, or null. Lexical check first, so a path outside every
// root never touches the disk (no stat of a UNC or arbitrary host path); then
// realpath.native on both sides follows symlinks/junctions and folds 8.3 names
// and case, so no alias or `..` steps outside the root.
function servablePath(p, roots, extensions) {
  if (typeof p !== "string") return null;
  const requested = path.resolve(p);
  const root = roots.find((r) => isInsideDirectory(r, requested));
  if (!root) return null;
  try {
    const real = fs.realpathSync.native(requested);
    return isInsideDirectory(fs.realpathSync.native(root), real) && extensions.has(path.extname(real).toLowerCase()) ? real : null;
  } catch {
    return null; // missing, or not a valid path at all (a NUL byte)
  }
}

const servableMedia = (p) => servablePath(p, MEDIA_ROOTS, MEDIA_EXTENSIONS);
const servableDownload = (p) => servablePath(p, [UPLOADS_DIR], DOWNLOAD_EXTENSIONS);

// One-time migration for messages saved before `state` existed. Human replyTo messages
// are thread-reply delivery vehicles, never rendered as their own card, so they're left
// out of task-land entirely (no state). Mutates in place; the caller saves on next write.
function migrateStates(s) {
  // Cards filed under an older F7 prefix show the current "[F7] " one (PL, 2026-10-06).
  for (const m of [...s.messages, ...(s.history || [])]) m.title = currentPlayerReportTitle(m.title);
  for (const m of s.messages) {
    // F7 reports once waited in a "report_review" intake column for PL's approval;
    // PL dropped that step (2026-10-06): they are ordinary backlog cards now.
    if (m.state === "report_review") m.state = "backlog";
    delete m.reportApproval;
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

function cardSnapshot(value) {
  return new Map([...value.history, ...value.messages].map(card => [card.id, JSON.stringify(card)]));
}

function save(state, metadata = {}) {
  // Card bytes and their replay journal are committed by the SAME atomic rename.
  // A process killed after persistence but before emit is recovered through replay.
  const sequence = state.eventSequence;
  const current = cardSnapshot(state);
  for (const [id, bytes] of current) {
    if (persistedCards.get(id) === bytes) continue;
    const card = JSON.parse(bytes);
    const previous = JSON.parse(persistedCards.get(id) || "null");
    let author = metadata.author || "agent";
    let kind = metadata.kind || "change";
    if (!previous) {
      author = metadata.author || (card.direction === "human" ? "human" : "agent");
      kind = card.replyTo ? "delivery" : "created";
    } else if (JSON.stringify(previous.reply) !== JSON.stringify(card.reply)) {
      author = "human";
      kind = card.reply && card.reply.decision === "approved" ? "approval" : "reply";
    } else if ((card.thread || []).length > (previous.thread || []).length) {
      const entry = card.thread[card.thread.length - 1];
      author = metadata.author || entry.from;
      kind = metadata.kind || (author === "human" ? (APPROVAL_TEXT_RE.test(entry.text.trim()) ? "approval" : "reply") : "agent_reply");
    }
    appendEvent({ cardId: card.replyTo || id, kind, author, state: card.state });
  }
  for (const id of persistedCards.keys()) {
    if (!current.has(id)) appendEvent({ cardId: id, kind: "removed", author: metadata.author || "agent" });
  }
  commitJournal(state, sequence);
  persistedCards = current;
}

// A failed state write takes its journal records back: a long poll must never serve an event a
// restart would forget, or every consumer's cursor would sit past the head (HTTP 409).
function commitJournal(state, sequence) {
  try { writeState(state); }
  catch (error) {
    state.eventJournal = state.eventJournal.filter(event => event.sequence <= sequence);
    state.eventSequence = sequence;
    throw error;
  }
}

function writeState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  const descriptor = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(descriptor, JSON.stringify(state, null, 2));
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  fs.renameSync(tmp, DATA_FILE);
  if (process.platform !== "win32") {
    const directory = fs.openSync(DATA_DIR, "r");
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  }
}

const state = load();
state.eventSequence = state.eventSequence || 0;
state.eventJournal = state.eventJournal || [];
let persistedCards = cardSnapshot(state);

function appendEvent(event) {
  const record = { ...event, sequence: ++state.eventSequence, at: new Date().toISOString() };
  state.eventJournal.push(record);
  return record;
}

function replayEvents(after) {
  return { sequence: state.eventSequence, events: state.eventJournal.filter(event => event.sequence > after).slice(0, 100) };
}

function publishCompletion({ cardId, role, report, digest, verdict, host, key }) {
  if (!state.messages.some(card => card.id === cardId) && !state.history.some(card => card.id === cardId))
    throw new Error("unknown card");
  if (!["builder", "reviewer"].includes(role) || !/^u\d+$/.test(cardId) ||
      !/^(REPORT|REVIEW)(?:-round\d+)?\.md$/.test(report || "") ||
      !/^[a-f0-9]{64}$/.test(digest || "") || !/^[\w.-]{1,100}$/.test(host || "") ||
      typeof verdict !== "string" || !/^[a-z_-]{1,30}$/.test(verdict) ||
      typeof key !== "string" || key.length > 200 || !key.length) throw new Error("invalid completion");
  const allowedVerdicts = role === "builder" ? ["done", "blocked", "red"] : ["accept", "fix", "reject"];
  if (!allowedVerdicts.includes(verdict)) throw new Error("invalid verdict for role");
  const existing = state.eventJournal.find(event => event.key === key);
  if (existing) {
    for (const field of ["cardId", "role", "report", "digest", "verdict", "host"])
      if (existing[field] !== arguments[0][field]) throw new Error("completion key mismatch");
    return existing;
  }
  const sequence = state.eventSequence;
  const event = appendEvent({ cardId, kind: "completion", author: "agent", role, report, digest, verdict, host, key });
  commitJournal(state, sequence);
  emitChange();
  return event;
}
const events = new EventEmitter();
// One listener per open long poll (every subscriber, waiter and watcher): no fixed cap.
events.setMaxListeners(0);

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
  if (kind === "question") Questions.requireDecision(context, options, title);
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
  const tags = tagsFromText(text);
  if (tags) msg.tags = tags;
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

const PRIORITIES = [0, 1, 2, 3];

// Tags say who CAN take a card (windows / mac / linux / unity / a machine
// name); no tag = anyone. Lowercased, deduped; an empty result clears them.
function normalizeTags(tags) {
  const out = [...new Set((tags || []).map((t) => String(t).trim().toLowerCase()).filter(Boolean))];
  return out.length ? out : undefined;
}

// A human types "#linux" or "#3c-unity" in his text: derived tags, text untouched.
const TAG_WORD_RE = /(?:^|\s)#([a-z0-9][a-z0-9-]*)\b/gi;
function tagsFromText(text) {
  return normalizeTags([...String(text || "").matchAll(TAG_WORD_RE)].map((m) => m[1]));
}

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

function setPriority(id, priority, actor = "agent") {
  const msg = state.messages.find((m) => m.id === id);
  if (!msg) throw new Error(`No message ${id}`);
  validatePriority(priority);
  msg.priority = priority;
  save(state, { author: actor, kind: "priority" });
  emitChange();
  return msg;
}

// A project task or player feedback filed through create_task. Reuses the human-message shape
// (direction "human") purely so the existing thread/seen/archive machinery
// (agentReply, humanThreadNote, markThreadSeen, archive) works on it unmodified;
// `createdBy` marks the origin and `taskKind` tells it apart from filed feedback.
function createTask({ title, context, project, blockedBy, priority, noReview, tags, taskKind = "projet" }) {
  if (!["projet", "feedback"].includes(taskKind)) throw new Error(`Invalid taskKind ${taskKind}`);
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
    taskKind,
    state: "backlog",
    thread: [],
    status: "open",
    createdAt: new Date().toISOString(),
  };
  if (blockedBy && blockedBy.length) msg.blockedBy = assignBlockers(id, blockedBy);
  if (priority !== undefined) msg.priority = priority;
  const normalizedTags = normalizeTags(tags);
  if (normalizedTags) msg.tags = normalizedTags;
  // Opt-out, at creation: some tasks legitimately never need his review before
  // landing/closing (see agentMoveNeedsApproval) — still an ordinary visible card.
  if (noReview) msg.noReview = true;
  state.messages.push(msg);
  save(state, { author: "agent", kind: "created" });
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
  const { blockedBy, priority, actor = "human", agent, tags } = opts;
  if (!TASK_STATES.includes(newState)) throw new Error(`Unknown state ${newState}`);
  const msg = state.messages.find((m) => m.id === id);
  if (!msg) throw new Error(`No message ${id}`);
  validatePriority(priority);
  if (newState === "questions") {
    const decision = note ? Questions.requireDecision(note) : Questions.latest(msg);
    if (!decision || decision.error) throw new Error("OWNER DECISION REQUIRED: provide one current question; progress belongs in En cours");
  }

  // The bypass this gate exists to close: an agent moving straight to landing/
  // closed, skipping the human's approbation review. Only actor "agent" is
  // gated — the web route (human dragging a card) never passes actor, so it
  // stays unrestricted. Thrown before any mutation below.
  if (actor === "agent" && agentMoveNeedsApproval(msg, newState)) {
    throw new Error(agentApprovalRequiredText(id, newState));
  }

  // Closing needs a retrospective too — about the WORK, not the review, so it
  // applies regardless of landing state or no_review (a landing card still
  // needs its retro to close). Checked after the approval gate, before any
  // mutation, so a doubly-failing card reports approval first. This is the
  // gate that closes the move_task({state:"closed"}) bypass around
  // close_issue's own retro check.
  if (actor === "agent" && newState === "closed" && !msg.retro) {
    throw new Error(retroRequiredText(id));
  }

  // The board draws who works a card; an agent entering in_progress declares
  // itself unless the card already carries a declaration (re-entry after a refusal).
  if (actor === "agent" && newState === "in_progress" && !agent && !msg.agent) {
    throw new Error(agentRequiredText(id));
  }

  // Validated before any mutation below: a bad blocker id must not leave a
  // half-moved card in memory.
  const blockers = blockedBy !== undefined ? assignBlockers(id, blockedBy) : undefined;

  // Snapshot dependents' blocked status BEFORE this card's state changes, so an
  // entry into landing/closed can be told apart from a no-op re-move.
  const dependents = state.messages.filter((m) => (m.blockedBy || []).includes(id));
  const wasBlocked = new Map(dependents.map((d) => [d.id, isBlocked(d, state.messages)]));

  if (newState === "in_progress" && msg.state !== "in_progress") msg.startedAt = new Date().toISOString();
  if (newState !== msg.state) msg.stateSince = new Date().toISOString();
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
  if (note) msg.thread = [...(msg.thread || []), { from: "agent", text: note, kind: newState === "questions" ? "question" : "update", at: new Date().toISOString() }];
  if (blockers !== undefined) msg.blockedBy = blockers;
  if (priority !== undefined) msg.priority = priority;
  // Back in backlog nobody works the card; elsewhere the last declaration stays
  // (a closed card still tells who did the work).
  if (newState === "backlog") delete msg.agent;
  if (agent) msg.agent = agent;
  if (tags !== undefined) {
    const normalized = normalizeTags(tags);
    if (normalized) msg.tags = normalized;
    else delete msg.tags;
  }

  if (newState === "landing" || newState === "closed") queueUnblockNotices(dependents, wasBlocked);

  save(state, { kind: "move", author: actor });
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

function withdraw(ids, actor = "agent") {
  const idSet = new Set(ids);
  // A withdrawn id can itself be someone's blocker (freeing dependents) and/or
  // carry its own pending unblock notice (now moot — it's leaving the board).
  const dependents = state.messages.filter((m) => !idSet.has(m.id) && (m.blockedBy || []).some((b) => idSet.has(b)));
  const wasBlocked = new Map(dependents.map((d) => [d.id, isBlocked(d, state.messages)]));
  const before = state.messages.length;
  state.messages = state.messages.filter((m) => !idSet.has(m.id));
  state.pendingUnblockNotices = state.pendingUnblockNotices.filter((n) => !idSet.has(n.id));
  queueUnblockNotices(dependents, wasBlocked);
  save(state, { author: actor, kind: "removed" });
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

// Separator between retro rounds appended by mergeRetro — visually distinct
// from the markdown body so multiple rounds stay legible and separable when
// mined later.
const RETRO_SEPARATOR = "\n\n---\n\n";

// Adds one retro round to a card: no existing retro -> set; identical text (or
// text that's already the current tail) -> no-op, so a retried done/close
// never duplicates a round already recorded; otherwise append, so every round
// survives for mining rather than a later one clobbering an earlier one.
// Shared by agentReply's done-path and setRetro — the one place this policy
// lives.
function mergeRetro(msg, text) {
  if (!msg.retro) {
    msg.retro = text;
    return;
  }
  const tailIdx = msg.retro.lastIndexOf(RETRO_SEPARATOR);
  const tail = tailIdx === -1 ? msg.retro : msg.retro.slice(tailIdx + RETRO_SEPARATOR.length);
  if (tail === text) return;
  msg.retro = `${msg.retro}${RETRO_SEPARATOR}${text}`;
}

// Agent tells the human an issue they filed is resolved, without removing the card —
// the human archives it themselves once satisfied. Also applies the kind's kanban
// transition (question -> questions, done -> approbation, update -> no move) so
// callers (mcp.js) don't have to — the transition policy lives here, once.
function agentReply(id, text, kind = "update", opts = {}) {
  const { retro, agent } = opts;
  const msg = state.messages.find((m) => m.id === id);
  if (!msg) throw new Error(`No message ${id}`);
  if (msg.direction !== "human") throw new Error(`Message ${id} is not a human message`);
  if (kind === "question") Questions.requireDecision(text);
  msg.thread = [...(msg.thread || []), { from: "agent", text, kind, at: new Date().toISOString() }];
  const next = stateAfterAgentReply(kind);
  // Never backward out of closed/landing, same as stateAfterReply's guard — a
  // card that already shipped or is on its way stays put; the reply itself is
  // still recorded above.
  if (next && msg.state !== "closed" && msg.state !== "landing") msg.state = next;
  // Retro capture at delivery time: only a "done" delivery carries the worker's
  // retrospective (the whole point is it's written by whoever just finished the
  // work, while they're still around to write it) — a "question"/"update" retro
  // param would be premature and is silently ignored.
  if (kind === "done" && retro) mergeRetro(msg, retro);
  if (agent) msg.agent = agent;
  save(state);
  emitChange();
  return msg;
}

// Attaches a card's retrospective after the fact (appending onto any it
// already carries, via mergeRetro) — e.g. close_issue accepting one late,
// whether the card's done-delivery never carried one (the subagent that did
// the work may be long gone by close time) or it did and this is one more
// round. Works on any live card, agent- or human-direction.
function setRetro(id, text) {
  const msg = state.messages.find((m) => m.id === id);
  if (!msg) throw new Error(`No message ${id}`);
  mergeRetro(msg, text);
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
  msg.thread = [...(msg.thread || []), { from: "human", text, at: new Date().toISOString() }];
  // His answer IS what a questions-state card was waiting for — it goes back to
  // work automatically instead of squatting the Questions column answered.
  if (msg.state === "questions") msg.state = "in_progress";
  save(state, { author: "human" });
  emitChange();
  return msg;
}


// Human-only board action: the delivered build still had issues even though the
// card was already closed (or landing, waiting on a build that hasn't confirmed
// yet) — send it back to backlog for a fresh cycle. Never called by the agent/MCP
// (see web.js's /reopen route: actor human, no gate).
//
// A fresh cycle means the PRIOR approval must be retracted, or agentMoveNeedsApproval
// (shared/lifecycle.js) would let the agent skip straight back to landing/closed
// without re-earning it: an agent-direction card records approval as reply.decision
// (cleared here, rest of reply kept as history), while a human-direction card's
// approval is read off the latest human thread entry — appending this note as the
// new tail already retracts it there (approvedByHuman never reads reply.decision
// on a human-direction card), so nothing else is needed on that side.
function reopen(id, note) {
  const msg = state.messages.find((m) => m.id === id);
  if (!msg) throw new Error(`No message ${id}`);
  if (msg.state !== "closed" && msg.state !== "landing") {
    throw new Error(`${id} can't be reopened from state "${msg.state}" — only a closed or landing card can be reopened`);
  }
  msg.state = "backlog";
  msg.stateSince = new Date().toISOString();
  delete msg.agent;
  if (msg.direction === "agent") {
    if (msg.reply) msg.reply.decision = undefined;
    // Mirrors moveTask's re-ask path: an answered card sent backward becomes
    // actionable again instead of sitting silently "answered".
    msg.status = "open";
  }
  const text = note && note.trim() ? note.trim() : "Rouvert — le build livré a encore des problèmes";
  msg.thread = [...(msg.thread || []), { from: "human", text, at: new Date().toISOString() }];
  save(state, { author: "human", kind: "reopen" });
  emitChange();
  return msg;
}

// Marks a human message's thread as seen by the human — clears the actionable
// badge/notification state for it without touching the message otherwise.
function markThreadSeen(id) {
  const msg = state.messages.find((m) => m.id === id);
  if (!msg) throw new Error(`No message ${id}`);
  msg.threadSeenAt = new Date().toISOString();
  save(state, { author: "human", kind: "markThreadSeen" });
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
  save(state, { author: "human", kind: "archive" });
  emitChange();
  return msg;
}

module.exports = {
  replayEvents,
  publishCompletion,
  DATA_DIR,
  isUnderDataDir,
  servableMedia,
  servableDownload,
  TASK_STATES,
  addAgentMessage,
  addHumanMessage,
  createTask,
  createChangeRequest,
  moveTask,
  setBlockers,
  setPriority,
  setSummary,
  setRetro,
  reply,
  list,
  peekDeliverable,
  withdraw,
  acknowledge,
  agentReply,
  humanThreadNote,
  reopen,
  markThreadSeen,
  archive,
  history,
  uniqueUploadName,
  events,
};
