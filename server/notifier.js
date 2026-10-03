"use strict";
// Who gets pinged when the board changes, shared by the Electron app (main.js: desktop
// notification + Web Push) and the headless server (headless.js: Web Push only).
const store = require("./store");
const { isActionableThreadEntry, agentAwaitingDecision } = require("../shared/lifecycle");

// notify(title, body, tag) is called once per card that newly awaits the human.
function watchForNotifications(notify) {
  const notifiedIds = new Set();
  let lastThreadNotifiedAt = new Date().toISOString();
  store.events.on("change", () => {
    // Same rule as the badge: only an agent card awaiting his decision (question
    // or review) pings; an FYI note in in_progress stays silent.
    const open = store.list().filter((m) => m.direction === "agent" && m.status === "open" && agentAwaitingDecision(m));
    const openIds = new Set(open.map((m) => m.id));
    for (const id of notifiedIds) if (!openIds.has(id)) notifiedIds.delete(id); // bound memory
    for (const m of open) {
      if (notifiedIds.has(m.id)) continue;
      notifiedIds.add(m.id);
      notify("Review board", m.title, m.id);
    }
    // An AI reply landing under one of the human's issues pings only when it's
    // actually actionable (a question, or work done and awaiting validation).
    for (const m of store.list()) {
      if (m.direction !== "human" || !(m.thread || []).length) continue;
      const last = m.thread[m.thread.length - 1];
      if (isActionableThreadEntry(last) && last.at > lastThreadNotifiedAt) {
        lastThreadNotifiedAt = last.at;
        const title = last.kind === "question" ? "Review board — l'IA a besoin de toi" : "Review board — travail terminé";
        notify(title, String(last.text || "").split("\n")[0], m.id);
      }
    }
  });
}

module.exports = { watchForNotifications };
