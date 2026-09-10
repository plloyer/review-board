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

test("acknowledge moves an agent reply to history, but keeps a human message in the live queue (marked read, not re-delivered)", () => {
  const { store } = freshStore();
  const a1 = store.addAgentMessage({ title: "Review this" });
  store.reply(a1.id, { text: "ok" });
  const h1 = store.addHumanMessage("a question", []);

  const count = store.acknowledge([a1.id, h1.id]);
  assert.equal(count, 2);
  assert.deepEqual(store.peekDeliverable(), []);

  const hist = store.history();
  assert.deepEqual(hist.map((m) => m.id), [a1.id]);
  assert.ok(hist[0].deliveredAt);

  const stillListed = store.list().find((m) => m.id === h1.id);
  assert.ok(stillListed, "human message stays in the live queue after ack");
  assert.equal(stillListed.status, "open");
  assert.ok(stillListed.acknowledgedAt);
  assert.ok(stillListed.readAt);
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

test("history() returns acknowledged agent replies", () => {
  const { store } = freshStore();
  const a1 = store.addAgentMessage({ title: "Review this" });
  store.reply(a1.id, { text: "ok" });
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

test("archive throws on an unknown or non-human id", () => {
  const { store } = freshStore();
  const a1 = store.addAgentMessage({ title: "Review this" });
  assert.throws(() => store.archive(a1.id));
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
