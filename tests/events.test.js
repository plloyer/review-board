"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "board-events-"));
process.env.REVIEW_BOARD_DATA_DIR = directory;
process.env.REVIEW_BOARD_NO_SUMMARY = "1";
const store = require("../server/store");
const { createApp } = require("../server/web");
test.after(() => fs.rmSync(directory, { recursive: true, force: true }));

async function serverTest(callback) {
  const server = createApp().listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  try { await callback(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

const completion = cardId => ({ cardId, role: "builder", report: "REPORT.md", digest: "a".repeat(64),
  verdict: "done", host: "test-host", key: `${cardId}:REPORT.md:${"a".repeat(64)}` });

test("journal names card changes and authors, and survives a fresh process", () => {
  const start = store.replayEvents(0).sequence;
  const card = store.addHumanMessage("test", []);
  store.humanThreadNote(card.id, "Approuvé");
  store.agentReply(card.id, "progress", "update");
  store.moveTask(card.id, "in_progress", "", { actor: "agent", agent: { vendor: "codex", model: "test" } });
  const records = store.replayEvents(start).events;
  assert.deepEqual(records.map(event => [event.sequence, event.cardId, event.kind, event.author]), [
    [start + 1, card.id, "created", "human"], [start + 2, card.id, "approval", "human"],
    [start + 3, card.id, "agent_reply", "agent"], [start + 4, card.id, "move", "agent"]]);
  const fresh = spawnSync(process.execPath, ["-e", `process.stdout.write(JSON.stringify(require('./server/store').replayEvents(${start})))`],
    { cwd: path.join(__dirname, ".."), encoding: "utf8" });
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.deepEqual(JSON.parse(fresh.stdout).events, records);
  const persisted = JSON.parse(fs.readFileSync(path.join(directory, "messages.json")));
  assert.equal(persisted.eventSequence, start + 4);
  assert.equal(persisted.messages.find(message => message.id === card.id).state, "in_progress");
});

test("long poll wakes on a committed PL reply, replays suffix, and cleans listeners", async () => {
  await serverTest(async base => {
    const card = store.addAgentMessage({ title: "test" });
    const after = store.replayEvents(0).sequence;
    const listening = new Promise(resolve => store.events.once("newListener", name => {
      if (name === "change") resolve();
    }));
    const response = fetch(`${base}/api/event-journal?after=${after}&timeout=25`).then(response => response.json());
    await listening;
    store.reply(card.id, { text: "yes", decision: "approved" });
    const answer = await response;
    assert.equal(answer.events.length, 1);
    assert.equal(answer.events[0].kind, "approval");
    assert.equal(answer.events[0].author, "human");
    assert.equal(answer.events[0].sequence, after + 1);
    const replay = await (await fetch(`${base}/api/event-journal?after=${after}`)).json();
    assert.deepEqual(replay, answer);
    assert.equal(store.events.listenerCount("change"), 0);
    assert.equal((await fetch(`${base}/api/event-journal?after=${after + 2}`)).status, 409);
    assert.equal((await fetch(`${base}/api/event-journal?after=-1`)).status, 400);
  });
});

test("remote completion HTTP retries return one durable event, reject mismatch and malformed", async () => {
  await serverTest(async base => {
    const card = store.createTask({ title: "test", noReview: true });
    const event = completion(card.id);
    const post = payload => fetch(`${base}/api/events/completion`, { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const first = await (await post(event)).json();
    const second = await (await post(event)).json();
    assert.equal(first.sequence, second.sequence);
    assert.equal(first.kind, "completion");
    assert.equal((await post({ ...event, verdict: "red" })).status, 400);
    assert.equal((await post({ ...event, key: "other", digest: "no" })).status, 400);
    assert.equal((await post({ ...event, cardId: "u999999" })).status, 400);
    const start = store.replayEvents(first.sequence).sequence;
    store.moveTask(card.id, "closed", "human move note", { actor: "human" });
    assert.equal(store.replayEvents(start).events[0].author, "human");
  });
});

test("agent-created task emits an agent event and thread delivery vehicles stay distinguishable", () => {
  const after = store.replayEvents(0).sequence;
  const card = store.createTask({ title: "new" });
  store.addHumanMessage("reply", [], card.id);
  assert.deepEqual(store.replayEvents(after).events.map(event => [event.cardId, event.kind, event.author]),
    [[card.id, "created", "agent"], [card.id, "delivery", "human"]]);
});

test("a failed state write takes its journal records back", () => {
  const card = store.addAgentMessage({ title: "rollback" });
  const before = store.replayEvents(0).sequence;
  const rename = fs.renameSync;
  fs.renameSync = () => { throw new Error("disk full"); };
  try { assert.throws(() => store.reply(card.id, { text: "yes", decision: "approved" }), /disk full/); }
  finally { fs.renameSync = rename; }
  assert.equal(store.replayEvents(0).sequence, before);
  assert.equal(store.replayEvents(before).events.length, 0);
  store.reply(card.id, { text: "yes", decision: "approved" });
  const records = store.replayEvents(before).events;
  assert.equal(records[0].sequence, before + 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, "messages.json"))).eventSequence, store.replayEvents(0).sequence);
});

test("many concurrent long polls raise no listener-leak warning", async () => {
  const warnings = [];
  const onWarning = warning => warnings.push(warning.name);
  process.on("warning", onWarning);
  await serverTest(async base => {
    const after = store.replayEvents(0).sequence;
    const polls = Array.from({ length: 15 }, () => fetch(`${base}/api/event-journal?after=${after}&timeout=1`));
    await Promise.all(polls);
  });
  await new Promise(resolve => setImmediate(resolve));
  process.off("warning", onWarning);
  assert.ok(!warnings.includes("MaxListenersExceededWarning"), warnings.join(","));
});
