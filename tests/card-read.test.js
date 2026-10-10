"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { readMessage, allowedReadIds, MAX_READ_BYTES } = require("../server/card-read");
const time = "2026-10-10T19:00:00.000Z";
const allowed = new Set(["r293"]);
const card = () => ({ id: "r293", direction: "agent", kind: "question", title: "One scoped question?",
  context: "Choice applies to this card only", options: ["A", "B"], status: "answered", state: "in_progress",
  createdAt: time, reply: { text: "Oui, exactement.\nSans autre carte.", optionChosen: "A", decision: null, at: time,
    images: [{ path: "private-attachment-do-not-return.png" }] },
  images: [{ path: "private-source-do-not-read.png" }], unknownSecret: "do-not-return", thread: [] });

test("exact reply survives unchanged and only the selected card/direct human replies are projected", () => {
  const target = card();
  target.thread = [{ from: "agent", kind: "update", text: "target-thread", at: time }];
  const unrelated = { id: "r294", direction: "agent", replyTo: null,
    get title() { throw new Error("unrelated content read"); }, get thread() { throw new Error("unrelated thread read"); } };
  const state = { messages: [target, unrelated,
    { id: "u1", direction: "human", replyTo: "r293", title: "direct human answer", createdAt: time },
    { id: "u2", direction: "agent", replyTo: "r293", title: "wrong-direction-secret", createdAt: time },
    { id: "u3", direction: "human", replyTo: "r294", title: "other-card-secret", createdAt: time }], history: [
    { id: "u4", direction: "human", replyTo: "r293", title: "archived direct answer", createdAt: time }] };
  const result = readMessage({ id: "r293" }, state, allowed);
  assert.deepEqual(result.reply, { text: target.reply.text, optionChosen: "A", decision: null, at: time });
  assert.deepEqual(result.thread.items.map(item => item.text), ["target-thread", "archived direct answer", "direct human answer"]);
  assert.equal(result.thread.omittedItems, 0);
  assert.doesNotMatch(JSON.stringify(result), /r294|other-card|wrong-direction|private-|do-not-return/);
  result.card.options.push("changed");
  result.reply.text = "changed";
  assert.deepEqual(target.options, ["A", "B"]);
  assert.notEqual(target.reply.text, "changed");
});

test("deny by default and server scope cannot be supplied by the caller or reveal existence", () => {
  assert.equal(allowedReadIds("").size, 0);
  assert.deepEqual([...allowedReadIds(" r293, u1 ")], ["r293", "u1"]);
  for (const bad of ["*", "r*", "r293,*", "r293,", "../r293", "r293 u1"])
    assert.throws(() => allowedReadIds(bad), /Invalid targeted-read server scope/);
  const state = { get messages() { throw new Error("lookup before access check"); } };
  for (const id of ["r293", "r999"])
    assert.throws(() => readMessage({ id }, state, new Set()), /^Error: Targeted read not allowed for this id$/);
  for (const input of [{ id: "r293", allowedIds: ["r293"] }, { id: "r293", includeAll: true },
    { id: "r293", project: "other" }, { id: "r293", nativeAuthorization: true }])
    assert.throws(() => readMessage(input, {}, allowed), /One exact card id/);
});

test("strict ids and thread limits reject batches, coercion, wildcards, paths and invalid limits", () => {
  for (const id of [undefined, ["r293"], ["r293", "r294"], "r", "r0", "r293*", " r293", "r293/r294",
    "r293\n", "r1234567890123", "R293", 293])
    assert.throws(() => readMessage({ id }, {}, allowed), /One exact card id/);
  for (const threadLimit of [-1, 51, 1.5, "2", NaN, Infinity])
    assert.throws(() => readMessage({ id: "r293", threadLimit }, {}, allowed), /threadLimit/);
});

test("archived roots are readable but a delivery vehicle never expands to its parent or siblings", () => {
  const parent = card();
  const reply = { id: "u1", direction: "human", replyTo: "r293", title: "one exact delivery", createdAt: time };
  const state = { messages: [parent, { id: "u2", direction: "human", replyTo: "r293", title: "sibling-secret" }],
    history: [reply, { id: "r5", title: "archived root", status: "answered", reply: { text: "Exact", decision: "approved", at: time } }] };
  const result = readMessage({ id: "u1" }, state, new Set(["u1"]));
  assert.equal(result.card.title, "one exact delivery");
  assert.equal(result.thread.total, 0);
  assert.doesNotMatch(JSON.stringify(result), /r293|sibling-secret|scoped question/);
  assert.equal(readMessage({ id: "r5" }, state, new Set(["r5"])).reply.decision, "approved");
  assert.throws(() => readMessage({ id: "r999" }, state, new Set(["r999"])), /No message for targeted read/);
});

test("bounded latest thread reports omissions while keeping the primary reply exact, including zero limit", () => {
  const target = card();
  target.thread = Array.from({ length: 100 }, (_, index) => ({ from: "human", text: "answer-" + index,
    at: new Date(Date.parse(time) + index * 1000).toISOString() }));
  const state = { messages: [target], history: [] };
  const result = readMessage({ id: "r293", threadLimit: 3 }, state, allowed);
  assert.deepEqual(result.thread.items.map(item => item.text), ["answer-97", "answer-98", "answer-99"]);
  assert.equal(result.thread.omittedItems, 97);
  assert.equal(result.reply.text, target.reply.text);
  const minimal = readMessage({ id: "r293", threadLimit: 0 }, state, allowed);
  assert.equal(minimal.thread.items.length, 0);
  assert.equal(minimal.thread.omittedItems, 100);
  assert.equal(minimal.reply.text, target.reply.text);
});

test("UTF8 bytes are bounded; oversized optional text is omitted, oversized decisions fail explicitly", () => {
  const target = card();
  target.thread = [{ from: "human", text: "é".repeat(MAX_READ_BYTES), at: time }];
  const state = { messages: [target], history: [] };
  const result = readMessage({ id: "r293" }, state, allowed);
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= MAX_READ_BYTES);
  assert.equal(result.thread.omittedItems, 1);
  assert.equal(result.reply.text, target.reply.text);
  for (const decision of ["approved", "rejected", null]) {
    target.reply = { text: "é".repeat(MAX_READ_BYTES), decision, at: time };
    assert.throws(() => readMessage({ id: "r293" }, state, allowed), /decision not returned or truncated/);
  }
});
