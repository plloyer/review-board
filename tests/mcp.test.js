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

test("move_task moves a card and rejects an unknown state", async () => {
  const { store, mcp } = freshServer();
  const client = await connectedClient(mcp);
  const task = store.createTask({ title: "Do the thing" });
  await client.callTool({ name: "move_task", arguments: { id: task.id, state: "in_progress" } });
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

test("close_issue moves the card to closed without archiving it off the board", async () => {
  const { store, mcp } = freshServer();
  const client = await connectedClient(mcp);
  const h1 = store.addHumanMessage("bug report", []);
  await client.callTool({ name: "close_issue", arguments: { id: h1.id, note: "shipped in build 42" } });
  const still = store.list().find((m) => m.id === h1.id);
  assert.ok(still, "close_issue must not remove the card — the human archives it himself");
  assert.equal(still.state, "closed");
  assert.equal(still.thread.at(-1).text, "shipped in build 42");
});
