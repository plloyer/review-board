"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Lifecycle = require("../shared/lifecycle");

test("TASK_STATES and COLUMN_STATES are the same canonical list", () => {
  assert.deepEqual(Lifecycle.TASK_STATES, ["backlog", "in_progress", "questions", "approbation", "landing", "closed"]);
  assert.equal(Lifecycle.COLUMN_STATES, Lifecycle.TASK_STATES);
});

test("KIND_TO_STATE maps agent-message kinds to their initial column", () => {
  assert.equal(Lifecycle.KIND_TO_STATE.question, "questions");
  assert.equal(Lifecycle.KIND_TO_STATE.review, "approbation");
  assert.equal(Lifecycle.KIND_TO_STATE.note, "in_progress");
});

test("dotColor: null for closed, taskKind-dependent for backlog, per-state accent otherwise", () => {
  assert.equal(Lifecycle.dotColor({ state: "closed" }), null);
  assert.equal(Lifecycle.dotColor({ state: "backlog", taskKind: "feedback" }), "#6cbf6c");
  assert.equal(Lifecycle.dotColor({ state: "backlog", taskKind: "projet" }), "#8a8a90");
  assert.equal(Lifecycle.dotColor({ state: "in_progress" }), "#4a90d9");
  assert.equal(Lifecycle.dotColor({ state: "questions" }), "#d9a441");
  assert.equal(Lifecycle.dotColor({ state: "approbation" }), "#6cbf6c");
  assert.equal(Lifecycle.dotColor({ state: "landing" }), "#b08fd9");
});

test("lastThreadEntry returns the last thread item, or undefined for no/empty thread", () => {
  assert.equal(Lifecycle.lastThreadEntry({}), undefined);
  assert.equal(Lifecycle.lastThreadEntry({ thread: [] }), undefined);
  const t2 = { from: "human", text: "b" };
  assert.equal(Lifecycle.lastThreadEntry({ thread: [{ from: "agent", text: "a" }, t2] }), t2);
});

test("isActionableThreadEntry: only an agent question/done entry is actionable", () => {
  assert.equal(Lifecycle.isActionableThreadEntry(undefined), false);
  assert.equal(Lifecycle.isActionableThreadEntry({ from: "human", kind: "question" }), false);
  assert.equal(Lifecycle.isActionableThreadEntry({ from: "agent", kind: "update" }), false);
  assert.equal(Lifecycle.isActionableThreadEntry({ from: "agent", kind: "question" }), true);
  assert.equal(Lifecycle.isActionableThreadEntry({ from: "agent", kind: "done" }), true);
});

test("unseenActionable: true only when the last actionable entry postdates threadSeenAt", () => {
  const seen = { threadSeenAt: "2026-01-01T00:00:01.000Z", thread: [{ from: "agent", kind: "done", at: "2026-01-01T00:00:00.000Z" }] };
  assert.equal(Lifecycle.unseenActionable(seen), false);
  const unseen = { threadSeenAt: "2026-01-01T00:00:00.000Z", thread: [{ from: "agent", kind: "question", at: "2026-01-01T00:00:01.000Z" }] };
  assert.equal(Lifecycle.unseenActionable(unseen), true);
  assert.equal(Lifecycle.unseenActionable({ thread: [{ from: "human", text: "hi", at: "x" }] }), false);
  assert.equal(Lifecycle.unseenActionable({}), false);
});

test("agentAwaitingDecision: true for questions/approbation, false otherwise", () => {
  assert.equal(Lifecycle.agentAwaitingDecision({ state: "questions" }), true);
  assert.equal(Lifecycle.agentAwaitingDecision({ state: "approbation" }), true);
  assert.equal(Lifecycle.agentAwaitingDecision({ state: "in_progress" }), false);
  assert.equal(Lifecycle.agentAwaitingDecision({ state: "landing" }), false);
});

test("stateAfterReply: approved -> landing, otherwise in_progress, never backward out of closed/landing", () => {
  assert.equal(Lifecycle.stateAfterReply("in_progress", "approved"), "landing");
  assert.equal(Lifecycle.stateAfterReply("in_progress", "iteration"), "in_progress");
  assert.equal(Lifecycle.stateAfterReply("questions", undefined), "in_progress");
  assert.equal(Lifecycle.stateAfterReply("closed", "approved"), "closed");
  assert.equal(Lifecycle.stateAfterReply("landing", "iteration"), "landing");
});

test("stateAfterAgentReply: question -> questions, done -> approbation, update -> null (no move)", () => {
  assert.equal(Lifecycle.stateAfterAgentReply("question"), "questions");
  assert.equal(Lifecycle.stateAfterAgentReply("done"), "approbation");
  assert.equal(Lifecycle.stateAfterAgentReply("update"), null);
});

// --- blockedBy -------------------------------------------------------------

test("isBlocked: false when blockedBy is absent/empty", () => {
  assert.equal(Lifecycle.isBlocked({ id: "u1" }, []), false);
  assert.equal(Lifecycle.isBlocked({ id: "u1", blockedBy: [] }, []), false);
});

test("isBlocked: true while a blocker exists and isn't landing/closed", () => {
  const all = [{ id: "u1", blockedBy: ["u2"] }, { id: "u2", state: "in_progress" }];
  assert.equal(Lifecycle.isBlocked(all[0], all), true);
});

test("isBlocked: false once every blocker is landing or closed", () => {
  const all = [{ id: "u1", blockedBy: ["u2", "u3"] }, { id: "u2", state: "landing" }, { id: "u3", state: "closed" }];
  assert.equal(Lifecycle.isBlocked(all[0], all), false);
});

test("isBlocked: still true when only SOME blockers are resolved", () => {
  const all = [{ id: "u1", blockedBy: ["u2", "u3"] }, { id: "u2", state: "landing" }, { id: "u3", state: "in_progress" }];
  assert.equal(Lifecycle.isBlocked(all[0], all), true);
});

test("isBlocked: a blocker id not found in the card list never blocks", () => {
  const all = [{ id: "u1", blockedBy: ["ghost"] }];
  assert.equal(Lifecycle.isBlocked(all[0], all), false);
});

// --- awaitingAgent ("Répondu" subsection) -----------------------------------

test("awaitingAgent (agent-direction): true once he replied, false once the agent acknowledges", () => {
  assert.equal(Lifecycle.awaitingAgent({ direction: "agent", status: "answered" }), true);
  assert.equal(
    Lifecycle.awaitingAgent({ direction: "agent", status: "answered", acknowledgedAt: "2026-01-01T00:00:00.000Z" }),
    false
  );
  assert.equal(Lifecycle.awaitingAgent({ direction: "agent", status: "open" }), false);
});

test("awaitingAgent (human-direction): true only while his own thread entry is the tail", () => {
  assert.equal(Lifecycle.awaitingAgent({ direction: "human", thread: [] }), false);
  assert.equal(Lifecycle.awaitingAgent({ direction: "human" }), false);
  assert.equal(
    Lifecycle.awaitingAgent({ direction: "human", thread: [{ from: "human", text: "Approuvé" }] }),
    true
  );
  assert.equal(
    Lifecycle.awaitingAgent({
      direction: "human",
      thread: [
        { from: "human", text: "Approuvé" },
        { from: "agent", text: "merci", kind: "update" },
      ],
    }),
    false
  );
});

test("awaitingAgent: a backlog card is never awaiting, whatever its thread or status", () => {
  // Backlog is pull-based — no agent has picked the card up yet, so the human
  // enriching it is not "waiting on the AI"; it stays an ordinary backlog card.
  assert.equal(
    Lifecycle.awaitingAgent({ direction: "human", state: "backlog", thread: [{ from: "human", text: "plus d'infos" }] }),
    false
  );
  assert.equal(Lifecycle.awaitingAgent({ direction: "agent", state: "backlog", status: "answered" }), false);
  // The same shapes outside backlog keep the existing behavior.
  assert.equal(
    Lifecycle.awaitingAgent({ direction: "human", state: "in_progress", thread: [{ from: "human", text: "plus d'infos" }] }),
    true
  );
});

test("activeBlockers: returns only the still-active blocker ids", () => {
  const all = [
    { id: "u1", blockedBy: ["u2", "u3", "ghost"] },
    { id: "u2", state: "landing" },
    { id: "u3", state: "in_progress" },
  ];
  assert.deepEqual(Lifecycle.activeBlockers(all[0], all), ["u3"]);
});
