"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "player-report-test-"));
process.env.REVIEW_BOARD_DATA_DIR = directory;
process.env.REVIEW_BOARD_NO_SUMMARY = "1";
const store = require("../server/store");
const { createApp } = require("../server/web");
const { createOwnerSession } = require("../server/owner-session");
const Lifecycle = require("../shared/lifecycle");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const SECRET = "fixture-owner-secret-not-a-live-credential-123";
const PL = { id: "PL", role: "owner" };
const AGENT = { vendor: "codex", model: "fixture", effort: "high" };
function report() {
  return store.createTask({ title: "(player-filed) Court empty", taskKind: "feedback", noReview: true, priority: 0 });
}
async function withServer(callback, options = { ownerSecret: SECRET }) {
  const server = createApp(options).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try { await callback(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}
async function post(base, route, body, cookie = "") {
  return fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json", cookie, "X-Board-Identity": "PL" }, body: JSON.stringify(body) });
}
async function login(base) {
  const response = await post(base, "/api/owner/session", { secret: SECRET });
  assert.equal(response.status, 200);
  const header = response.headers.get("set-cookie");
  assert.match(header, /HttpOnly/i);
  assert.match(header, /SameSite=Strict/i);
  assert.deepEqual(await response.json(), { identity: "PL" });
  return header.split(";")[0];
}

test("player report starts in intake; no_review, priority and all generic moves cannot bypass PL", () => {
  const card = report();
  assert.equal(card.state, "report_review");
  assert.equal(store.peekDeliverable().some((entry) => entry.id === card.id), false);
  assert.equal(store.acknowledge([card.id]), 0);
  assert.deepEqual(card.reportApproval, { status: "pending" });
  assert.equal(card.noReview, undefined);
  assert.equal(card.priority, undefined);
  for (const actor of ["agent", "human", "player", "PL"]) {
    for (const target of ["backlog", "in_progress", "approbation", "landing", "closed"]) {
      assert.throws(() => store.moveTask(card.id, target, "", { actor, agent: AGENT }), /PL's report approval/);
    }
  }
  assert.equal(card.state, "report_review");
  assert.equal(store.withdraw([card.id]), 0);
  assert.throws(() => store.archive(card.id), /PL must decide/);
});

test("agent and player/human replies never count as report approval or start work", () => {
  const card = report();
  store.agentReply(card.id, "Approuvé", "done", { agent: AGENT });
  store.humanThreadNote(card.id, "Approuvé ✅");
  assert.equal(card.state, "report_review");
  assert.equal(Lifecycle.playerReportApproved(card), false);
  for (const identity of [null, { id: "player", role: "owner" }, { id: "PL", role: "agent" }, { id: "human", role: "owner" }]) {
    assert.throws(() => store.decidePlayerReport(card.id, { decision: "approved", priority: 1 }, identity), /Only authenticated PL/);
  }
  assert.deepEqual(card.reportApproval, { status: "pending" });
});

test("PL's approval records who/when/priority and enters backlog without approving completed work", () => {
  const card = report();
  store.decidePlayerReport(card.id, { decision: "approved", priority: 0 }, PL);
  assert.equal(card.state, "backlog");
  assert.equal(card.priority, 0);
  assert.equal(card.reportApproval.by, "PL");
  assert.ok(Number.isFinite(Date.parse(card.reportApproval.at)));
  assert.equal(Lifecycle.playerReportApproved(card), true);
  assert.ok(store.peekDeliverable().some((entry) => entry.id === card.id));
  assert.throws(() => store.moveTask(card.id, "report_review", "", { actor: "human" }), /only when a report is filed/);
  assert.equal(Lifecycle.approvedByHuman(card), false, "intake consent is not approval of a delivered fix");
  store.moveTask(card.id, "in_progress", "", { actor: "agent", agent: AGENT });
  assert.equal(card.state, "in_progress");
  assert.throws(() => store.moveTask(card.id, "landing", "", { actor: "agent" }), /human's approval/);
});

test("PL refusal requires a reason, records it and closes without a fabricated work retrospective", () => {
  const card = report();
  const dependent = store.createTask({ title: "Dependent task", blockedBy: [card.id] });
  assert.throws(() => store.decidePlayerReport(card.id, { decision: "refused", reason: " " }, PL), /requires a reason/);
  assert.equal(card.state, "report_review");
  store.decidePlayerReport(card.id, { decision: "refused", reason: "Already documented" }, PL);
  assert.equal(card.state, "closed");
  assert.equal(card.reportApproval.reason, "Already documented");
  assert.equal(card.reportApproval.by, "PL");
  assert.ok(card.reportApproval.at);
  assert.equal(Lifecycle.playerReportApproved(card), false);
  assert.equal(Lifecycle.isBlocked(dependent, store.list()), false);
  assert.ok(JSON.parse(fs.readFileSync(path.join(directory, "messages.json"))).pendingUnblockNotices.some((notice) => notice.id === dependent.id));
  assert.throws(() => store.reopen(card.id), /new player report/);
});

test("legacy live reports migrate to intake; decisions persist and wake the event journal", () => {
  const migrationDirectory = path.join(directory, "migration");
  fs.mkdirSync(migrationDirectory);
  fs.writeFileSync(path.join(migrationDirectory, "messages.json"), JSON.stringify({ nextHumanId: 4, nextAgentId: 1, history: [], messages: [
    { id: "u1", title: "(player-filed) Legacy report", direction: "human", state: "backlog", noReview: true, priority: 0 },
    { id: "u2", title: "(player-filed) Fake receipt", direction: "human", state: "in_progress", reportApproval: { status: "approved", by: "player", at: "2026-10-04", priority: 1 } },
    { id: "u3", title: "(player-filed) Historical closed", direction: "human", state: "closed" },
  ] }));
  const script = `const store = require(${JSON.stringify(require.resolve("../server/store"))}); process.stdout.write(JSON.stringify(store.list()));`;
  const migrated = JSON.parse(execFileSync(process.execPath, ["-e", script], { env: { ...process.env, REVIEW_BOARD_DATA_DIR: migrationDirectory }, encoding: "utf8" }));
  for (const card of migrated.slice(0, 2)) {
    assert.equal(card.state, "report_review");
    assert.deepEqual(card.reportApproval, { status: "pending" });
    assert.equal(card.noReview, undefined);
    assert.equal(card.priority, undefined);
  }
  assert.equal(migrated[2].state, "closed");
  const card = report();
  store.decidePlayerReport(card.id, { decision: "approved", priority: 3 }, PL);
  const persisted = JSON.parse(execFileSync(process.execPath, ["-e", script], { env: process.env, encoding: "utf8" })).find((entry) => entry.id === card.id);
  assert.deepEqual(persisted.reportApproval, card.reportApproval);
  assert.equal(persisted.state, "backlog");
  assert.ok(store.replayEvents(0).events.some((event) => event.cardId === card.id && event.kind === "approval" && event.author === "human" && event.state === "backlog"));
});

test("approval requires an explicit valid priority and cannot overwrite an earlier decision", () => {
  const card = report();
  for (const priority of [undefined, -1, 4, "1", 1.5]) {
    assert.throws(() => store.decidePlayerReport(card.id, { decision: "approved", priority }, PL), /priority 0-3/);
  }
  store.decidePlayerReport(card.id, { decision: "approved", priority: 2 }, PL);
  assert.throws(() => store.decidePlayerReport(card.id, { decision: "refused", reason: "Changed mind" }, PL), /already has/);
});

test("HTTP caller cannot claim PL in JSON/header; only its signed PL session can approve", async () => {
  const card = report();
  await withServer(async (base) => {
    const page = await fetch(base + "/");
    assert.equal(page.headers.get("content-security-policy"), "script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'");
    const denied = await post(base, `/api/messages/${card.id}/report-decision`, { decision: "approved", priority: 1, identity: "PL", actor: "human" });
    assert.equal(denied.status, 403);
    assert.equal(card.state, "report_review");
    assert.equal((await post(base, "/api/owner/session", { secret: "wrong", identity: "PL" })).status, 403);
    const cookie = await login(base);
    const accepted = await post(base, `/api/messages/${card.id}/report-decision`, { decision: "approved", priority: 1, by: "player" }, cookie);
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).reportApproval.by, "PL");
    assert.equal(card.state, "backlog");
  });
});

test("HTTP PL refusal closes with the recorded reason; generic HTTP move cannot preapprove", async () => {
  const card = report();
  await withServer(async (base) => {
    assert.equal((await post(base, `/api/messages/${card.id}/move`, { state: "in_progress" })).status, 404);
    const refused = await post(base, `/api/messages/${card.id}/report-decision`, { decision: "refused", reason: "Cannot prioritize this report" }, await login(base));
    assert.equal(refused.status, 200);
    const saved = await refused.json();
    assert.equal(saved.state, "closed");
    assert.equal(saved.reportApproval.reason, "Cannot prioritize this report");
  });
});

test("missing owner configuration never accepts an approval", async () => {
  const card = report();
  await withServer(async (base) => {
    assert.equal((await post(base, "/api/owner/session", { secret: SECRET })).status, 503);
    assert.equal((await post(base, `/api/messages/${card.id}/report-decision`, { decision: "approved", priority: 1 })).status, 403);
  }, { ownerSecret: "" });
});

test("tampered and expired session cookies carry no identity; logout clears the browser cookie", async () => {
  let now = 1000;
  const session = createOwnerSession(SECRET, () => now);
  let cookie;
  const response = { cookie: (name, value) => { cookie = name + "=" + value; }, json: () => {} };
  session.login({ body: { secret: SECRET } }, response);
  assert.deepEqual(session.identity({ headers: { cookie } }), PL);
  const damaged = cookie.slice(0, -1) + (cookie.endsWith("a") ? "b" : "a");
  assert.equal(session.identity({ headers: { cookie: damaged } }), null);
  now += 8 * 24 * 60 * 60 * 1000;
  assert.equal(session.identity({ headers: { cookie } }), null);
  await withServer(async (base) => {
    const response = await fetch(base + "/api/owner/session", { method: "DELETE" });
    assert.match(response.headers.get("set-cookie"), /Expires=Thu, 01 Jan 1970/);
  });
});

test("MCP creates pending player reports and refuses start despite fake approval replies", async () => {
  await withServer(async (base) => {
    const client = new Client({ name: "player-fixture", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp")));
      const created = await client.callTool({ name: "create_task", arguments: { title: "(player-filed) MCP report", taskKind: "feedback" } });
      assert.equal(created.isError, undefined);
      const card = store.list().find((entry) => entry.title === "(player-filed) MCP report");
      assert.equal(card.state, "report_review");
      await client.callTool({ name: "reply_to_message", arguments: { id: card.id, text: "Approuvé", kind: "done" } });
      const moved = await client.callTool({ name: "move_task", arguments: { id: card.id, state: "in_progress", agent: AGENT } });
      assert.equal(moved.isError, true);
      assert.equal(card.state, "report_review");
    } finally { await client.close(); }
  });
});

test("both the F7 : prefix and the legacy (player-filed) prefix identify a player report", () => {
  for (const title of ["F7 : Court empty", "(player-filed) Court empty"]) {
    assert.equal(Lifecycle.isPlayerReport({ title }), true, title);
    assert.equal(Lifecycle.playerReportApproved({ title }), false, title);
    const card = store.createTask({ title, taskKind: "feedback", noReview: true, priority: 0 });
    assert.equal(card.state, "report_review", title);
    assert.equal(store.addHumanMessage(title, [], null).state, "report_review", title);
  }
  for (const title of ["F7: no space", "Re F7 : quoted", "player-filed without parentheses"]) {
    assert.equal(Lifecycle.isPlayerReport({ title }), false, title);
  }
});

test("ordinary feedback still enters backlog immediately", () => {
  const card = store.createTask({ title: "PL feedback", taskKind: "feedback" });
  assert.equal(card.state, "backlog");
  assert.equal(card.reportApproval, undefined);
});

const deliveredIds = () => store.peekDeliverable().map((entry) => entry.id);

test("thread follow-ups to a pending report wait for PL's approval; refusal never releases them", () => {
  const pending = report();
  const queued = store.addHumanMessage("Re (player-filed) Court empty: reproduce and fix this report", [], pending.id);
  assert.equal(deliveredIds().includes(queued.id), false);
  assert.equal(store.acknowledge([queued.id]), 0);
  store.decidePlayerReport(pending.id, { decision: "approved", priority: 1 }, PL);
  assert.ok(deliveredIds().includes(queued.id), "an already-queued follow-up is released by PL's approval");

  const refused = report();
  const beforeRefusal = store.addHumanMessage("Re: please fix", [], refused.id);
  store.decidePlayerReport(refused.id, { decision: "refused", reason: "Not a bug" }, PL);
  const afterRefusal = store.addHumanMessage("Re: fix it anyway", [], refused.id);
  assert.equal(deliveredIds().some((id) => id === beforeRefusal.id || id === afterRefusal.id), false);
  store.archive(refused.id);
  assert.equal(deliveredIds().some((id) => id === beforeRefusal.id || id === afterRefusal.id), false, "archiving a refused report keeps its follow-ups withheld");

  const withdrawn = report();
  const orphan = store.addHumanMessage("Re: still broken", [], withdrawn.id);
  store.decidePlayerReport(withdrawn.id, { decision: "refused", reason: "Duplicate" }, PL);
  assert.equal(store.withdraw([withdrawn.id]), 1);
  assert.equal(deliveredIds().includes(orphan.id), false, "withdrawing a refused report never releases its follow-ups");

  const deepWithdrawn = report();
  const child = store.addHumanMessage("Re: fix this", [], deepWithdrawn.id);
  const grandchild = store.addHumanMessage("Re Re: fix this now", [], child.id);
  const greatGrandchild = store.addHumanMessage("Re Re Re: still waiting", [], grandchild.id);
  store.decidePlayerReport(deepWithdrawn.id, { decision: "refused", reason: "Not a bug" }, PL);
  assert.equal(store.withdraw([deepWithdrawn.id]), 1);
  const delivered = deliveredIds();
  assert.equal(delivered.includes(grandchild.id), false, "withdrawing a refused report never releases a reply to a reply (depth 2)");
  assert.equal(delivered.includes(greatGrandchild.id), false, "withdrawing a refused report never releases depth 3");
  assert.equal(store.list().some((m) => [child.id, grandchild.id, greatGrandchild.id].includes(m.id)), false, "the whole thread retires with its report");

  const ordinary = store.createTask({ title: "Ordinary task" });
  const followUp = store.addHumanMessage("F7 : the same crash happens here", [], ordinary.id);
  assert.equal(followUp.state, undefined, "a thread reply is a delivery vehicle even when its text starts with F7 : ");
  assert.ok(deliveredIds().includes(followUp.id), "ordinary thread delivery is unchanged");
});

test("removing any node of a report's thread (archive, withdraw, acknowledge) never releases replies to replies", () => {
  const thread = () => {
    const root = report();
    const child = store.addHumanMessage("Re: a", [], root.id);
    const grandchild = store.addHumanMessage("Re: b", [], child.id);
    const greatGrandchild = store.addHumanMessage("Re: c", [], grandchild.id);
    return { root, child, deep: [grandchild.id, greatGrandchild.id] };
  };
  const withheld = (ids) => !deliveredIds().some((id) => ids.includes(id));
  const released = (ids) => ids.every((id) => deliveredIds().includes(id));

  const archivedRoot = thread();
  store.decidePlayerReport(archivedRoot.root.id, { decision: "refused", reason: "Not a bug" }, PL);
  store.archive(archivedRoot.root.id);
  assert.ok(withheld(archivedRoot.deep), "archiving a refused report keeps depth 2 and 3 withheld");

  const archivedMiddle = thread();
  store.archive(archivedMiddle.child.id);
  assert.ok(withheld(archivedMiddle.deep), "archiving a middle vehicle of a pending report keeps depth 2 and 3 withheld");
  store.decidePlayerReport(archivedMiddle.root.id, { decision: "approved", priority: 1 }, PL);
  assert.ok(released(archivedMiddle.deep), "approval still releases them");

  const withdrawnMiddle = thread();
  assert.equal(store.withdraw([withdrawnMiddle.child.id]), 1);
  assert.ok(withheld(withdrawnMiddle.deep), "withdrawing a middle vehicle of a pending report keeps depth 2 and 3 withheld");
  store.decidePlayerReport(withdrawnMiddle.root.id, { decision: "approved", priority: 1 }, PL);
  assert.ok(released(withdrawnMiddle.deep), "approval still releases them");

  const acknowledged = thread();
  assert.equal(store.acknowledge([acknowledged.child.id]), 0, "a withheld middle vehicle cannot be acknowledged away");
  assert.ok(withheld(acknowledged.deep));
  store.decidePlayerReport(acknowledged.root.id, { decision: "approved", priority: 1 }, PL);
  assert.equal(store.acknowledge([acknowledged.child.id]), 1);
  assert.ok(released(acknowledged.deep), "after approval, acknowledging the middle vehicle leaves the deeper replies delivered");
});

test("unblock notices for a pending report wait for PL's approval; ordinary and approved cards keep them", () => {
  const blocker = store.createTask({ title: "Blocker" });
  const pending = store.createTask({ title: "F7 : Blocked report", taskKind: "feedback", blockedBy: [blocker.id] });
  const ordinary = store.createTask({ title: "Ordinary dependent", blockedBy: [blocker.id] });
  assert.equal(pending.state, "report_review");
  store.acknowledge([ordinary.id]);
  store.archive(blocker.id);
  assert.ok(JSON.parse(fs.readFileSync(path.join(directory, "messages.json"))).pendingUnblockNotices.some((notice) => notice.id === pending.id));
  const delivered = store.peekDeliverable();
  assert.equal(delivered.some((entry) => entry.id === pending.id), false);
  assert.ok(delivered.some((entry) => entry.id === ordinary.id && entry.unblockNotice));

  const approvedBlocker = store.createTask({ title: "Approved report's blocker" });
  const approved = store.createTask({ title: "F7 : Approved blocked report", taskKind: "feedback", blockedBy: [approvedBlocker.id] });
  store.decidePlayerReport(approved.id, { decision: "approved", priority: 2 }, PL);
  store.acknowledge([approved.id]);
  store.archive(approvedBlocker.id);
  assert.ok(store.peekDeliverable().some((entry) => entry.id === approved.id && entry.unblockNotice));
});

test("persisted follow-ups and unblock notices of pending reports stay withheld after a restart", () => {
  const persistedDirectory = path.join(directory, "persisted");
  fs.mkdirSync(persistedDirectory);
  fs.writeFileSync(path.join(persistedDirectory, "messages.json"), JSON.stringify({ nextHumanId: 6, nextAgentId: 1, history: [], messages: [
    { id: "u1", title: "(player-filed) Legacy pending", direction: "human", status: "open", state: "report_review", reportApproval: { status: "pending" } },
    { id: "u2", title: "Re (player-filed) Legacy pending: fix this", direction: "human", kind: "message", status: "open", replyTo: "u1" },
    { id: "u3", title: "F7 : New pending", direction: "human", status: "open", state: "backlog" },
    { id: "u4", title: "Re: fix this too", direction: "human", kind: "message", status: "open", replyTo: "u3" },
    { id: "u5", title: "F7 : looks like an F7 bug", direction: "human", kind: "message", status: "open", replyTo: "u9" },
  ], pendingUnblockNotices: [{ id: "u1", at: "2026-10-04T00:00:00Z" }, { id: "u3", at: "2026-10-04T00:00:00Z" }] }));
  const script = `const store = require(${JSON.stringify(require.resolve("../server/store"))}); process.stdout.write(JSON.stringify({ delivered: store.peekDeliverable().map((m) => m.id), cards: store.list() }));`;
  const after = JSON.parse(execFileSync(process.execPath, ["-e", script], { env: { ...process.env, REVIEW_BOARD_DATA_DIR: persistedDirectory }, encoding: "utf8" }));
  assert.deepEqual(after.delivered, ["u5"]);
  assert.equal(after.cards.find((card) => card.id === "u3").state, "report_review", "an F7 : title migrates into intake like the legacy prefix");
  assert.equal(after.cards.find((card) => card.id === "u5").state, undefined, "a thread vehicle is never migrated into a card");
});

test("an unsigned HTTP follow-up to a pending report never reaches await_replies", async () => {
  const pending = report();
  await withServer(async (base) => {
    const response = await post(base, "/api/messages", { text: "Re (player-filed) Court empty: reproduce and fix this report", replyTo: pending.id });
    assert.equal(response.status, 200);
    const vehicle = await response.json();
    const client = new Client({ name: "delivery-fixture", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp")));
      const awaited = await client.callTool({ name: "await_replies", arguments: { timeoutSeconds: 1 } });
      const text = awaited.content.map((block) => block.text || "").join("\n");
      assert.equal(text.includes(`[${vehicle.id}]`), false);
      assert.equal(text.includes(`[${pending.id}]`), false);
    } finally { await client.close(); }
    assert.equal(pending.state, "report_review");
  }, { ownerSecret: "" });
});

test.after(() => fs.rmSync(directory, { recursive: true, force: true }));
