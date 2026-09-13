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

test("deriveCompactView: priority chip shown only for p1/p3, nothing for p2/absent", () => {
  const base = { id: "u1", direction: "human", status: "open", state: "backlog", taskKind: "feedback", title: "T" };
  assert.equal(Views.deriveCompactView(base).priorityChip, "");
  assert.equal(Views.deriveCompactView({ ...base, priority: 2 }).priorityChip, "");
  assert.match(Views.deriveCompactView({ ...base, priority: 1 }).priorityChip, /chip-p1/);
  assert.match(Views.deriveCompactView({ ...base, priority: 3 }).priorityChip, /chip-p3/);
});

test("deriveCompactView: a noReview card gets the discreet 'sans revue' chip, absent otherwise", () => {
  const base = { id: "u1", direction: "human", status: "open", state: "backlog", taskKind: "projet", title: "T" };
  assert.equal(Views.deriveCompactView(base).noReviewChip, "");
  assert.match(Views.deriveCompactView({ ...base, noReview: true }).noReviewChip, /sans revue/);
  assert.match(Views.deriveCompactView({ ...base, noReview: true }).noReviewChip, /chip-no-review/);
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

test("deriveCompactView: a closed+awaitingAgent card still offers Testé ✓ Archiver; other awaiting states keep no action at all", () => {
  const closedAwaiting = {
    id: "u11",
    direction: "human",
    status: "open",
    state: "closed",
    title: "T",
    thread: [{ from: "human", text: "ok", at: "2026-01-01T00:00:00.000Z" }],
  };
  const view = Views.deriveCompactView(closedAwaiting);
  assert.equal(view.awaitingAgent, true);
  assert.match(view.actionsHTML, /archive-link-btn/);
  assert.match(view.actionsHTML, /Testé ✓ Archiver/);

  const inProgressAwaiting = { ...closedAwaiting, id: "u12", state: "in_progress" };
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
  };
  const baseKey = Views.messageFingerprint(base);

  const mutations = {
    direction: "human",
    kind: "note",
    state: "approbation",
    status: "answered",
    priority: 1,
    taskKind: "change-request",
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
