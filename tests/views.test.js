"use strict";
// views.js calls the global `marked` (loaded by marked.min.js in the browser) —
// stub it here so the pure derive functions can run in Node.
global.marked = {
  parse: (s) => `<p>${String(s ?? "")}</p>`,
  parseInline: (s) => String(s ?? ""),
};

const test = require("node:test");
const assert = require("node:assert/strict");
const Views = require("../public/views");

test("mdToPlainText strips the stubbed markdown wrapper and collapses whitespace", () => {
  assert.equal(Views.mdToPlainText("hello   world"), "hello world");
});

test("deriveCompactView captures title/summary/state/thread-last/pending counts", () => {
  const msg = {
    id: "r1",
    direction: "agent",
    kind: "review",
    status: "open",
    state: "approbation",
    title: "Fix the login button",
    summary: "Login button fix",
    options: [],
    thread: [{ from: "agent", kind: "done", text: "shipped", at: "2026-01-01T00:00:00.000Z" }],
  };
  const view = Views.deriveCompactView(msg);
  assert.match(view.title, /Login button fix/); // splitSourceTag(summary||title) then esc'd
  assert.match(view.actionsHTML, /Approuver/); // approbation state -> approve/fix actions
  assert.ok(view.sub && /shipped/.test(view.sub.text)); // thread-last surfaces in the subline
});

test("two msgs differing in a rendered field (title) produce different JSON", () => {
  const base = { id: "r1", direction: "agent", kind: "review", status: "open", state: "backlog", title: "A", options: [] };
  const a = JSON.stringify(Views.deriveCompactView(base));
  const b = JSON.stringify(Views.deriveCompactView({ ...base, title: "B" }));
  assert.notEqual(a, b);
});

test("msgs differing only in a NON-rendered field (raw lastDeliveredAt timestamp vs boolean presence) produce identical JSON", () => {
  const base = {
    id: "u1",
    direction: "human",
    status: "open",
    state: "backlog",
    taskKind: "feedback",
    title: "Something broke",
    lastDeliveredAt: "2026-01-01T00:00:00.000Z",
  };
  const later = { ...base, lastDeliveredAt: "2026-01-01T00:05:00.000Z" }; // agent re-polled, restamped
  const a = JSON.stringify(Views.deriveCompactView(base));
  const b = JSON.stringify(Views.deriveCompactView(later));
  assert.equal(a, b, "only Boolean(lastDeliveredAt) may affect the view, never the raw timestamp (anti-churn)");
});

test("deriveCardView renders the answered block only when status is answered", () => {
  const open = { id: "r1", kind: "review", status: "open", title: "T", images: [], videos: [], options: [], details: [] };
  const answered = { ...open, status: "answered", reply: { decision: "approved", text: "ok" } };
  assert.equal(Views.deriveCardView(open).answeredHTML, "");
  assert.match(Views.deriveCardView(answered).answeredHTML, /approved/);
});

test("deriveSentView: cancelable only when neither delivered nor read, subline reflects thread state", () => {
  const fresh = { id: "u1", title: "T" };
  assert.equal(Views.deriveSentView(fresh, false).cancelable, true);
  assert.equal(Views.deriveSentView(fresh, true).cancelable, false);
  const acked = { id: "u1", title: "T", acknowledgedAt: "2026-01-01T00:00:00.000Z" };
  assert.equal(Views.deriveSentView(acked, false).cancelable, false);
  const withQuestion = { id: "u1", title: "T", thread: [{ from: "agent", kind: "question", text: "which one?" }] };
  assert.match(Views.deriveSentView(withQuestion, true).sub, /which one\?/);
});

test("deriveCardCore centralizes dot/title-split/thread-tail shared by every surface", () => {
  const msg = {
    id: "r1",
    direction: "agent",
    kind: "review",
    status: "answered",
    state: "approbation",
    title: "[Bot] Fix the login button",
    summary: "[Bot] Fix the login button",
    options: [],
    thread: [{ from: "agent", kind: "done", text: "shipped", at: "2026-01-01T00:00:00.000Z" }],
    reply: { decision: "approved", text: "ok" },
  };
  const core = Views.deriveCardCore(msg);
  assert.equal(core.sourceTag, "Bot");
  assert.match(core.sourceChip, /source-tag/);
  assert.match(core.shortTitle, /Fix the login button/);
  assert.ok(!core.shortTitle.includes("[Bot]"), "the source tag is stripped out of the short title");
  assert.equal(core.tail.kind, "done");
  assert.match(core.tail.snippet, /shipped/);
});

test("compact and sent views derive their subline from the same thread-tail classification (threadTail), one function instead of two", () => {
  const msg = {
    id: "u1",
    direction: "human",
    status: "open",
    state: "questions",
    title: "Something broke",
    thread: [{ from: "agent", kind: "question", text: "which environment?", at: "2026-01-01T00:00:00.000Z" }],
  };
  const tail = Views.threadTail(msg);
  assert.equal(tail.kind, "question");

  const compact = Views.deriveCompactView(msg);
  const sent = Views.deriveSentView(msg, true);
  // Same underlying snippet reaches both surfaces, even though each keeps its own
  // exact wording/markup (compact: terse "❓ X"; sent: "L'IA a besoin de toi : X").
  assert.match(compact.sub.text, /which environment\?/);
  assert.match(sent.sub, /which environment\?/);
  assert.equal(compact.sub.cls, "sub-question");
  assert.match(sent.sub, /ia-question/);
});

test("deriveCompactView: blocked badge + flag only when blockedBy is non-empty", () => {
  const base = { id: "u1", direction: "human", status: "open", state: "in_progress", title: "Do the thing" };
  const unblocked = Views.deriveCompactView(base, { blockedBy: [] });
  assert.equal(unblocked.blocked, false);
  assert.equal(unblocked.blockedBadge, "");

  const blocked = Views.deriveCompactView(base, { blockedBy: ["u167", "u171"] });
  assert.equal(blocked.blocked, true);
  // One independently clickable/navigable badge per blocker, not one badge
  // listing every id (finding: list/navigate ALL blockers).
  assert.match(blocked.blockedBadge, /data-blocker-id="u167"[^>]*>bloqu\S* par u167</);
  assert.match(blocked.blockedBadge, /data-blocker-id="u171"[^>]*>bloqu\S* par u171</);
});

test("deriveCompactView: priority chip shown on every card (p0-p3), absent treated as p2", () => {
  const base = { id: "u1", direction: "human", status: "open", state: "backlog", taskKind: "feedback", title: "T" };
  assert.match(Views.deriveCompactView(base).priorityChip, /chip-p2/);
  assert.match(Views.deriveCompactView(base).priorityChip, />p2</);
  assert.match(Views.deriveCompactView({ ...base, priority: 2 }).priorityChip, /chip-p2/);
  assert.match(Views.deriveCompactView({ ...base, priority: 1 }).priorityChip, /chip-p1/);
  assert.match(Views.deriveCompactView({ ...base, priority: 3 }).priorityChip, /chip-p3/);
  assert.match(Views.deriveCompactView({ ...base, priority: 0 }).priorityChip, /chip-p0/);
  assert.match(Views.deriveCompactView({ ...base, priority: 0 }).priorityChip, />p0</);
});

test("deriveCompactView: a change-request card gets the MCR chip label", () => {
  const msg = { id: "u1", direction: "human", status: "open", state: "backlog", taskKind: "change-request", title: "Add a feature" };
  const view = Views.deriveCompactView(msg);
  assert.match(view.chip, /chip-change-request/);
  assert.match(view.chip, />MCR</);
});

// --- Répondu subsection (awaitingAgent) -------------------------------------

test("deriveCompactView: an agent-direction awaiting card is grayed, has no action HTML, and carries a marker", () => {
  const msg = {
    id: "r1",
    direction: "agent",
    kind: "review",
    status: "answered",
    state: "landing",
    title: "Fix the login button",
    options: [],
    reply: { decision: "approved", text: "ok", optionChosen: null },
  };
  const view = Views.deriveCompactView(msg);
  assert.equal(view.awaitingAgent, true);
  assert.equal(view.actionsHTML, "");
  assert.match(view.marker, /Approuvé/);
  assert.match(view.sub.text, /ok/);
  assert.match(view.sub.text, /en attente de l'IA/);
});

test("deriveCompactView: a human-direction awaiting card marks a non-approval tail as '✓ toi'", () => {
  const msg = {
    id: "u1",
    direction: "human",
    status: "open",
    state: "in_progress",
    title: "Consignes",
    thread: [{ from: "human", text: "les royaumes favorisés gardent leur aide", at: "2026-01-01T00:00:00.000Z" }],
  };
  const view = Views.deriveCompactView(msg);
  assert.equal(view.awaitingAgent, true);
  assert.equal(view.actionsHTML, "");
  assert.match(view.marker, /✓ toi/);
  assert.doesNotMatch(view.marker, /Approuvé/);
  assert.match(view.sub.text, /royaumes favorisés/);
  assert.match(view.sub.text, /en attente de l'IA/);
});

test("deriveCompactView: a human-direction awaiting card marks '✓ Approuvé' only for an EXACT approval, never a longer comment that merely starts with it", () => {
  const exact = {
    id: "u8",
    direction: "human",
    status: "open",
    state: "in_progress",
    title: "T",
    thread: [{ from: "human", text: "Approuvé ✅", at: "2026-01-01T00:00:00.000Z" }],
  };
  assert.match(Views.deriveCompactView(exact).marker, /✓ Approuvé/);

  const bare = {
    ...exact,
    id: "u9",
    thread: [{ from: "human", text: "approuve", at: "2026-01-01T00:00:00.000Z" }],
  };
  assert.match(Views.deriveCompactView(bare).marker, /✓ Approuvé/);

  const longer = {
    ...exact,
    id: "u10",
    thread: [{ from: "human", text: "Approuvé, mais attention à la régression", at: "2026-01-01T00:00:00.000Z" }],
  };
  const view = Views.deriveCompactView(longer);
  assert.match(view.marker, /✓ toi/);
  assert.doesNotMatch(view.marker, /Approuvé/);
});

test("deriveCompactView: an awaiting card never gets a cancel button, even when it would otherwise read as undelivered", () => {
  // in_progress, not backlog: a backlog card is never awaitingAgent by rule.
  const msg = {
    id: "u2",
    direction: "human",
    status: "open",
    state: "in_progress",
    title: "T",
    thread: [{ from: "human", text: "hi", at: "2026-01-01T00:00:00.000Z" }],
  };
  const view = Views.deriveCompactView(msg);
  assert.equal(view.awaitingAgent, true);
  assert.equal(view.cancelBtn, "");
});

test("deriveCompactView: a closed card with a human tail is an ordinary closed card and keeps Testé ✓ Archiver; awaiting states keep no action at all", () => {
  // A closed card is never awaitingAgent (the agent's reaction to the approval
  // WAS the close) — but the human's archive action must survive regardless.
  const closedHumanTail = {
    id: "u11",
    direction: "human",
    status: "open",
    state: "closed",
    title: "T",
    thread: [{ from: "human", text: "ok", at: "2026-01-01T00:00:00.000Z" }],
  };
  const view = Views.deriveCompactView(closedHumanTail);
  assert.equal(view.awaitingAgent, false);
  assert.match(view.actionsHTML, /archive-link-btn/);
  assert.match(view.actionsHTML, /Testé ✓ Archiver/);

  const inProgressAwaiting = { ...closedHumanTail, id: "u12", state: "in_progress" };
  assert.equal(Views.deriveCompactView(inProgressAwaiting).awaitingAgent, true);
  assert.equal(Views.deriveCompactView(inProgressAwaiting).actionsHTML, "");
});

test("deriveCompactView: a card that isn't awaitingAgent keeps its normal action row", () => {
  const msg = { id: "r1", direction: "agent", kind: "review", status: "open", state: "approbation", title: "T", options: [] };
  const view = Views.deriveCompactView(msg);
  assert.equal(view.awaitingAgent, false);
  assert.equal(view.marker, "");
  assert.match(view.actionsHTML, /Approuver/);
});

test("deriveOverlayView switches body by direction and includes the state label", () => {
  const agentMsg = { id: "r1", direction: "agent", kind: "review", status: "open", state: "questions", title: "T", options: [], details: [], images: [], videos: [] };
  const view = Views.deriveOverlayView(agentMsg);
  assert.match(view.headerHTML, />questions</);
  assert.match(view.footerHTML, /reply-text/);

  const humanMsg = { id: "u1", direction: "human", state: "backlog", title: "T", images: [] };
  const humanView = Views.deriveOverlayView(humanMsg);
  assert.match(humanView.footerHTML, /comment-text/);
});

test("deriveOverlayView: header shows the blocked badge (all active blockers) and the priority chip, like the compact card", () => {
  const msg = { id: "u15", direction: "human", state: "in_progress", status: "open", title: "T", priority: 1, images: [] };
  const view = Views.deriveOverlayView(msg, { blockedBy: ["b1", "b2"] });
  assert.match(view.headerHTML, /data-blocker-id="b1"/);
  assert.match(view.headerHTML, /data-blocker-id="b2"/);
  assert.match(view.headerHTML, /chip-p1/);

  const unblocked = Views.deriveOverlayView({ ...msg, id: "u16" }, { blockedBy: [] });
  assert.doesNotMatch(unblocked.headerHTML, /blocked-badge/);
});

test("deriveOverlayView: a BACKLOG card shows the four-button priority selector instead of the pill, current level active (absent -> P2)", () => {
  const backlog = { id: "u30", direction: "human", state: "backlog", title: "T", images: [] };
  const view = Views.deriveOverlayView(backlog);
  assert.match(view.headerHTML, /id="overlayPrio"/);
  assert.match(view.headerHTML, /data-priority="2"[^>]*>P2</); // rendered as active below
  assert.match(view.headerHTML, /class="prio-set active chip-p2" data-priority="2"/);
  assert.doesNotMatch(view.headerHTML, /class="chip chip-prio chip-p2">p2</); // pill absent
  for (const n of [0, 1, 3]) assert.doesNotMatch(view.headerHTML, new RegExp(`prio-set active chip-p${n}`));

  const p0 = Views.deriveOverlayView({ ...backlog, id: "u31", priority: 0 });
  assert.match(p0.headerHTML, /class="prio-set active chip-p0" data-priority="0"/);
  assert.doesNotMatch(p0.headerHTML, /prio-set active chip-p2/);
});

test("deriveOverlayView: a non-backlog card keeps the plain priority pill, no selector", () => {
  const inProgress = { id: "u32", direction: "human", state: "in_progress", title: "T", images: [], priority: 1 };
  const view = Views.deriveOverlayView(inProgress);
  assert.match(view.headerHTML, /chip chip-prio chip-p1">p1</);
  assert.doesNotMatch(view.headerHTML, /overlayPrio/);
  assert.doesNotMatch(view.headerHTML, /prio-set/);
});

test("deriveOverlayView: header shows a Reopen affordance for a closed card (either direction), never for a live one", () => {
  const closedHuman = { id: "u20", direction: "human", state: "closed", title: "T", images: [] };
  assert.match(Views.deriveOverlayView(closedHuman).headerHTML, /id="overlayReopen"/);

  const closedAgent = { id: "r9", direction: "agent", kind: "review", status: "answered", state: "closed", title: "T", options: [], details: [], images: [], videos: [], reply: { decision: "approved" } };
  assert.match(Views.deriveOverlayView(closedAgent).headerHTML, /id="overlayReopen"/);

  const inProgress = { id: "u21", direction: "human", state: "in_progress", title: "T", images: [] };
  assert.doesNotMatch(Views.deriveOverlayView(inProgress).headerHTML, /overlayReopen/);
});

test("deriveOverlayView shows a Rétro block (rendered as markdown) when msg.retro exists, for both directions; omitted when absent", () => {
  const agentMsg = { id: "r2", direction: "agent", kind: "review", status: "answered", state: "landing", title: "T", options: [], details: [], images: [], videos: [], reply: { decision: "approved" }, retro: "friction: none" };
  const withRetro = Views.deriveOverlayView(agentMsg);
  assert.match(withRetro.bodyHTML, /Rétro/);
  assert.match(withRetro.bodyHTML, /friction: none/);

  const humanMsg = { id: "u17", direction: "human", state: "closed", title: "T", images: [], retro: "friction: none" };
  const humanWithRetro = Views.deriveOverlayView(humanMsg);
  assert.match(humanWithRetro.bodyHTML, /Rétro/);

  const noRetro = Views.deriveOverlayView({ ...humanMsg, id: "u18", retro: undefined });
  assert.doesNotMatch(noRetro.bodyHTML, /Rétro/);
});

// --- Agent-created cards: "Créée par l'IA" subline -------------------------

test("an agent-created card with no thread shows 'Créée par l'IA' in both compact and sent views", () => {
  const msg = { id: "u40", direction: "human", status: "open", state: "backlog", taskKind: "projet", createdBy: "agent", title: "Do X" };
  assert.equal(Views.deriveCompactView(msg).sub.text, "Créée par l'IA");
  assert.equal(Views.deriveSentView(msg, false).sub, "Créée par l'IA");
});

test("a human-created card (no createdBy) with no thread keeps the old delivery-state subline", () => {
  const acked = { id: "u41", direction: "human", status: "open", state: "backlog", taskKind: "feedback", title: "T", acknowledgedAt: "2026-01-01T00:00:00.000Z" };
  assert.match(Views.deriveCompactView(acked).sub.text, /Lu par l'IA/);
  assert.match(Views.deriveSentView(acked, false).sub, /Lu par l'IA/);

  const delivered = { id: "u42", direction: "human", status: "open", state: "backlog", taskKind: "feedback", title: "T", lastDeliveredAt: "2026-01-01T00:00:00.000Z" };
  assert.match(Views.deriveCompactView(delivered).sub.text, /Livré/);
  assert.match(Views.deriveSentView(delivered, false).sub, /Livré/);
});

test("a card WITH a thread tail shows the tail, never 'Créée par l'IA', regardless of createdBy", () => {
  const thread = [{ from: "human", text: "un commentaire", at: "2026-01-01T00:00:00.000Z" }];
  const agentMade = { id: "u43", direction: "human", status: "open", state: "backlog", taskKind: "projet", createdBy: "agent", title: "T", thread };
  assert.match(Views.deriveCompactView(agentMade).sub.text, /un commentaire/);
  assert.doesNotMatch(Views.deriveCompactView(agentMade).sub.text, /Créée par l'IA/);
  assert.match(Views.deriveSentView(agentMade, true).sub, /un commentaire/);
  assert.doesNotMatch(Views.deriveSentView(agentMade, true).sub, /Créée par l'IA/);
});

// --- Per-message memoization (inputsKey / caching) --------------------------

test("messageFingerprint changes for every field any surface renders — the staleness guard for the derive*View memoization caches", () => {
  const base = {
    id: "f1",
    direction: "agent",
    kind: "review",
    status: "open",
    state: "questions",
    priority: 2,
    taskKind: "feedback",
    title: "T",
    summary: "S",
    context: "ctx",
    project: "P",
    replyTo: null,
    options: ["a"],
    details: ["d"],
    blockedBy: ["x"],
    thread: [{ from: "agent", kind: "question", text: "q1", at: "2026-01-01T00:00:00.000Z" }],
    reply: { at: "2026-01-01T00:00:00.000Z" },
    lastDeliveredAt: "2026-01-01T00:00:00.000Z",
    acknowledgedAt: "2026-01-01T00:00:00.000Z",
    threadSeenAt: "2026-01-01T00:00:00.000Z",
    images: [{ path: "a.png" }],
    videos: [{ path: "b.mp4" }],
    retro: null,
  };
  const baseKey = Views.messageFingerprint(base);

  const mutations = {
    direction: "human",
    kind: "note",
    state: "approbation",
    status: "answered",
    priority: 1,
    taskKind: "change-request",
    agent: { vendor: "codex", model: "GPT-5.4" },
    title: "T2",
    summary: "S2",
    context: "ctx2",
    project: "P2",
    replyTo: "other",
    options: ["b"],
    details: ["d2"],
    blockedBy: ["y"],
    acknowledgedAt: "2026-02-01T00:00:00.000Z",
    threadSeenAt: "2026-02-01T00:00:00.000Z",
    images: [{ path: "c.png" }],
    videos: [{ path: "d.mp4" }],
    retro: "some retro text",
  };
  for (const [field, value] of Object.entries(mutations)) {
    const key = Views.messageFingerprint({ ...base, [field]: value });
    assert.notEqual(key, baseKey, `mutating "${field}" must change inputsKey`);
  }

  // A new thread entry, or the last entry's own at/from/kind, must change it.
  assert.notEqual(
    Views.messageFingerprint({ ...base, thread: [...base.thread, { from: "human", text: "r", at: "2026-01-02T00:00:00.000Z" }] }),
    baseKey,
    "a new thread entry must change inputsKey"
  );
  assert.notEqual(
    Views.messageFingerprint({ ...base, thread: [{ ...base.thread[0], kind: "done" }] }),
    baseKey,
    "the last thread entry's own kind must change inputsKey"
  );

  assert.notEqual(
    Views.messageFingerprint({ ...base, reply: { at: "2026-03-01T00:00:00.000Z" } }),
    baseKey,
    "reply.at must change inputsKey"
  );

  // Anti-churn: server/store.js's peekDeliverable() restamps the RAW
  // lastDeliveredAt on every single agent poll — only Boolean(lastDeliveredAt)
  // may affect inputsKey, never the raw timestamp, or the memoization below
  // would recompute on every poll (the exact perf problem it exists to fix).
  assert.equal(
    Views.messageFingerprint({ ...base, lastDeliveredAt: "2026-05-01T00:00:00.000Z" }),
    baseKey,
    "raw lastDeliveredAt timestamp churn must not affect inputsKey"
  );
  assert.notEqual(
    Views.messageFingerprint({ ...base, lastDeliveredAt: null }),
    baseKey,
    "lastDeliveredAt presence flipping must change inputsKey"
  );

  // `extra`: caller-supplied bits no derive function can read off msg itself.
  assert.notEqual(Views.messageFingerprint(base, { blockedNow: ["z"] }), baseKey, "blockedNow must change inputsKey");
  assert.notEqual(Views.messageFingerprint(base, { pendingCounts: [1, 0, 0] }), baseKey, "pendingCounts must change inputsKey");
  assert.notEqual(Views.messageFingerprint(base, { delivered: true }), baseKey, "delivered must change inputsKey");
});

test("deriveCompactView memoizes: an unchanged msg reuses the cached view without re-parsing markdown; a changed rendered field forces a fresh parse", () => {
  let parseCalls = 0;
  const realParse = global.marked.parse;
  global.marked.parse = (...args) => {
    parseCalls++;
    return realParse(...args);
  };
  try {
    const msg = {
      id: "memo1",
      direction: "agent",
      kind: "review",
      status: "open",
      state: "in_progress",
      title: "T",
      options: [],
      context: "hello world",
    };
    const v1 = Views.deriveCompactView(msg);
    const callsAfterFirst = parseCalls;
    assert.ok(callsAfterFirst > 0, "the first call must render the context markdown");

    const v2 = Views.deriveCompactView({ ...msg });
    assert.equal(parseCalls, callsAfterFirst, "an unchanged msg (same id, same fingerprint) must not re-parse markdown");
    assert.equal(v2, v1, "an unchanged msg returns the exact cached view object");

    Views.deriveCompactView({ ...msg, context: "different" });
    assert.ok(parseCalls > callsAfterFirst, "a changed rendered field must force a fresh parse");
  } finally {
    global.marked.parse = realParse;
  }
});

test("deriveCompactView: a blocked card that awaits the human's input keeps the badge but is not dimmed", () => {
  const question = { id: "u1", direction: "human", status: "open", state: "questions", title: "Q", thread: [{ from: "agent", kind: "question", text: "which one?" }] };
  const view = Views.deriveCompactView(question, { blockedBy: ["u9"] });
  assert.equal(view.blocked, true);
  assert.equal(view.dimmed, false);
  assert.match(view.blockedBadge, /u9/);

  // Approval round-trip as the store produces it: the agent's "done" lands the card in
  // approbation (awaits the human), the human's "Approuvé" leaves state untouched but
  // hands the card back to the agent, so dimming resumes.
  const awaitingApproval = { ...question, id: "u2", state: "approbation", thread: [{ from: "agent", kind: "done", text: "shipped" }] };
  assert.equal(Views.deriveCompactView(awaitingApproval, { blockedBy: ["u9"] }).dimmed, false);
  const approved = { ...awaitingApproval, id: "u3", thread: [...awaitingApproval.thread, { from: "human", text: "Approuvé" }] };
  assert.equal(Views.deriveCompactView(approved, { blockedBy: ["u9"] }).dimmed, true);

  const working = { ...question, id: "u4", state: "in_progress" };
  assert.equal(Views.deriveCompactView(working, { blockedBy: ["u9"] }).dimmed, true);
  assert.equal(Views.deriveCompactView(working, { blockedBy: [] }).dimmed, false);
});

test("deriveCompactView: agent mark with vendor icon and model/effort tooltip; none without a declared agent", () => {
  const base = { id: "u1", direction: "human", status: "open", state: "in_progress", title: "T" };
  assert.equal(Views.deriveCompactView(base).agentMark, "");
  const view = Views.deriveCompactView({ ...base, agent: { vendor: "claude", model: "Fable 5.1", effort: "max" } });
  assert.match(view.agentMark, /class="agent-mark"/);
  assert.match(view.agentMark, /src="agents\/claude\.svg"/);
  assert.match(view.agentMark, /title="Claude · Fable 5\.1&#10;Effort : max"/);
  const noEffort = Views.deriveCompactView({ ...base, id: "u2", agent: { vendor: "codex", model: "GPT-5.4" } });
  assert.match(noEffort.agentMark, /src="agents\/codex\.png"/);
  assert.match(noEffort.agentMark, /title="Codex · GPT-5\.4"/);
  // Changing the agent must not be hidden by the memo cache.
  const changed = Views.deriveCompactView({ ...base, agent: { vendor: "antigravity", model: "Gemini 3.1 Pro", effort: "medium" } });
  assert.match(changed.agentMark, /antigravity\.png/);
  // Unknown vendors draw nothing, prototype names included (hand-edited data).
  assert.equal(Views.deriveCompactView({ ...base, id: "u3", agent: { vendor: "constructor", model: "x" } }).agentMark, "");
});

test("priorityChipHTML: the pill carries the chip-prio class the 22px gutter is styled on", () => {
  const base = { id: "u1", direction: "human", status: "open", state: "backlog", title: "T" };
  assert.match(Views.deriveCompactView(base).priorityChip, /class="chip chip-prio chip-p2"/);
});

test("deriveCompactView: compact cards no longer carry the colored dot", () => {
  const base = { id: "u1", direction: "human", status: "open", state: "in_progress", title: "T", taskKind: "feedback" };
  assert.equal(Views.deriveCompactView(base).dot, undefined);
});

test("imagesHTML: label and caption ride on the thumb as alt and title, escaped; absent ones leave no attribute", () => {
  const html = Views.imagesHTML([{ path: "C:/a.png", label: 'Avant "v1"', caption: "Notre <village>" }, { path: "C:/b.png" }], "r1");
  assert.match(html, /alt="Avant &quot;v1&quot;"/);
  assert.match(html, /title="Notre &lt;village&gt;"/);
  assert.equal((html.match(/alt=/g) || []).length, 1);
  assert.equal((html.match(/title=/g) || []).length, 1);
});
