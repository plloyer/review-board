"use strict";
// Single owner of card-lifecycle rules: the kanban states a card moves through,
// the kind/decision -> state mappings, and the "does this need the human back"
// predicates. Dependency-free (no fs/DOM) so it loads unmodified in Node
// (server/store.js, server/mcp.js, main.js) and in the browser (public/app.js,
// public/views.js via window.Lifecycle).

// Wrapped in an IIFE: public/app.js, public/views.js and this file all load as
// plain (non-module) <script> tags sharing ONE global let/const scope in the
// browser — an unwrapped top-level const/function name here would collide with
// the same name declared by another of those files (a real SyntaxError that
// silently kills every script on the page). The IIFE keeps everything but the
// final window.Lifecycle assignment private to this file.
(function () {
// Kanban states a task/card moves through. Agent-initiated r-cards (review/question/note)
// and human-filed cards (feedback + agent-created project tasks) all carry one of these.
// Two names because store.js and app.js grew their own vocabulary before this file
// existed — same array, so validation (store) and column order (board) can never drift.
const TASK_STATES = ["backlog", "in_progress", "questions", "approbation", "landing", "closed"];
const COLUMN_STATES = TASK_STATES;

const STATE_LABEL = {
  backlog: "backlog",
  in_progress: "in progress",
  questions: "questions",
  approbation: "approbation",
  landing: "landing",
  closed: "closed",
};

// A note is a progress update, not a question — it must never land in the
// "questions" column (PL: a question card has to actually contain a question).
const KIND_TO_STATE = { question: "questions", review: "approbation", note: "in_progress" };

// The dot's color is normally the column's own accent, except Backlog (where it
// tells feedback from a project task apart) and Closed (no dot at all, per mock).
function dotColor(msg) {
  if (msg.state === "closed") return null;
  if (msg.state === "backlog") return msg.taskKind === "feedback" ? "#6cbf6c" : "#8a8a90";
  return { in_progress: "#4a90d9", questions: "#d9a441", approbation: "#6cbf6c", landing: "#b08fd9" }[msg.state] || "#8a8a90";
}

// Last thread entry that's an AI question/done — the one shape that needs the
// human back. Split out so callers can use just the shape (regardless of seen
// state, e.g. the Approuver button) while badges/routing use both.
function lastThreadEntry(msg) {
  const thread = msg.thread || [];
  return thread[thread.length - 1];
}

function isActionableThreadEntry(entry) {
  return Boolean(entry) && entry.from === "agent" && (entry.kind === "question" || entry.kind === "done");
}

// True once an actionable entry has landed and the human hasn't seen it yet
// (threadSeenAt cleared/absent, or the entry postdates the last seen stamp).
function unseenActionable(msg) {
  const last = lastThreadEntry(msg);
  return isActionableThreadEntry(last) && last.at > (msg.threadSeenAt || "");
}

// A card in "questions" or "approbation" is awaiting a FRESH decision right
// now, even if `status` is still "answered" from an earlier round (move_task
// can send an already-answered r-card back for another look) — the reply row
// (with Approve/options) belongs then, never the plain followup box, which is
// only for a card that's actually done.
function agentAwaitingDecision(msg) {
  return msg.state === "questions" || msg.state === "approbation";
}

// reply() decision -> next state. Approved -> landing (visible until the fix
// reaches the human's build); anything else = another iteration -> in_progress.
// Never backward out of closed/landing — a card that already shipped or is on
// its way stays put; the reply itself is still recorded by the caller.
function stateAfterReply(current, decision) {
  if (current === "closed" || current === "landing") return current;
  return decision === "approved" ? "landing" : "in_progress";
}

// reply_to_message kind -> the state to auto-move the card to. null means no
// move (kind "update" — a routine, silent progress note).
function stateAfterAgentReply(kind) {
  if (kind === "question") return "questions";
  if (kind === "done") return "approbation";
  return null;
}

// A comment that IS an approval — exactly the approve-in-place flow's wording
// ("Approuvé ✅"), not a longer comment that merely starts with "Approuvé".
// Shared with views.js's tail marker so the two readings can never drift.
const APPROVAL_TEXT_RE = /^approuv[ée]?\s*[!.✅]*$/i;

// Has the human approved this card? Agent-direction cards record it as
// reply.decision (store.reply). Human-direction cards (feedback, projet tasks)
// never get a reply field — his approval is a thread note, so read the LATEST
// HUMAN entry: an agent update posted after his "Approuvé" never cancels it,
// while a later human comment (a change of mind) does.
function approvedByHuman(msg) {
  if (msg.direction === "agent") return (msg.reply || {}).decision === "approved";
  const thread = msg.thread || [];
  for (let i = thread.length - 1; i >= 0; i--) {
    if (thread[i].from === "human") {
      return APPROVAL_TEXT_RE.test(String(thread[i].text || "").trim());
    }
  }
  return false;
}

// True when an AGENT-initiated move to landing/closed needs the human's sign-off
// first — the bypass this predicate exists to close (agents moving cards straight
// from in_progress to landing, skipping the approbation column). A card created
// no_review, or one the human approved (approvedByHuman), is exempt. Never gates
// a human-initiated move (that's the caller's job — see store.moveTask's actor
// option) and never gates any other target state.
function agentMoveNeedsApproval(msg, toState) {
  if (toState !== "landing" && toState !== "closed") return false;
  // The gate charges at the landing door only: a card already in landing was
  // approved to get there (or predates the gate) — closing it is free, never a
  // second approval on the same card.
  if (msg.state === "landing") return false;
  if (msg.noReview) return false;
  return !approvedByHuman(msg);
}

// The ids in msg.blockedBy that are still active blockers: they exist in `all`
// (a card list) and aren't in state landing/closed yet. A blockedBy id absent
// from `all` is not blocking (never found = never blocks).
function activeBlockers(msg, all) {
  const blockedBy = msg.blockedBy || [];
  if (blockedBy.length === 0) return [];
  const byId = new Map(all.map((m) => [m.id, m]));
  return blockedBy.filter((id) => {
    const blocker = byId.get(id);
    return blocker && blocker.state !== "landing" && blocker.state !== "closed";
  });
}

function isBlocked(msg, all) {
  return activeBlockers(msg, all).length > 0;
}

// Every local-path attachment reference embedded in a thread entry's markdown
// text: an already-wrapped /api/image?path=<encoded> target (image or video —
// both ride that one endpoint), or a bare local path used as a markdown
// image's target. An http(s)/data: URL is not a local-path reference and is
// skipped. Dependency-free (just string scanning), shared so web.js's
// disclosure check and mcp.js's send-time validation use exactly one regex
// pair, never two that can drift apart.
function extractPathRefs(text) {
  const s = String(text || "");
  const refs = [];
  for (const m of s.matchAll(/\/api\/image\?path=([^"'&)\s]+)/g)) {
    try {
      refs.push(decodeURIComponent(m[1]));
    } catch {}
  }
  for (const m of s.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = m[1];
    if (/^(https?:|data:|\/api\/image)/i.test(target)) continue;
    refs.push(target);
  }
  return refs;
}

// True when the human's own word is the latest event on a card and the agent
// hasn't reacted to it yet — the "Répondu" subsection (grayed, no action row)
// within each column. Agent-direction: he replied (status "answered") but the
// agent hasn't acknowledged that reply yet — acknowledging (or a fresh
// question landing later) is what flips this back. Human-direction: his own
// thread entry (comment/approval) is the last one — any agent thread entry
// flips it back; a card with no thread yet is never awaitingAgent, it's just
// an ordinary active card.
function awaitingAgent(msg) {
  // Backlog is pull-based: no agent has picked the card up yet, so enriching it
  // is not "waiting on the AI" — it stays an ordinary backlog card until pickup.
  if (msg.state === "backlog") return false;
  // Closed is terminal for the agent: its reaction to the human's approval was
  // the close itself (which writes no thread entry), and the next move — retest,
  // archive — is the human's. A closed card never reads "waiting on the AI".
  if (msg.state === "closed") return false;
  if (msg.direction === "agent") return msg.status === "answered" && !msg.acknowledgedAt;
  const last = lastThreadEntry(msg);
  return Boolean(last) && last.from === "human";
}

const Lifecycle = {
  TASK_STATES,
  COLUMN_STATES,
  STATE_LABEL,
  KIND_TO_STATE,
  dotColor,
  lastThreadEntry,
  isActionableThreadEntry,
  unseenActionable,
  agentAwaitingDecision,
  stateAfterReply,
  stateAfterAgentReply,
  APPROVAL_TEXT_RE,
  approvedByHuman,
  agentMoveNeedsApproval,
  activeBlockers,
  isBlocked,
  extractPathRefs,
  awaitingAgent,
};

if (typeof module !== "undefined") module.exports = Lifecycle;
else window.Lifecycle = Lifecycle;
})();
