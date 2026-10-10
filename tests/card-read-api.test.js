"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
process.env.REVIEW_BOARD_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "card-read-api-"));
process.env.REVIEW_BOARD_NO_SUMMARY = "1";
delete process.env.REVIEW_BOARD_TARGETED_READ_IDS;
const store = require("../server/store");
const { buildServer } = require("../server/mcp");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");

async function clientFor(run) {
  const server = buildServer();
  const client = new Client({ name: "targeted-read-tests", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try { await run(client); }
  finally { await client.close(); await server.close(); }
}

test("MCP schema is strict, read-only and constrained to one id; extra permission and batch fields fail", async () => {
  await clientFor(async client => {
    const tools = await client.listTools();
    const tool = tools.tools.find(entry => entry.name === "get_message");
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(tool.inputSchema.required, ["id"]);
    assert.equal(tool.inputSchema.properties.threadLimit.maximum, 50);
    assert.equal(tool.annotations.readOnlyHint, true);
    for (const args of [{ id: ["r293", "r294"] }, { id: "r293", scope: ["r293"] },
      { id: "r293", acknowledge: true }, { id: "r293", includeAll: true }, { id: "r293*" }]) {
      const result = await client.callTool({ name: "get_message", arguments: args });
      assert.equal(result.isError, true);
    }
  });
});

test("MCP returns exact decision only on scoped card without reading files, delivering, acking or changing state", async () => {
  const target = store.addAgentMessage({ title: "target question", kind: "note" });
  const foreign = store.addAgentMessage({ title: "foreign-content-secret", kind: "note" });
  store.reply(target.id, { text: "Exact answer\nwith Unicode: été", optionChosen: "A", decision: null });
  store.humanThreadNote(target.id, "direct target thread");
  store.addHumanMessage("direct target delivery", [], target.id);
  store.addHumanMessage("foreign-thread-secret", [], foreign.id);
  const file = path.join(store.DATA_DIR, "messages.json");
  const beforeBytes = fs.readFileSync(file);
  const beforeSequence = store.replayEvents(0).sequence;
  const before = JSON.stringify(store.list());
  await clientFor(async client => {
    let result = await client.callTool({ name: "get_message", arguments: { id: target.id } });
    assert.equal(result.isError, true); // default deny
    process.env.REVIEW_BOARD_TARGETED_READ_IDS = target.id;
    result = await client.callTool({ name: "get_message", arguments: { id: target.id } });
    assert.ok(!result.isError);
    const message = JSON.parse(result.content[0].text);
    assert.equal(message.card.id, target.id);
    assert.equal(message.reply.text, "Exact answer\nwith Unicode: été");
    assert.equal(message.reply.optionChosen, "A");
    assert.equal(message.reply.decision, null); // Never infer approval from answered/A.
    assert.equal(message.thread.items.length, 2);
    assert.doesNotMatch(JSON.stringify(result), /foreign-content|foreign-thread/);
    assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= 64 * 1024);
    for (const id of [foreign.id, "r999"]) {
      const denied = await client.callTool({ name: "get_message", arguments: { id } });
      assert.equal(denied.content[0].text, "Targeted read not allowed for this id");
    }
    delete process.env.REVIEW_BOARD_TARGETED_READ_IDS;
  });
  assert.deepEqual(fs.readFileSync(file), beforeBytes);
  assert.equal(store.replayEvents(0).sequence, beforeSequence);
  assert.equal(JSON.stringify(store.list()), before);
});
