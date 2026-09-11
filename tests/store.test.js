"use strict";
// Sets REVIEW_BOARD_DATA_DIR to a temp dir BEFORE requiring store, so the real
// data/messages.json is never touched by this suite.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-board-test-"));
  process.env.REVIEW_BOARD_DATA_DIR = dir;
  delete require.cache[require.resolve("../server/store")];
  return { store: require("../server/store"), dir };
}

test("addAgentMessage assigns r-ids, addHumanMessage assigns u-ids", () => {
  const { store } = freshStore();
  const a1 = store.addAgentMessage({ title: "Review this" });
  const a2 = store.addAgentMessage({ title: "Review that" });
  const h1 = store.addHumanMessage("hello", []);
  assert.equal(a1.id, "r1");
  assert.equal(a2.id, "r2");
  assert.equal(h1.id, "u1");
});

test("addAgentMessage ingests a locally-reachable image/video into the data dir's uploads/", () => {
  const { store, dir } = freshStore();
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-board-src-"));
  const srcImg = path.join(srcDir, "shot.png");
  fs.writeFileSync(srcImg, "fake-png-bytes");
  const srcVid = path.join(srcDir, "clip.mp4");
  fs.writeFileSync(srcVid, "fake-mp4-bytes");

  const msg = store.addAgentMessage({ title: "Review this", images: [{ path: srcImg }], videos: [{ path: srcVid }] });

  const uploadsDir = path.join(dir, "uploads");
  assert.equal(path.dirname(msg.images[0].path), uploadsDir);
  assert.notEqual(msg.images[0].path, srcImg);
  assert.equal(fs.readFileSync(msg.images[0].path, "utf8"), "fake-png-bytes");
  assert.equal(path.dirname(msg.videos[0].path), uploadsDir);
  assert.equal(fs.readFileSync(msg.videos[0].path, "utf8"), "fake-mp4-bytes");
});

test("addAgentMessage keeps a non-existent (remote-machine) attachment path verbatim", () => {
  const { store } = freshStore();
  const missing = "Z:\\nonexistent\\scratch\\shot.png";
  const msg = store.addAgentMessage({ title: "Review this", images: [{ path: missing }] });
  assert.equal(msg.images[0].path, missing);
});

test("reply marks the message answered", () => {
  const { store } = freshStore();
  const a1 = store.addAgentMessage({ title: "Review this" });
  const replied = store.reply(a1.id, { text: "looks good" });
  assert.equal(replied.status, "answered");
  assert.equal(replied.reply.text, "looks good");
});

test("reply throws when called on a human message (only an agent message can be replied to)", () => {
  const { store } = freshStore();
  const h1 = store.addHumanMessage("hi", []);
  assert.throws(() => store.reply(h1.id, { text: "x" }));
});

test("agentReply throws when called on an agent message (only a human message can be agent-replied to)", () => {
  const { store } = freshStore();
  const a1 = store.addAgentMessage({ title: "Review this" });
  assert.throws(() => store.agentReply(a1.id, "x"));
});

test("save() is atomic — no .tmp file lingers after a write", () => {
  const { store, dir } = freshStore();
  store.addAgentMessage({ title: "Review this" });
  assert.ok(!fs.existsSync(path.join(dir, "messages.json.tmp")));
  assert.ok(fs.existsSync(path.join(dir, "messages.json")));
});

test("load() backs up a corrupt data file instead of silently discarding it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-board-test-"));
  fs.writeFileSync(path.join(dir, "messages.json"), "{not valid json");
  process.env.REVIEW_BOARD_DATA_DIR = dir;
  delete require.cache[require.resolve("../server/store")];
  const originalConsoleError = console.error;
  console.error = () => {};
  let store;
  try {
    store = require("../server/store");
  } finally {
    console.error = originalConsoleError;
  }
  assert.deepEqual(store.list(), []);
  assert.deepEqual(store.history(), []);
  const backups = fs.readdirSync(dir).filter((f) => f.startsWith("messages.json.corrupt-"));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, backups[0]), "utf8"), "{not valid json");
});

test("uniqueUploadName returns the plain path when free, and -1/-2 suffixes on collision", () => {
  const { store, dir } = freshStore();
  const uploads = path.join(dir, "uploads");
  fs.mkdirSync(uploads, { recursive: true });
  const first = store.uniqueUploadName(uploads, "shot.png");
  assert.equal(first, path.join(uploads, "shot.png"));
  fs.writeFileSync(first, "a");
  const second = store.uniqueUploadName(uploads, "shot.png");
  assert.equal(second, path.join(uploads, "shot-1.png"));
  fs.writeFileSync(second, "b");
  const third = store.uniqueUploadName(uploads, "shot.png");
  assert.equal(third, path.join(uploads, "shot-2.png"));
});

test("peekDeliverable returns answered-agent + open-human items and is at-least-once (non-destructive)", () => {
  const { store } = freshStore();
  const a1 = store.addAgentMessage({ title: "Review this" });
  store.reply(a1.id, { text: "ok" });
  const h1 = store.addHumanMessage("a question", []);
  const a2 = store.addAgentMessage({ title: "Still open, not answered" });

  const first = store.peekDeliverable();
  const ids = first.map((m) => m.id).sort();
  assert.deepEqual(ids, [a1.id, h1.id].sort());
  assert.ok(!ids.includes(a2.id), "an open (unanswered) agent message must not be deliverable");
  for (const m of first) assert.ok(m.lastDeliveredAt, "peek stamps lastDeliveredAt");

  // THE regression: calling peekDeliverable again must return the same items —
  // it must never remove them from the live queue.
  const second = store.peekDeliverable();
  assert.deepEqual(second.map((m) => m.id).sort(), ids);
});

test("acknowledge keeps an active-state agent card (and a human message) in the live queue, stamped so redelivery stops", () => {
  const { store } = freshStore();
  const a1 = store.addAgentMessage({ title: "Review this" });
  store.reply(a1.id, { text: "ok" }); // -> state in_progress: active, not closed
  const h1 = store.addHumanMessage("a question", []);

  const count = store.acknowledge([a1.id, h1.id]);
  assert.equal(count, 2);
  assert.deepEqual(store.peekDeliverable(), [], "acknowledged items must not be re-delivered");
  assert.equal(store.history().length, 0, "an active-state agent card must stay on the board, not retire to history");

  const stillAgent = store.list().find((m) => m.id === a1.id);
  assert.ok(stillAgent, "agent card stays in its column after ack");
  assert.equal(stillAgent.state, "in_progress");
  assert.ok(stillAgent.acknowledgedAt);
  assert.ok(stillAgent.readAt);

  const stillHuman = store.list().find((m) => m.id === h1.id);
  assert.ok(stillHuman, "human message stays in the live queue after ack");
  assert.equal(stillHuman.status, "open");
  assert.ok(stillHuman.acknowledgedAt);
  assert.ok(stillHuman.readAt);
});

test("acknowledge still retires a replyTo delivery-vehicle message regardless of state", () => {
  const { store } = freshStore();
  const vehicle = store.addHumanMessage("approved", [], "r1");
  const count = store.acknowledge([vehicle.id]);
  assert.equal(count, 1);
  assert.equal(store.list().find((m) => m.id === vehicle.id), undefined);
  assert.ok(store.history().find((m) => m.id === vehicle.id));
});

test("acknowledge of a non-deliverable id is a no-op", () => {
  const { store } = freshStore();
  const a1 = store.addAgentMessage({ title: "Still open" }); // not answered -> not deliverable
  const count = store.acknowledge([a1.id]);
  assert.equal(count, 0);
  assert.equal(store.list().length, 1);
  assert.equal(store.history().length, 0);
});

test("withdraw removes a message entirely", () => {
  const { store } = freshStore();
  const a1 = store.addAgentMessage({ title: "Review this" });
  const removed = store.withdraw([a1.id]);
  assert.equal(removed, 1);
  assert.equal(store.list().length, 0);
});

test("history() returns acknowledged agent replies once their card's state is closed", () => {
  const { store } = freshStore();
  const a1 = store.addAgentMessage({ title: "Review this" });
  store.reply(a1.id, { text: "ok" });
  // moveTask(..., "closed") itself stamps acknowledgedAt (see its own test below), so
  // to exercise acknowledge()'s closed-state retirement rule in isolation, set state
  // directly here — simulating a card whose closed state predates that stamp (e.g.
  // pre-existing data written by an older version).
  store.list().find((m) => m.id === a1.id).state = "closed";
  store.acknowledge([a1.id]);
  assert.equal(store.history().length, 1);
  assert.equal(store.history()[0].id, a1.id);
});

test("agentReply appends a thread entry to a human message without moving it", () => {
  const { store } = freshStore();
  const h1 = store.addHumanMessage("bug report", []);
  const updated = store.agentReply(h1.id, "fixed in abc123");
  assert.equal(updated.thread.length, 1);
  assert.equal(updated.thread[0].from, "agent");
  assert.equal(updated.thread[0].text, "fixed in abc123");
  assert.ok(updated.thread[0].at);
  assert.equal(store.list().find((m) => m.id === h1.id).thread.length, 1);
});

test("agentReply defaults kind to 'update'", () => {
  const { store } = freshStore();
  const h1 = store.addHumanMessage("bug report", []);
  const updated = store.agentReply(h1.id, "still working on it");
  assert.equal(updated.thread[0].kind, "update");
});

test("agentReply stores an explicit kind", () => {
  const { store } = freshStore();
  const h1 = store.addHumanMessage("bug report", []);
  const updated = store.agentReply(h1.id, "should I use approach A or B?", "question");
  assert.equal(updated.thread[0].kind, "question");
});

test("agentReply throws on an unknown id", () => {
  const { store } = freshStore();
  assert.throws(() => store.agentReply("u999", "x"));
});

test("markThreadSeen stamps threadSeenAt", () => {
  const { store } = freshStore();
  const h1 = store.addHumanMessage("bug report", []);
  const updated = store.markThreadSeen(h1.id);
  assert.ok(updated.threadSeenAt);
  assert.equal(store.list().find((m) => m.id === h1.id).threadSeenAt, updated.threadSeenAt);
});

test("markThreadSeen throws on an unknown id", () => {
  const { store } = freshStore();
  assert.throws(() => store.markThreadSeen("u999"));
});

test("archive moves a human message to history regardless of read state, stamping archivedAt not deliveredAt when it was never delivered", () => {
  const { store } = freshStore();
  const h1 = store.addHumanMessage("bug report", []);
  store.archive(h1.id);
  assert.equal(store.list().find((m) => m.id === h1.id), undefined);
  const hist = store.history();
  assert.equal(hist.length, 1);
  assert.equal(hist[0].id, h1.id);
  assert.ok(hist[0].archivedAt);
  assert.ok(!hist[0].deliveredAt, "never peeked/delivered, so deliveredAt must not be set");
});

test("archive stamps deliveredAt (in addition to archivedAt) when the message had been delivered", () => {
  const { store } = freshStore();
  const h1 = store.addHumanMessage("bug report", []);
  store.peekDeliverable(); // delivers it, stamping lastDeliveredAt
  store.archive(h1.id);
  const hist = store.history();
  assert.ok(hist[0].archivedAt);
  assert.ok(hist[0].deliveredAt);
});

test("archive works on any live card (agent included); only an unknown id throws", () => {
  const { store } = freshStore();
  const a1 = store.addAgentMessage({ title: "Review this" });
  const archived = store.archive(a1.id);
  assert.equal(archived.id, a1.id);
  assert.equal(store.list().find((m) => m.id === a1.id), undefined);
  assert.ok(store.history().find((m) => m.id === a1.id).archivedAt);

  assert.throws(() => store.archive("u999"));
});

test("close_issue flow: a final agentReply note followed by archive lands the note in history with archivedAt", () => {
  const { store } = freshStore();
  const h1 = store.addHumanMessage("bug report", []);
  store.agentReply(h1.id, "fixed and delivered in abc123");
  store.archive(h1.id);
  assert.equal(store.list().find((m) => m.id === h1.id), undefined);
  const hist = store.history();
  assert.equal(hist.length, 1);
  assert.ok(hist[0].archivedAt);
  assert.equal(hist[0].thread.at(-1).text, "fixed and delivered in abc123");
});

test("state survives a save/reload round-trip", () => {
  const { store, dir } = freshStore();
  store.addAgentMessage({ title: "Review this" });
  store.addHumanMessage("hi", []);

  // Force a fresh require against the same data dir, as a new process would see it.
  delete require.cache[require.resolve("../server/store")];
  process.env.REVIEW_BOARD_DATA_DIR = dir;
  const reloaded = require("../server/store");
  assert.equal(reloaded.list().length, 2);
  const ids = reloaded.list().map((m) => m.id).sort();
  assert.deepEqual(ids, ["r1", "u1"]);
});

test("loading a state file without a history key does not crash (back-compat)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-board-test-"));
  fs.writeFileSync(
    path.join(dir, "messages.json"),
    JSON.stringify({ nextAgentId: 2, nextHumanId: 1, messages: [] })
  );
  process.env.REVIEW_BOARD_DATA_DIR = dir;
  delete require.cache[require.resolve("../server/store")];
  const store = require("../server/store");
  assert.deepEqual(store.history(), []);
});

// --- kanban state ---------------------------------------------------------

test("addHumanMessage assigns state backlog + taskKind feedback, but a replyTo vehicle gets neither", () => {
  const { store } = freshStore();
  const filed = store.addHumanMessage("bug report", []);
  assert.equal(filed.state, "backlog");
  assert.equal(filed.taskKind, "feedback");

  const vehicle = store.addHumanMessage("approved", [], "r1");
  assert.equal(vehicle.state, undefined);
  assert.equal(vehicle.taskKind, undefined);
});

test("createTask files an agent-originated project task as a human-shaped card", () => {
  const { store } = freshStore();
  const task = store.createTask({ title: "Refactor the thing", project: "review-board" });
  assert.ok(task.id.startsWith("u"));
  assert.equal(task.direction, "human");
  assert.equal(task.createdBy, "agent");
  assert.equal(task.taskKind, "projet");
  assert.equal(task.state, "backlog");
  assert.deepEqual(task.thread, []);
});

test("addAgentMessage maps kind to an initial state: question -> questions, note -> in_progress, review -> approbation", () => {
  const { store } = freshStore();
  assert.equal(store.addAgentMessage({ title: "q", kind: "question" }).state, "questions");
  assert.equal(store.addAgentMessage({ title: "n", kind: "note" }).state, "in_progress");
  assert.equal(store.addAgentMessage({ title: "r", kind: "review" }).state, "approbation");
});

test("reply() moves the card per decision: approved -> landing, otherwise in_progress", () => {
  const { store } = freshStore();
  const a1 = store.addAgentMessage({ title: "Review this", kind: "review" });
  assert.equal(store.reply(a1.id, { text: "ok", decision: "approved" }).state, "landing");
  const a2 = store.addAgentMessage({ title: "Another", kind: "review" });
  assert.equal(store.reply(a2.id, { text: "fix it", decision: "iteration" }).state, "in_progress");
});

test("moveTask validates the state, moves the card, and optionally drops a thread note", () => {
  const { store } = freshStore();
  const task = store.createTask({ title: "Do the thing" });
  const moved = store.moveTask(task.id, "in_progress", "started working on it");
  assert.equal(moved.state, "in_progress");
  assert.equal(moved.thread.length, 1);
  assert.equal(moved.thread[0].text, "started working on it");
  assert.equal(moved.thread[0].from, "agent");
});

test("moveTask throws on an unknown id or an unknown state", () => {
  const { store } = freshStore();
  const task = store.createTask({ title: "Do the thing" });
  assert.throws(() => store.moveTask("u999", "in_progress"));
  assert.throws(() => store.moveTask(task.id, "not-a-real-state"));
});

test("moveTask to closed stamps acknowledgedAt/readAt if absent (stopping redelivery) but does not overwrite existing stamps", () => {
  const { store } = freshStore();
  const a1 = store.addAgentMessage({ title: "Review this" });
  store.reply(a1.id, { text: "ok", decision: "approved" }); // -> landing, status answered
  store.moveTask(a1.id, "closed");
  const closed = store.list().find((m) => m.id === a1.id);
  assert.ok(closed.acknowledgedAt);
  assert.ok(closed.readAt);
  assert.deepEqual(store.peekDeliverable(), [], "closing stops redelivery even without an explicit acknowledge");

  const before = closed.acknowledgedAt;
  store.moveTask(a1.id, "closed", "re-closed, no-op note");
  assert.equal(store.list().find((m) => m.id === a1.id).acknowledgedAt, before, "must not overwrite an existing acknowledgedAt");
});

test("reply() does not move state backward out of closed or landing, but still records the reply", () => {
  const { store } = freshStore();
  const a1 = store.addAgentMessage({ title: "Review this", kind: "review" });
  store.moveTask(a1.id, "closed");
  const replied = store.reply(a1.id, { text: "still fine", decision: "iteration" });
  assert.equal(replied.state, "closed", "must not move backward to in_progress");
  assert.equal(replied.status, "answered");
  assert.equal(replied.reply.text, "still fine");

  const a2 = store.addAgentMessage({ title: "Another", kind: "review" });
  store.reply(a2.id, { text: "ok", decision: "approved" }); // -> landing
  const replied2 = store.reply(a2.id, { text: "re-approved", decision: "approved" });
  assert.equal(replied2.state, "landing", "must stay in landing, not bounce");
});

test("setSummary sets msg.summary", () => {
  const { store } = freshStore();
  const h1 = store.addHumanMessage("the login button is broken on the settings page", []);
  const updated = store.setSummary(h1.id, "login button broken");
  assert.equal(updated.summary, "login button broken");
  assert.equal(store.list().find((m) => m.id === h1.id).summary, "login button broken");
});

test("migration assigns state to stateless data loaded from disk: human question->questions, human done->approbation, human other->in_progress, agent kind mapping, replyTo skipped", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-board-test-"));
  fs.writeFileSync(
    path.join(dir, "messages.json"),
    JSON.stringify({
      nextAgentId: 3,
      nextHumanId: 5,
      history: [],
      messages: [
        { id: "u1", direction: "human", title: "waiting on question", thread: [{ from: "agent", kind: "question", text: "?" }] },
        { id: "u2", direction: "human", title: "waiting on done", thread: [{ from: "agent", kind: "done", text: "done" }] },
        { id: "u3", direction: "human", title: "plain feedback, no thread" },
        { id: "u4", direction: "human", title: "reply vehicle", replyTo: "r1" },
        { id: "r1", direction: "agent", kind: "question", title: "a question card" },
        { id: "r2", direction: "agent", kind: "review", title: "a review card" },
      ],
    })
  );
  process.env.REVIEW_BOARD_DATA_DIR = dir;
  delete require.cache[require.resolve("../server/store")];
  const store = require("../server/store");
  const byId = (id) => store.list().find((m) => m.id === id);
  assert.equal(byId("u1").state, "questions");
  assert.equal(byId("u2").state, "approbation");
  assert.equal(byId("u3").state, "in_progress");
  assert.equal(byId("u4").state, undefined);
  assert.equal(byId("r1").state, "questions");
  assert.equal(byId("r2").state, "approbation");
});
