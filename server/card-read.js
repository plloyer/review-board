"use strict";
// A narrow read surface. Operator scope is never supplied by the requesting client.
const CARD_ID = /^[ru][1-9]\d{0,11}$/;
const MAX_READ_BYTES = 32 * 1024;
const MAX_THREAD_ITEMS = 50;

function allowedReadIds(value = process.env.REVIEW_BOARD_TARGETED_READ_IDS || "") {
  if (typeof value !== "string") throw new Error("Invalid targeted-read server scope");
  if (!value.trim()) return new Set(); // Fail closed until the operator sets exact card ids.
  const ids = value.split(",").map(id => id.trim());
  if (ids.some(id => !CARD_ID.test(id))) throw new Error("Invalid targeted-read server scope");
  return new Set(ids);
}

function request(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !["id", "threadLimit"].includes(key)) ||
      typeof value.id !== "string" || !CARD_ID.test(value.id))
    throw new Error("One exact card id required; no search, batch or wildcard");
  const threadLimit = value.threadLimit === undefined ? 20 : value.threadLimit;
  if (!Number.isInteger(threadLimit) || threadLimit < 0 || threadLimit > MAX_THREAD_ITEMS)
    throw new Error("threadLimit must be an integer from 0 to 50");
  return { id: value.id, threadLimit };
}

function pick(value, fields) {
  return Object.fromEntries(fields.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
}

function readMessage(parameters, state, allowedIds = allowedReadIds()) {
  const { id, threadLimit } = request(parameters);
  // Check before lookup: denied requests reveal no card existence, title or related ids.
  if (!(allowedIds instanceof Set) || !allowedIds.has(id)) throw new Error("Targeted read not allowed for this id");
  const card = state.messages.find(entry => entry.id === id) || state.history.find(entry => entry.id === id);
  if (!card) throw new Error("No message for targeted read");
  const result = {
    card: pick(card, ["id", "direction", "kind", "taskKind", "title", "context", "details", "options", "project",
      "status", "state", "createdAt", "archivedAt"]),
    reply: card.reply ? pick(card.reply, ["text", "optionChosen", "decision", "at"]) : null,
    thread: { items: [], total: 0, omittedItems: 0 },
    attachments: "omitted; no file paths or bytes are read",
    nativeAuthorization: "not granted by this read",
  };
  // Only direct human delivery vehicles linked TO the requested card join its inline thread.
  // A requested delivery vehicle never expands into its parent, siblings or blockers.
  const linked = new Map();
  for (const entries of [state.history, state.messages]) {
    for (const entry of entries) {
      if (entry.direction === "human" && entry.replyTo === id && entry.id !== id)
        linked.set(entry.id, { source: "linked_reply", id: entry.id, from: "human", text: entry.title,
          at: entry.createdAt });
    }
  }
  const thread = (card.thread || []).map(entry => ({ source: "card_thread", ...pick(entry, ["from", "text", "kind", "at"]) }));
  thread.push(...linked.values());
  thread.sort((left, right) => String(left.at || "").localeCompare(String(right.at || "")));
  result.thread.total = thread.length;
  result.thread.omittedItems = thread.length;
  const candidates = threadLimit ? thread.slice(-threadLimit) : [];
  // The primary reply/choice/decision is exact or the entire read fails explicitly.
  // Optional older thread entries may be omitted, with an explicit count.
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_READ_BYTES)
    throw new Error("Target card exceeds 32 KiB read limit; decision not returned or truncated");
  for (const item of candidates.reverse()) {
    result.thread.items.unshift(item);
    result.thread.omittedItems = thread.length - result.thread.items.length;
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_READ_BYTES) {
      result.thread.items.shift();
      result.thread.omittedItems = thread.length - result.thread.items.length;
      break;
    }
  }
  result.thread.omittedItems = thread.length - result.thread.items.length;
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_READ_BYTES)
    throw new Error("Target card exceeds 32 KiB read limit; decision not returned or truncated");
  // Detach the response so a caller cannot mutate store state through a read result.
  return JSON.parse(JSON.stringify(result));
}

module.exports = { CARD_ID, MAX_READ_BYTES, MAX_THREAD_ITEMS, allowedReadIds, readMessage };
