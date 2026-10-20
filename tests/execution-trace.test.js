"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const trace = require("../server/execution-trace");
const { render } = require("../public/execution-view");
const { spawnSync } = require("child_process");
const action = { operation: "publish", command: "python tools/git/push_main.py --attempts 1", cwd: "/isolated/repo",
  destination: "git@example.invalid:owner/private.git", targetRef: "refs/heads/main", version: "a".repeat(40), threadId: "owning-task", effects: ["publish tooling"] };
const actionId = trace.actionId(action);
const event = (type, extra = {}) => ({ id: type, type, actionId, at: "2026-10-10T16:35:00Z", source: "test", ...extra });
const observed = event("observed", { action });
const denied = event("denied", { after: "2026-10-10T16:34:37Z", before: "2026-10-10T16:35:45Z", reason: "verbatim rationale",
  reasonSource: "exec rejection", provenance: "unknown", nativeReviewId: null, attemptId: null });
const consent = event("consent", { at: "2026-10-10T16:57:42.686Z", decision: "approved", boardReceipt: "r290" });
const fold = (...events) => events.reduce((state, entry) => trace.append(state, entry).trace, undefined);

test("later r290 vote remains separate from the earlier denial; no post-vote rejection or attempt inferred", () => {
  const current = trace.project(fold(observed, denied, consent));
  assert.equal(current.chronology, "vote_after_denial");
  assert.equal(current.attemptsAfterDenial, 0);
  assert.equal(current.denied.reason, "verbatim rationale");
  assert.equal(current.denied.provenance, "unknown");
  assert.equal(current.publication, null);
  assert.equal(current.activation, null);
  assert.equal(current.recovery.executable, false);
  assert.ok(current.recovery.reasons.includes("native_denial_id_missing"));
});
test("vote before denial does not prove consideration; delivery order does not change chronology", () => {
  const earlier = { ...consent, at: "2026-10-10T16:00:00Z" };
  assert.equal(trace.project(fold(observed, denied, earlier)).chronology, "vote_before_denial");
  assert.equal(trace.project(fold(observed, earlier, denied)).chronology, "vote_before_denial");
});
test("bounded denial timestamp never invents order within its interval", () => {
  assert.equal(trace.project(fold(observed, denied, { ...consent, at: denied.at })).chronology, "order_unproven");
});
test("replayed events are idempotent; colliding ids reject changed evidence", () => {
  const state = fold(observed, denied, consent);
  assert.equal(trace.append(state, denied).changed, false);
  assert.deepEqual(trace.append(state, denied).trace, state);
  assert.throws(() => trace.append(state, { ...denied, reason: "rewritten reason" }), /reused/);
});
test("each material action field invalidates consent and old action cannot be resurrected", () => {
  for (const name of ["command", "cwd", "destination", "targetRef", "version", "threadId", "operation", "effects"]) {
    const changed = { ...action, [name]: name === "effects" ? ["activate scheduler"] : action[name] + "changed" };
    const newObservation = { ...observed, id: `new-${name}`, actionId: trace.actionId(changed), action: changed };
    const state = fold(observed, denied, consent, newObservation);
    assert.equal(trace.project(state).consent, null, name);
    assert.equal(trace.project(state).publication, null, name);
    assert.throws(() => trace.append(state, { ...consent, id: "stale" }), /superseded/);
    assert.throws(() => trace.append(state, { ...observed, id: "resurrect" }), /already observed/);
  }
});
test("a native id alone never enables retry; arbitrary native grants are rejected", () => {
  const state = fold(observed, { ...denied, nativeReviewId: "native-exact-id" }, consent);
  assert.equal(trace.project(state).recovery.executable, false);
  assert.throws(() => trace.append(state, event("attempt", { attemptId: "retry" })), /adapter unavailable/);
  assert.throws(() => trace.append(state, { ...consent, nativeAuthorization: "granted" }), /unknown execution field/);
  assert.throws(() => trace.append(state, event("native_approved")), /unknown execution/);
});
test("publication requires a matching preceding attempt; activation requires its distinct publication receipt", () => {
  const attempt = event("attempt", { attemptId: "first" });
  const publication = event("publication", { at: "2026-10-10T17:00:00Z", attemptId: "first", receipt: "remote ref readback" });
  assert.throws(() => fold(observed, publication), /preceding attempt/);
  assert.throws(() => fold(observed, event("activation", { publicationEventId: "publication", receipt: "runtime readback" })), /publication/);
  const published = fold(observed, attempt, publication);
  assert.equal(trace.project(published).activation, null);
  const activated = trace.append(published, event("activation", { at: "2026-10-10T17:01:00Z", publicationEventId: "publication", receipt: "runtime readback" })).trace;
  assert.ok(trace.project(activated).activation);
  assert.throws(() => trace.append(published, { ...publication, id: "duplicate-publication" }), /already recorded/);
  assert.throws(() => fold(observed, attempt, { ...denied, attemptId: "first" }, publication), /denied attempt/);
});
test("missing timestamps, unknown fields and changed digests fail closed", () => {
  assert.throws(() => fold({ ...observed, at: "2026-10-10" }), /timezone/);
  assert.throws(() => fold({ ...observed, action: { ...action, version: "new" } }), /digest/);
  assert.throws(() => fold(observed, { ...denied, after: denied.before, before: denied.after }), /interval/);
});
test("external publication and activation are facts without inventing a retry or actor", () => {
  const publication = event("publication", { at: "2026-10-10T18:02:53Z", attemptId: null, origin: "external_observation", actor: null,
    receipt: "remote main equals exact revision; actor unavailable" });
  const activation = event("activation", { at: "2026-10-10T18:04:20Z", publicationEventId: "publication", origin: "external_observation", actor: null,
    receipt: "active checkout equals exact revision; actor unavailable" });
  const state = fold(observed, denied, consent, publication, activation);
  const current = trace.project(state);
  assert.equal(current.publication.actor, null);
  assert.equal(current.activation.actor, null);
  assert.equal(current.denied.provenance, "unknown");
  assert.equal(current.attemptsAfterDenial, 0);
  assert.equal(current.recovery.executable, false);
  assert.ok(current.recovery.reasons.includes("already_published"));
  assert.throws(() => fold(observed, { ...publication, receipt: "" }), /receipt/);
  assert.throws(() => fold(observed, { ...publication, attemptId: "invented-retry" }), /cannot claim/);
});
test("rendered trace escapes facts and presents consent without a retry button", () => {
  const state = fold(observed, { ...denied, reason: "<script>attack</script>" }, consent);
  const html = render({ id: "r290", executionTrace: state, execution: trace.project(state) });
  assert.ok(html.includes("postérieur au refus"));
  assert.ok(html.includes("tout input via le board"));
  assert.ok(!html.includes("<script>"));
  assert.ok(!/class="[^" ]*(?:retry|native-approve)/.test(html));
});

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "execution-trace-store-"));
process.env.REVIEW_BOARD_DATA_DIR = directory;
process.env.REVIEW_BOARD_NO_SUMMARY = "1";
const store = require("../server/store");
test("store persists evidence, updates replay journal once, and rejects cross-card duplicates and stale human votes", () => {
  const card = store.createTask({ tags: ["unity-free"], title: "Scoped publication" });
  store.recordExecutionEvent(card.id, observed);
  store.recordExecutionEvent(card.id, denied);
  const before = store.replayEvents(0).sequence;
  store.recordExecutionEvent(card.id, denied);
  assert.equal(store.replayEvents(0).sequence, before);
  store.consentExecution(card.id, { actionId, decision: "approved" });
  const voted = store.replayEvents(0).sequence;
  store.consentExecution(card.id, { actionId, decision: "approved" });
  assert.equal(store.replayEvents(0).sequence, voted);
  assert.equal(store.replayEvents(before).events.at(-1).author, "human");
  const saved = JSON.parse(fs.readFileSync(path.join(directory, "messages.json")));
  assert.equal(saved.messages.find(entry => entry.id === card.id).execution.nativeAuthorization, "unavailable");
  const other = store.createTask({ tags: ["unity-free"], title: "Other" });
  assert.throws(() => store.recordExecutionEvent(other.id, { ...observed, id: "copied" }), /belongs/);
  const changed = { ...action, version: "b".repeat(40) };
  store.recordExecutionEvent(card.id, { ...observed, id: "changed", action: changed, actionId: trace.actionId(changed) });
  assert.throws(() => store.consentExecution(card.id, { actionId, decision: "approved" }), /stale/);
  assert.equal(card.state, "backlog");
});
test("failed durable write rolls back the trace and journal", () => {
  const card = store.createTask({ tags: ["unity-free"], title: "Persistence failure" });
  const changed = { ...action, threadId: "persistence-test" };
  const before = store.replayEvents(0).sequence;
  const rename = fs.renameSync;
  fs.renameSync = () => { throw new Error("write failure"); };
  try { assert.throws(() => store.recordExecutionEvent(card.id, { ...observed, id: "failed", action: changed, actionId: trace.actionId(changed) }), /write failure/); }
  finally { fs.renameSync = rename; }
  assert.equal(card.executionTrace, undefined);
  assert.equal(store.replayEvents(0).sequence, before);
});
test("a fresh process replays the same persisted evidence and journal cursor", () => {
  const sequence = store.replayEvents(0).sequence;
  const result = spawnSync(process.execPath, ["-e", "const s=require('./server/store');process.stdout.write(JSON.stringify({cards:s.list(),journal:s.replayEvents(0)}));"],
    { cwd: path.resolve(__dirname, ".."), env: process.env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const restored = JSON.parse(result.stdout);
  assert.equal(restored.journal.sequence, sequence);
  assert.deepEqual(restored.cards, JSON.parse(fs.readFileSync(path.join(directory, "messages.json"))).messages);
});
