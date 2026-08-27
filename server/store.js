"use strict";
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");

// ponytail: flat JSON file + in-memory array, single local user, no DB needed.
const DATA_DIR = path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "messages.json");

function load() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return { nextAgentId: 1, nextHumanId: 1, messages: [] };
  }
}

function save(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
}

const state = load();
const events = new EventEmitter();

function emitChange() {
  events.emit("change");
}

function addAgentMessage({ title, kind = "review", options, context, details, images, project }) {
  const id = `r${state.nextAgentId++}`;
  const msg = {
    id,
    direction: "agent",
    kind,
    title,
    options: options || [],
    context: context || "",
    details: details || [],
    images: images || [],
    project: project || "",
    status: "open",
    createdAt: new Date().toISOString(),
    reply: null,
  };
  state.messages.push(msg);
  save(state);
  emitChange();
  return msg;
}

function addHumanMessage(text) {
  const id = `u${state.nextHumanId++}`;
  const msg = {
    id,
    direction: "human",
    kind: "message",
    title: text,
    status: "open",
    createdAt: new Date().toISOString(),
  };
  state.messages.push(msg);
  save(state);
  emitChange();
  return msg;
}

function reply(id, { text, optionChosen }) {
  const msg = state.messages.find((m) => m.id === id);
  if (!msg) throw new Error(`No message ${id}`);
  msg.status = "answered";
  msg.reply = { text: text || "", optionChosen: optionChosen || null, at: new Date().toISOString() };
  save(state);
  emitChange();
  return msg;
}

function list() {
  return state.messages;
}

// Everything "delivered" to the agent (answered agent-messages + unread human-messages)
// leaves the queue for good, per the agent-messenger contract this mirrors.
function drainDelivered() {
  const delivered = state.messages.filter(
    (m) => (m.direction === "agent" && m.status === "answered") || (m.direction === "human" && m.status === "open")
  );
  if (delivered.length === 0) return [];
  const ids = new Set(delivered.map((m) => m.id));
  state.messages = state.messages.filter((m) => !ids.has(m.id));
  save(state);
  emitChange();
  return delivered;
}

function withdraw(ids) {
  const idSet = new Set(ids);
  const before = state.messages.length;
  state.messages = state.messages.filter((m) => !idSet.has(m.id));
  save(state);
  emitChange();
  return before - state.messages.length;
}

module.exports = { addAgentMessage, addHumanMessage, reply, list, drainDelivered, withdraw, events };
