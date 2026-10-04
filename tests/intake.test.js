"use strict";
// The public bug-report intake (server/intake.js) against an ephemeral port and a temp data dir.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-board-intake-test-"));
process.env.REVIEW_BOARD_DATA_DIR = dir;
process.env.REVIEW_BOARD_NO_SUMMARY = "1";
const home = fs.mkdtempSync(path.join(os.tmpdir(), "review-board-intake-home-"));
process.env.USERPROFILE = home;
process.env.HOME = home;

const { createIntakeApp } = require("../server/intake");
const store = require("../server/store");

const KEY = "k".repeat(40);
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const MARKER = "[three-crowns-report:3f2a-intake]";

async function withIntake(fn, options = {}) {
  const app = createIntakeApp({ key: KEY, privateUrl: "http://crowns:5677", ...options });
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { await new Promise((resolve) => server.close(resolve)); }
}

const post = (base, route, body, key = KEY) => fetch(base + route, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(key === null ? {} : { "X-Intake-Key": key }) },
  body: typeof body === "string" ? body : JSON.stringify(body),
});
const get = (base, route, key = KEY) => fetch(base + route, { headers: key === null ? {} : { "X-Intake-Key": key } });
const createCall = (context, title = "(player-filed) The siege never ends") => ({
  jsonrpc: "2.0", id: 1, method: "tools/call",
  params: { name: "create_task", arguments: { title, taskKind: "feedback", context, project: "Three Crowns · player report" } },
});

test("a missing or wrong key is refused before anything else", async () => {
  await withIntake(async (base) => {
    assert.equal((await post(base, "/mcp", createCall(MARKER), null)).status, 401);
    assert.equal((await post(base, "/mcp", createCall(MARKER), "x".repeat(40))).status, 401);
    assert.equal((await get(base, "/api/reviews?marker=" + encodeURIComponent(MARKER), null)).status, 401);
    assert.equal((await post(base, "/api/upload", { dataUrl: PNG, filename: "s.png" }, "short")).status, 401);
    assert.equal(store.list().filter((card) => card.context.includes(MARKER)).length, 0);
  });
});

test("no board route other than the intake is reachable", async () => {
  store.createTask({ title: "private card", context: "secret plans" });
  await withIntake(async (base) => {
    for (const route of ["/", "/index.html", "/api/events", "/api/event-journal?after=0", "/api/file?path=x",
      "/api/image?path=x", "/api/build-id", "/api/push-public-key", "/shared/views.js"])
      assert.equal((await get(base, route)).status, 404, route);
    for (const route of ["/api/messages", "/api/messages/u1/move", "/api/reviews/u1/reply", "/api/push-subscribe", "/mcp-live"])
      assert.equal((await post(base, route, { state: "closed", text: "x" })).status, 404, route);
    // The card lists answer only a marker lookup, never the board's cards.
    assert.equal((await get(base, "/api/reviews")).status, 400);
    assert.equal((await get(base, "/api/history?marker=secret")).status, 400);
    const other = await post(base, "/mcp", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "move_task", arguments: { id: "u1", state: "closed" } } });
    assert.equal((await other.json()).error.code, -32601);
    const listing = await post(base, "/mcp", { jsonrpc: "2.0", id: 3, method: "tools/list" });
    assert.equal((await listing.json()).error.code, -32601);
  });
});

test("an oversized body is refused with 413", async () => {
  await withIntake(async (base) => {
    const big = { dataUrl: "data:image/png;base64," + "A".repeat(4096), filename: "big.png" };
    assert.equal((await post(base, "/api/upload", big)).status, 413);
  }, { maxBodyBytes: 1024 });
});

test("each source is rate-limited", async () => {
  let clock = 0;
  await withIntake(async (base) => {
    const lookup = "/api/reviews?marker=" + encodeURIComponent(MARKER);
    for (let i = 0; i < 3; i++) assert.equal((await get(base, lookup)).status, 200);
    const limited = await get(base, lookup);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
    // Another client behind the funnel proxy has its own budget.
    assert.equal((await fetch(base + lookup, { headers: { "X-Intake-Key": KEY, "X-Forwarded-For": "203.0.113.9" } })).status, 200);
    clock = 60001;
    assert.equal((await get(base, lookup)).status, 200);
  }, { rateLimit: { max: 3, windowMs: 60000 }, now: () => clock });
});

test("a report uploads its files, files one player card, and is found again by its marker only", async () => {
  await withIntake(async (base) => {
    const screenshot = await (await post(base, "/api/upload", { dataUrl: PNG, filename: "screenshot.png" })).json();
    assert.ok(fs.existsSync(screenshot.path));
    const save = await (await post(base, "/api/upload", {
      dataUrl: "data:application/octet-stream;base64," + Buffer.from("save").toString("base64"), filename: "campaign.tc" })).json();
    assert.match(save.downloadUrl, /^http:\/\/crowns:5677\/api\/file\?path=/, "the save opens on the private board");
    assert.equal((await post(base, "/api/upload", { dataUrl: "data:video/mp4;base64,AAAA", filename: "v.mp4" })).status, 400);

    const context = `${MARKER}\n> The siege never ends`;
    const created = await (await post(base, "/mcp", createCall(context))).json();
    const id = created.result.content[0].text;
    const card = store.list().find((c) => c.id === id);
    assert.equal(card.taskKind, "feedback");
    assert.equal(card.project, "Three Crowns · player report");
    assert.equal(card.state, "backlog");
    assert.ok(!card.noReview, "a player card waits for the human's approval");
    assert.ok(card.title.startsWith("(player-filed) "));

    // A resend answers the same card instead of a duplicate.
    const again = await (await post(base, "/mcp", createCall(context))).json();
    assert.equal(again.result.content[0].text, id);
    assert.equal(store.list().filter((c) => c.context.includes(MARKER)).length, 1);

    const found = await (await get(base, "/api/reviews?marker=" + encodeURIComponent(MARKER))).json();
    assert.deepEqual(found, [{ id, context: MARKER }]);
    assert.deepEqual(await (await get(base, "/api/history?marker=" + encodeURIComponent(MARKER))).json(), []);
    const missing = await (await get(base, "/api/reviews?marker=" + encodeURIComponent("[three-crowns-report:none]"))).json();
    assert.deepEqual(missing, []);

    const unmarked = await (await post(base, "/mcp", createCall("no marker here"))).json();
    assert.equal(unmarked.error.code, -32602);
    const untitled = await (await post(base, "/mcp", createCall(`[three-crowns-report:other] x`, "Crash"))).json();
    assert.ok(store.list().find((c) => c.id === untitled.result.content[0].text).title.startsWith("(player-filed) Crash"));
  });
});

test("the intake refuses to start without a real key or a private board root", () => {
  assert.throws(() => createIntakeApp({ key: "short", privateUrl: "http://crowns:5677" }));
  assert.throws(() => createIntakeApp({ key: KEY, privateUrl: "http://crowns:5677/mcp" }));
});
