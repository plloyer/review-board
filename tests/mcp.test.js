"use strict";
// Exercises the MCP tool surface end-to-end (real JSON-RPC over an in-memory
// transport) so kind->state side effects are proven at the tool boundary, not
// just in the store functions the tools call.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");

const AGENT = { vendor: "claude", model: "Fable 5.1", effort: "max" };

function freshServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-board-mcp-test-"));
  process.env.REVIEW_BOARD_DATA_DIR = dir;
  delete require.cache[require.resolve("../server/store")];
  delete require.cache[require.resolve("../server/mcp")];
  return { store: require("../server/store"), mcp: require("../server/mcp") };
}

async function connectedClient(mcp) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = mcp.buildServer();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

test("create_task files a backlog project task", async () => {
  const { store, mcp } = freshServer();
  const client = await connectedClient(mcp);
  const res = await client.callTool({ name: "create_task", arguments: { title: "Refactor the thing" } });
  const id = res.content[0].text;
  const task = store.list().find((m) => m.id === id);
  assert.equal(task.state, "backlog");
  assert.equal(task.taskKind, "projet");
});

test("create_task returns the bare id as its first block, unchanged, plus a dependency reminder block", async () => {
  const { store, mcp } = freshServer();
  const client = await connectedClient(mcp);
  const res = await client.callTool({ name: "create_task", arguments: { title: "T" } });
  // First block stays EXACTLY the id — a caller parsing content[0].text as the id must keep working.
  const first = res.content[0].text;
  assert.match(first, /^u?t?\d+$/); // an id like "t1" — no label, no extra text
  assert.ok(store.list().some((m) => m.id === first));
  // A second block reminds how to wire dependencies/priority (the friction that prompted this).
  assert.equal(res.content.length, 2);
  assert.match(res.content[1].text, /blocked_by/);
  assert.match(res.content[1].text, /set_blockers/);
});

test("move_task moves a card and rejects an unknown state", async () => {
  const { store, mcp } = freshServer();
  const client = await connectedClient(mcp);
  const task = store.createTask({ title: "Do the thing" });
  await client.callTool({ name: "move_task", arguments: { id: task.id, state: "in_progress", agent: AGENT } });
  assert.equal(store.list().find((m) => m.id === task.id).state, "in_progress");

  const bad = await client.callTool({ name: "move_task", arguments: { id: task.id, state: "bogus" } });
  assert.equal(bad.isError, true);
});

test("reply_to_message kind question/done move the card; kind update does not", async () => {
  const { store, mcp } = freshServer();
  const client = await connectedClient(mcp);
  const h1 = store.addHumanMessage("bug report", []);

  await client.callTool({ name: "reply_to_message", arguments: { id: h1.id, text: "need more info", kind: "question" } });
  assert.equal(store.list().find((m) => m.id === h1.id).state, "questions");

  await client.callTool({ name: "reply_to_message", arguments: { id: h1.id, text: "fixed, ready for review", kind: "done" } });
  assert.equal(store.list().find((m) => m.id === h1.id).state, "approbation");

  await client.callTool({ name: "reply_to_message", arguments: { id: h1.id, text: "still on it" } });
  assert.equal(store.list().find((m) => m.id === h1.id).state, "approbation", "kind update must not move the card");
});

test("close_issue moves an APPROVED card to closed without archiving it off the board", async () => {
  const { store, mcp } = freshServer();
  const client = await connectedClient(mcp);
  const h1 = store.addHumanMessage("bug report", []);
  store.humanThreadNote(h1.id, "Approuvé ✅");
  await client.callTool({ name: "close_issue", arguments: { id: h1.id, note: "shipped in build 42", retro: "friction: none" } });
  const still = store.list().find((m) => m.id === h1.id);
  assert.ok(still, "close_issue must not remove the card — the human archives it himself");
  assert.equal(still.state, "closed");
  assert.equal(still.thread.at(-1).text, "shipped in build 42");
});

test("close_issue refuses an unapproved card — same gate as move_task", async () => {
  const { store, mcp } = freshServer();
  const client = await connectedClient(mcp);
  const h1 = store.addHumanMessage("bug report", []);
  store.setRetro(h1.id, "friction: none"); // retro present — this must still fail on the approval gate, not the retro gate
  const res = await client.callTool({ name: "close_issue", arguments: { id: h1.id } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /approval/);
  assert.notEqual(store.list().find((m) => m.id === h1.id).state, "closed");
});

// --- retrospective gate -------------------------------------------------------

test("reply_to_message kind 'done' stores the retro param on the card", async () => {
  const { store, mcp } = freshServer();
  const client = await connectedClient(mcp);
  const h1 = store.addHumanMessage("bug report", []);
  await client.callTool({
    name: "reply_to_message",
    arguments: { id: h1.id, text: "fixed, ready for review", kind: "done", retro: "Friction: none. Gaps: none. Different: none." },
  });
  assert.equal(store.list().find((m) => m.id === h1.id).retro, "Friction: none. Gaps: none. Different: none.");
});

test("close_issue refuses a no_review card with no retro anywhere, citing the three-point template", async () => {
  const { store, mcp } = freshServer();
  const client = await connectedClient(mcp);
  const task = store.createTask({ title: "Trivial task", noReview: true });
  const res = await client.callTool({ name: "close_issue", arguments: { id: task.id } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Friction encountered/);
  assert.match(res.content[0].text, /Config\/skill gaps/);
  assert.match(res.content[0].text, /What to do differently/);
  assert.notEqual(store.list().find((m) => m.id === task.id).state, "closed");
});

test("close_issue succeeds on a no_review card when a retro is passed at close time", async () => {
  const { store, mcp } = freshServer();
  const client = await connectedClient(mcp);
  const task = store.createTask({ title: "Trivial task", noReview: true });
  const res = await client.callTool({ name: "close_issue", arguments: { id: task.id, retro: "friction: none, gaps: none, different: none" } });
  assert.equal(res.isError, undefined, res.content?.[0]?.text);
  const closed = store.list().find((m) => m.id === task.id);
  assert.equal(closed.state, "closed");
  assert.equal(closed.retro, "friction: none, gaps: none, different: none");
});

test("close_issue succeeds on a no_review card whose retro was already attached by the done delivery", async () => {
  const { store, mcp } = freshServer();
  const client = await connectedClient(mcp);
  const task = store.createTask({ title: "Trivial task", noReview: true });
  store.agentReply(task.id, "done, proof attached", "done", { retro: "friction: none" });
  const res = await client.callTool({ name: "close_issue", arguments: { id: task.id } });
  assert.equal(res.isError, undefined, res.content?.[0]?.text);
  assert.equal(store.list().find((m) => m.id === task.id).state, "closed");
});

test("close_issue({retro}) on an unapproved card returns the APPROVAL error and never writes the retro", async () => {
  const { store, mcp } = freshServer();
  const client = await connectedClient(mcp);
  const h1 = store.addHumanMessage("bug report", []);
  const res = await client.callTool({ name: "close_issue", arguments: { id: h1.id, retro: "friction: none" } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /approval/);
  const msg = store.list().find((m) => m.id === h1.id);
  assert.equal(msg.retro, undefined, "retro must not be written when the approval check fails");
  assert.notEqual(msg.state, "closed");
});

test("move_task to closed refuses without a retro on an already-approved card — closes the move_task bypass around close_issue's gate", async () => {
  const { store, mcp } = freshServer();
  const client = await connectedClient(mcp);
  const h1 = store.addHumanMessage("bug report", []);
  store.humanThreadNote(h1.id, "Approuvé ✅"); // approved: only the retro gate is left to exercise
  const res = await client.callTool({ name: "move_task", arguments: { id: h1.id, state: "closed" } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /retrospective/);
  assert.notEqual(store.list().find((m) => m.id === h1.id).state, "closed");
});

test("reply_to_message rejects a retro param on any kind other than 'done', with no side effects", async () => {
  const { store, mcp } = freshServer();
  const client = await connectedClient(mcp);
  const h1 = store.addHumanMessage("bug report", []);
  const res = await client.callTool({
    name: "reply_to_message",
    arguments: { id: h1.id, text: "still on it", kind: "update", retro: "should be refused" },
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /kind "done"/);
  const msg = store.list().find((m) => m.id === h1.id);
  assert.equal(msg.retro, undefined, "no retro must be stored");
  assert.equal((msg.thread || []).length, 0, "no reply must be recorded");
});

test("the approved human-direction workflow lands: create_task -> done -> Approuvé -> move_task landing", async () => {
  const { store, mcp } = freshServer();
  const client = await connectedClient(mcp);
  await client.callTool({ name: "create_task", arguments: { title: "wire the menu", context: "c" } });
  const task = store.list().find((m) => m.title === "wire the menu");
  await client.callTool({ name: "move_task", arguments: { id: task.id, state: "in_progress", agent: AGENT } });
  store.agentReply(task.id, "done, proof attached", "done");
  store.humanThreadNote(task.id, "Approuvé ✅");
  // An agent progress note after the approval must not cancel it.
  store.agentReply(task.id, "merging", "update");
  const res = await client.callTool({ name: "move_task", arguments: { id: task.id, state: "landing" } });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  assert.equal(store.list().find((m) => m.id === task.id).state, "landing");
});

test("create_task/move_task accept blocked_by and priority; set_blockers/set_priority tools work standalone", async () => {
  const { store, mcp } = freshServer();
  const client = await connectedClient(mcp);
  const blocker = store.createTask({ title: "Blocker" });

  const created = await client.callTool({
    name: "create_task",
    arguments: { title: "Dependent", blocked_by: [blocker.id], priority: 1 },
  });
  const depId = created.content[0].text;
  const dep = store.list().find((m) => m.id === depId);
  assert.deepEqual(dep.blockedBy, [blocker.id]);
  assert.equal(dep.priority, 1);

  const other = store.createTask({ title: "Other" });
  await client.callTool({ name: "move_task", arguments: { id: other.id, state: "in_progress", agent: AGENT, blocked_by: [blocker.id], priority: 3 } });
  const movedOther = store.list().find((m) => m.id === other.id);
  assert.deepEqual(movedOther.blockedBy, [blocker.id]);
  assert.equal(movedOther.priority, 3);

  await client.callTool({ name: "set_blockers", arguments: { id: other.id, blocked_by: [] } });
  assert.deepEqual(store.list().find((m) => m.id === other.id).blockedBy, []);

  await client.callTool({ name: "set_priority", arguments: { id: other.id, priority: 2 } });
  assert.equal(store.list().find((m) => m.id === other.id).priority, 2);
});

test("create_task with priority 0 roundtrips, and set_priority to 0 works", async () => {
  const { store, mcp } = freshServer();
  const client = await connectedClient(mcp);

  const created = await client.callTool({ name: "create_task", arguments: { title: "Critical", priority: 0 } });
  const id = created.content[0].text;
  assert.equal(store.list().find((m) => m.id === id).priority, 0);

  const other = store.createTask({ title: "Other" });
  await client.callTool({ name: "set_priority", arguments: { id: other.id, priority: 0 } });
  assert.equal(store.list().find((m) => m.id === other.id).priority, 0);
});

test("set_blockers rejects a cycle through the MCP tool boundary", async () => {
  const { store, mcp } = freshServer();
  const client = await connectedClient(mcp);
  const a = store.createTask({ title: "A" });
  const b = store.createTask({ title: "B" });
  await client.callTool({ name: "set_blockers", arguments: { id: a.id, blocked_by: [b.id] } });
  const res = await client.callTool({ name: "set_blockers", arguments: { id: b.id, blocked_by: [a.id] } });
  assert.equal(res.isError, true);
});

test("create_task with no_review roundtrips onto the card, visible via list_messages like any other task", async () => {
  const { store, mcp } = freshServer();
  const client = await connectedClient(mcp);
  const res = await client.callTool({ name: "create_task", arguments: { title: "Trivial task", no_review: true } });
  const id = res.content[0].text;
  assert.equal(store.list().find((m) => m.id === id).noReview, true);
  const listed = await client.callTool({ name: "list_messages", arguments: {} });
  assert.match(listed.content[0].text, new RegExp(`\\[${id}\\].*Trivial task`));
});

test("move_task to landing on a normal in_progress card returns the instructive error and leaves it in place", async () => {
  const { store, mcp } = freshServer();
  const client = await connectedClient(mcp);
  const task = store.createTask({ title: "Do the thing" });
  await client.callTool({ name: "move_task", arguments: { id: task.id, state: "in_progress", agent: AGENT } });

  const res = await client.callTool({ name: "move_task", arguments: { id: task.id, state: "landing" } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /reply_to_message/);
  assert.match(res.content[0].text, /no_review/);
  assert.equal(store.list().find((m) => m.id === task.id).state, "in_progress", "refused move must leave state untouched");
});

test("move_task to landing succeeds for a no_review card", async () => {
  const { store, mcp } = freshServer();
  const client = await connectedClient(mcp);
  const created = await client.callTool({ name: "create_task", arguments: { title: "Trivial task", no_review: true } });
  const id = created.content[0].text;
  await client.callTool({ name: "move_task", arguments: { id, state: "in_progress", agent: AGENT } });

  const res = await client.callTool({ name: "move_task", arguments: { id, state: "landing" } });
  assert.equal(res.isError, undefined);
  assert.equal(store.list().find((m) => m.id === id).state, "landing");
});

test("request_change files a backlog change-request card", async () => {
  const { store, mcp } = freshServer();
  const client = await connectedClient(mcp);
  const res = await client.callTool({ name: "request_change", arguments: { title: "Add snooze", details: "defer a card" } });
  const id = res.content[0].text;
  const card = store.list().find((m) => m.id === id);
  assert.equal(card.taskKind, "change-request");
  assert.equal(card.state, "backlog");
  assert.equal(card.context, "defer a card");
});

test("list_messages appends blocked_by and priority suffixes only where applicable", async () => {
  const { store, mcp } = freshServer();
  const client = await connectedClient(mcp);
  const blocker = store.createTask({ title: "Blocker" });
  store.createTask({ title: "Dependent", blockedBy: [blocker.id] });
  store.setPriority(blocker.id, 1);

  const res = await client.callTool({ name: "list_messages", arguments: {} });
  const text = res.content[0].text;
  assert.match(text, /Blocker.* p1/);
  assert.match(text, /Dependent.*blocked_by: /);
});

test("list_messages shows a P0 card", async () => {
  const { store, mcp } = freshServer();
  const client = await connectedClient(mcp);
  const critical = store.createTask({ title: "Critical", priority: 0 });

  const res = await client.callTool({ name: "list_messages", arguments: {} });
  assert.match(res.content[0].text, new RegExp(`\\[${critical.id}\\].*Critical.* p0`));
});

// --- attachment validation ---------------------------------------------------

test("send_message rejects a missing images/videos path, listing them verbatim and creating nothing", async () => {
  const { store, mcp } = freshServer();
  const client = await connectedClient(mcp);
  const missingImg = path.join(os.tmpdir(), "review-board-missing-img-does-not-exist.png");
  const missingVid = path.join(os.tmpdir(), "review-board-missing-vid-does-not-exist.mp4");
  const res = await client.callTool({
    name: "send_message",
    arguments: { messages: [{ title: "Look at this", images: [{ path: missingImg }], videos: [{ path: missingVid }] }] },
  });
  assert.equal(res.isError, true);
  const text = res.content[0].text;
  assert.ok(text.includes(missingImg), "must list the missing image path verbatim");
  assert.ok(text.includes(missingVid), "must list the missing video path verbatim");
  assert.match(text, /POST the bytes first: \/api\/upload/);
  assert.equal(store.list().length, 0, "nothing must be created when an attachment is unreadable");
});

test("send_message succeeds when every images/videos path exists on this machine", async () => {
  const { store, mcp } = freshServer();
  const client = await connectedClient(mcp);
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-board-attach-src-"));
  const img = path.join(srcDir, "shot.png");
  fs.writeFileSync(img, "bytes");
  const res = await client.callTool({
    name: "send_message",
    arguments: { messages: [{ title: "Look at this", images: [{ path: img, label: "Before", caption: "Our settlement at dawn" }] }] },
  });
  assert.equal(res.isError, undefined);
  assert.equal(store.list().length, 1);
  const stored = store.list()[0].images[0];
  assert.equal(stored.label, "Before");
  assert.equal(stored.caption, "Our settlement at dawn");
});

test("reply_to_message rejects a bare local markdown image path that does not exist, appending no thread entry", async () => {
  const { store, mcp } = freshServer();
  const client = await connectedClient(mcp);
  const h1 = store.addHumanMessage("bug report", []);
  const missing = path.join(os.tmpdir(), "review-board-missing-proof-does-not-exist.png");
  const res = await client.callTool({
    name: "reply_to_message",
    arguments: { id: h1.id, text: `fixed, see ![proof](${missing})`, kind: "done" },
  });
  assert.equal(res.isError, true);
  assert.ok(res.content[0].text.includes(missing));
  assert.equal((store.list().find((m) => m.id === h1.id).thread || []).length, 0, "no thread entry must be appended on rejection");
});

test("reply_to_message rejects an /api/image?path= ref that neither exists nor sits under the data dir", async () => {
  const { store, mcp } = freshServer();
  const client = await connectedClient(mcp);
  const h1 = store.addHumanMessage("bug report", []);
  const missing = path.join(os.tmpdir(), "review-board-missing-proof-2-does-not-exist.png");
  const res = await client.callTool({
    name: "reply_to_message",
    arguments: { id: h1.id, text: `fixed: ![proof](/api/image?path=${encodeURIComponent(missing)})`, kind: "done" },
  });
  assert.equal(res.isError, true);
  assert.ok(res.content[0].text.includes(missing));
});

test("reply_to_message accepts an existing local path, an http(s) URL, and a data-dir path even if not yet on disk", async () => {
  const { store, mcp } = freshServer();
  const client = await connectedClient(mcp);
  const h1 = store.addHumanMessage("bug report 1", []);
  const h2 = store.addHumanMessage("bug report 2", []);
  const h3 = store.addHumanMessage("bug report 3", []);

  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-board-reply-proof-"));
  const realImg = path.join(srcDir, "shot.png");
  fs.writeFileSync(realImg, "bytes");
  await client.callTool({ name: "reply_to_message", arguments: { id: h1.id, text: `![proof](${realImg})`, kind: "done" } });
  await client.callTool({ name: "reply_to_message", arguments: { id: h2.id, text: "![proof](https://example.com/shot.png)", kind: "done" } });
  const underData = path.join(store.DATA_DIR, "uploads", "not-yet-on-disk.png");
  await client.callTool({
    name: "reply_to_message",
    arguments: { id: h3.id, text: `![proof](/api/image?path=${encodeURIComponent(underData)})`, kind: "done" },
  });

  assert.equal(store.list().find((m) => m.id === h1.id).state, "approbation");
  assert.equal(store.list().find((m) => m.id === h2.id).state, "approbation");
  assert.equal(store.list().find((m) => m.id === h3.id).state, "approbation");
});

// --- list_messages blocked_by -------------------------------------------------

test("list_messages blocked_by suffix lists only ACTIVE blockers, matching the UI", async () => {
  const { store, mcp } = freshServer();
  const client = await connectedClient(mcp);
  const resolvedBlocker = store.createTask({ title: "Resolved blocker" });
  const activeBlocker = store.createTask({ title: "Active blocker" });
  store.moveTask(resolvedBlocker.id, "closed");
  const dependent = store.createTask({ title: "Dependent", blockedBy: [resolvedBlocker.id, activeBlocker.id] });

  const res = await client.callTool({ name: "list_messages", arguments: {} });
  const depLine = res.content[0].text.split("\n").find((l) => l.startsWith(`[${dependent.id}]`));
  assert.ok(depLine.includes(`blocked_by: ${activeBlocker.id}`), "must list the still-active blocker");
  assert.ok(!depLine.includes(resolvedBlocker.id), "must not list a landed/closed blocker");
});

test("recent_history also finds a live (never-archived) delivered item", async () => {
  const { store, mcp } = freshServer();
  const client = await connectedClient(mcp);
  const a1 = store.addAgentMessage({ title: "Review this" });
  store.reply(a1.id, { text: "ok" }); // -> in_progress, still deliverable
  store.peekDeliverable(); // stamps lastDeliveredAt; card stays live (ack keeps it around)
  store.acknowledge([a1.id]); // read, but not retired (active state)
  assert.ok(store.list().some((m) => m.id === a1.id), "card stays live after ack");

  const res = await client.callTool({ name: "recent_history", arguments: { minutes: 30 } });
  const text = res.content.map((b) => b.text).join("\n");
  assert.match(text, /Review this/);
});

test("move_task in_progress requires the agent declaration and stores it", async () => {
  const { store, mcp } = freshServer();
  const client = await connectedClient(mcp);
  const task = store.createTask({ title: "T" });
  const missing = await client.callTool({ name: "move_task", arguments: { id: task.id, state: "in_progress" } });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /agent/);
  assert.equal(store.list().find((m) => m.id === task.id).state, "backlog");

  const ok = await client.callTool({ name: "move_task", arguments: { id: task.id, state: "in_progress", agent: AGENT } });
  assert.equal(ok.isError, undefined, ok.content?.[0]?.text);
  assert.deepEqual(store.list().find((m) => m.id === task.id).agent, AGENT);

  const bad = await client.callTool({
    name: "move_task",
    arguments: { id: task.id, state: "questions", agent: { vendor: "skynet", model: "T-800" } },
  });
  assert.equal(bad.isError, true);
  const blank = await client.callTool({ name: "move_task", arguments: { id: task.id, state: "questions", agent: { vendor: "codex", model: "   " } } });
  assert.equal(blank.isError, true);
  const after = store.list().find((m) => m.id === task.id);
  assert.equal(after.state, "in_progress");
  assert.deepEqual(after.agent, AGENT, "a rejected declaration must not touch the card");

  // Re-entry (the human refused the delivery) needs no new declaration.
  store.agentReply(task.id, "done", "done");
  const back = await client.callTool({ name: "move_task", arguments: { id: task.id, state: "in_progress", priority: 1 } });
  assert.equal(back.isError, undefined, back.content?.[0]?.text);
  assert.equal(store.list().find((m) => m.id === task.id).state, "in_progress");
});

test("reply_to_message accepts an agent declaration when a card changes hands", async () => {
  const { store, mcp } = freshServer();
  const client = await connectedClient(mcp);
  const task = store.createTask({ title: "T" });
  await client.callTool({ name: "move_task", arguments: { id: task.id, state: "in_progress", agent: AGENT } });
  const res = await client.callTool({
    name: "reply_to_message",
    arguments: { id: task.id, text: "taking over", agent: { vendor: "antigravity", model: "Gemini 3.1 Pro", effort: "medium" } },
  });
  assert.equal(res.isError, undefined, res.content?.[0]?.text);
  assert.equal(store.list().find((m) => m.id === task.id).agent.vendor, "antigravity");
});

test("reply_to_message rejects a malformed image target even when a quoted title follows it", async () => {
  const { store, mcp } = freshServer();
  const client = await connectedClient(mcp);
  const h1 = store.addHumanMessage("bug report", []);
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-board-title-ref-"));
  const img = path.join(srcDir, "shot.png");
  fs.writeFileSync(img, "bytes");
  const enc = encodeURIComponent(img);
  const res = await client.callTool({
    name: "reply_to_message",
    arguments: { id: h1.id, text: `see ![Before]($/api/image?path=${enc} "what it shows")`, kind: "done" },
  });
  assert.equal(res.isError, true);
  assert.ok(res.content[0].text.includes("$/api/image"), res.content[0].text);
  assert.equal((store.list().find((m) => m.id === h1.id).thread || []).length, 0);

  const ok = await client.callTool({
    name: "reply_to_message",
    arguments: { id: h1.id, text: `see ![Before](/api/image?path=${enc} "what it shows")`, kind: "done" },
  });
  assert.equal(ok.isError, undefined, ok.content?.[0]?.text);
});

test("tags travel through create_task / move_task and show in list_messages", async () => {
  const { store, mcp } = freshServer();
  const client = await connectedClient(mcp);
  const created = await client.callTool({ name: "create_task", arguments: { title: "Build on the Mac", tags: ["mac", "unity"] } });
  const id = created.content[0].text;
  assert.deepEqual(store.list().find((m) => m.id === id).tags, ["mac", "unity"]);
  const res = await client.callTool({ name: "list_messages", arguments: {} });
  assert.match(res.content[0].text, new RegExp(`\\[${id}\\].*tags: mac,unity`));
  const moved = await client.callTool({ name: "move_task", arguments: { id, state: "in_progress", agent: AGENT, tags: ["mac"] } });
  assert.equal(moved.isError, undefined, moved.content?.[0]?.text);
  assert.deepEqual(store.list().find((m) => m.id === id).tags, ["mac"]);
});
