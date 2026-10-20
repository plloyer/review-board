"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
process.env.REVIEW_BOARD_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "execution-api-"));
process.env.REVIEW_BOARD_NO_SUMMARY = "1";
const { createApp } = require("../server/web");
const store = require("../server/store");
const trace = require("../server/execution-trace");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const action = { operation: "publish", command: "publish exact-version", cwd: "/isolated/repo", destination: "example.invalid",
  targetRef: "main", version: "revision-1", threadId: "owning-task", effects: ["publish"] };
const observed = { id: "api-observation", type: "observed", actionId: trace.actionId(action), at: "2026-10-10T16:00:00Z", source: "test", action };
async function withServer(run) {
  const server = await new Promise(resolve => { const handle = createApp().listen(0, "127.0.0.1", () => resolve(handle)); });
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
test("HTTP evidence delivery, scoped human consent and replay never execute or grant native permission", async () => {
  const card = store.createTask({ tags: ["unity-free"], title: "Execution integration" });
  await withServer(async base => {
    const post = (suffix, body) => fetch(`${base}/api/messages/${card.id}/${suffix}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post("execution-events", observed)).status, 200);
    const denied = { id: "api-denied", type: "denied", actionId: observed.actionId, at: "2026-10-10T16:35:00Z", source: "exec-output",
      reason: "exact rationale", reasonSource: "exec-output", provenance: "unknown", nativeReviewId: null, attemptId: null };
    assert.equal((await post("execution-events", denied)).status, 200);
    const payload = { actionId: observed.actionId, decision: "approved" };
    const approved = await (await post("execution-consent", payload)).json();
    assert.equal(approved.state, "backlog");
    assert.equal(approved.execution.consent.decision, "approved");
    assert.equal(approved.execution.recovery.executable, false);
    const sequence = store.replayEvents(0).sequence;
    assert.equal((await post("execution-consent", payload)).status, 200);
    assert.equal(store.replayEvents(0).sequence, sequence);
    const changedAction = { ...action, destination: "other.invalid" };
    assert.equal((await post("execution-events", { ...observed, id: "changed-api", action: changedAction, actionId: trace.actionId(changedAction) })).status, 200);
    assert.equal((await post("execution-consent", payload)).status, 409);
    assert.equal(card.execution.consent, null);
    assert.equal((await post("execution-events", { ...observed, id: "fake", nativeAuthorization: "granted" })).status, 409);
    const restored = JSON.parse(fs.readFileSync(path.join(store.DATA_DIR, "messages.json"))).messages.find(entry => entry.id === card.id);
    assert.deepEqual(restored.execution, card.execution);
  });
});
test("MCP exposes the same evidence contract without a native-approval tool", async () => {
  const card = store.createTask({ tags: ["unity-free"], title: "MCP trace" });
  await withServer(async base => {
    const client = new Client({ name: "trace-tests", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    try {
      const tools = await client.listTools();
      assert.ok(tools.tools.some(tool => tool.name === "record_execution_event"));
      assert.ok(!tools.tools.some(tool => /guardian|native_approv|retry_execution/.test(tool.name)));
      const changedAction = { ...action, threadId: "mcp-owner" };
      const result = await client.callTool({ name: "record_execution_event", arguments: { cardId: card.id,
        event: { ...observed, id: "mcp-observed", action: changedAction, actionId: trace.actionId(changedAction) } } });
      assert.ok(!result.isError);
      assert.equal(JSON.parse(result.content[0].text).recovery.executable, false);
      const fake = await client.callTool({ name: "record_execution_event", arguments: { cardId: card.id,
        event: { id: "fake-grant", type: "native_approved", actionId: trace.actionId(changedAction), at: observed.at, source: "agent" } } });
      assert.equal(fake.isError, true);
    } finally { await client.close(); }
  });
});
test("browser loads execution renderer before views and invalidates overlay cache on changed evidence", () => {
  const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
  assert.ok(html.indexOf('src="execution-view.js"') < html.indexOf('src="views.js"'));
  global.marked = { parse: value => value };
  const views = require("../public/views");
  const state = trace.append(undefined, observed).trace;
  const card = { id: "cache-card", direction: "human", state: "backlog", title: "Evidence", executionTrace: state, execution: trace.project(state) };
  const first = views.deriveOverlayView(card);
  assert.ok(first.bodyHTML.includes("example.invalid"));
  card.execution = { ...card.execution, consent: { decision: "approved", at: observed.at, boardReceipt: "scoped" } };
  const second = views.deriveOverlayView(card);
  assert.notDeepEqual(second, first);
  assert.ok(second.bodyHTML.includes("Retirer mon consentement"));
});
