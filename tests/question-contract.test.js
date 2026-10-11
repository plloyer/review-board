"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
process.env.REVIEW_BOARD_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "question-contract-"));
process.env.REVIEW_BOARD_NO_SUMMARY = "1";
const Questions = require("../shared/questions");
const store = require("../server/store");
const { buildServer } = require("../server/mcp");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
const directory = path.join(__dirname, "fixtures");
const cases = JSON.parse(fs.readFileSync(path.join(directory, "owner-decision-cases.json"), "utf8"));
const body = entry => (entry.file ? fs.readFileSync(path.join(directory, entry.file), "utf8") : entry.text)
  + "\n\nPosted by: contract-test";

test("q.txt keeps the complete decimal-version owner question and its marked recommendation", () => {
  const result = Questions.requireDecision(body(cases[0]));
  assert.equal(result.question, "Tu autorises la relance du chef d'orchestre avec Claude Opus 5.5 ?");
  assert.deepEqual(result.options, ["OUI", "NON"]);
  assert.match(result.recommendation, /^- OUI :.*\(recommandé\)/);
});

test("the shared posting fixtures match the actual MCP question gate before mutation", async () => {
  const server = buildServer(), client = new Client({ name: "question-contract-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    for (const entry of cases) {
      const text = body(entry);
      const parsed = Questions.parse(text);
      assert.equal(!parsed.error, entry.accepted, entry.name);
      const card = store.addHumanMessage("Synthetic owner decision", []);
      const before = JSON.stringify(card), sequence = store.replayEvents(0).sequence;
      const result = await client.callTool({ name: "reply_to_message", arguments: {
        id: card.id, kind: "question", text, agent: { vendor: "codex", model: "contract-test" } } });
      assert.equal(!result.isError, entry.accepted, entry.name);
      if (entry.accepted) {
        assert.equal(card.state, "questions", entry.name);
        assert.equal(card.thread.at(-1).text, text, entry.name);
      } else {
        assert.ok(parsed.error.includes(entry.error), entry.name);
        assert.equal(result.content[0].text, "OWNER DECISION REQUIRED: " + parsed.error, entry.name);
        assert.equal(JSON.stringify(card), before, entry.name);
        assert.equal(store.replayEvents(0).sequence, sequence, entry.name);
      }
    }
  } finally { await client.close(); await server.close(); }
});
