"use strict";
// Observations and owner consent are evidence, never native permission grants.
const { createHash } = require("crypto");

function text(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} required`);
  return value;
}
function timestamp(value) {
  text(value, "timestamp");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value)))
    throw new Error("timestamp must include a timezone");
  return value;
}
function fields(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error("unknown execution field");
}
function normalizeAction(value) {
  const names = ["operation", "command", "cwd", "destination", "targetRef", "version", "threadId", "effects"];
  fields(value, names);
  const action = {};
  for (const name of names.filter(name => name !== "effects")) action[name] = text(value[name], name);
  if (!Array.isArray(value.effects) || value.effects.some(effect => typeof effect !== "string" || !effect.trim()))
    throw new Error("effects must be an explicit list");
  action.effects = [...value.effects];
  return action;
}
function actionId(action) {
  return createHash("sha256").update(JSON.stringify(normalizeAction(action))).digest("hex");
}
function normalizeEvent(value) {
  const common = ["id", "type", "actionId", "at", "source"];
  const extra = {
    observed: ["action", "runtime"],
    denied: ["after", "before", "reason", "reasonSource", "provenance", "nativeReviewId", "attemptId"],
    consent: ["decision", "boardReceipt"],
    attempt: ["attemptId"],
    publication: ["attemptId", "receipt", "origin", "actor"],
    activation: ["publicationEventId", "receipt", "origin", "actor"],
  };
  if (!value || !extra[value.type]) throw new Error("unknown execution event type");
  fields(value, [...common, ...extra[value.type]]);
  const event = { id: text(value.id, "event id"), type: value.type, actionId: text(value.actionId, "actionId"),
    at: timestamp(value.at), source: text(value.source, "source") };
  if (value.type === "observed") {
    event.action = normalizeAction(value.action);
    if (actionId(event.action) !== event.actionId) throw new Error("action digest mismatch");
    // Effective runtime evidence is separate from action authorization; no inferred Full Access.
    if (value.runtime !== undefined) {
      fields(value.runtime, ["sandboxMode", "approvalsReviewer", "network", "source"]);
      event.runtime = Object.fromEntries(Object.entries(value.runtime).map(([key, entry]) => [key, text(entry, key)]));
    }
  } else if (value.type === "denied") {
    event.after = timestamp(value.after || value.at);
    event.before = timestamp(value.before || value.at);
    if (Date.parse(event.after) > Date.parse(event.before)) throw new Error("invalid denial interval");
    event.reason = value.reason === null ? null : text(value.reason, "reason (or null if unavailable)");
    event.reasonSource = text(value.reasonSource, "reasonSource");
    event.provenance = text(value.provenance, "provenance (use unknown when unavailable)");
    event.nativeReviewId = value.nativeReviewId === null ? null : text(value.nativeReviewId, "nativeReviewId (or null)");
    event.attemptId = value.attemptId === null ? null : text(value.attemptId, "attemptId (or null)");
  } else if (value.type === "consent") {
    if (!["approved", "rejected"].includes(value.decision)) throw new Error("invalid consent decision");
    event.decision = value.decision;
    event.boardReceipt = text(value.boardReceipt, "boardReceipt");
  } else if (value.type === "attempt" || value.type === "publication") {
    event.attemptId = value.type === "publication" && value.origin === "external_observation" && value.attemptId === null
      ? null : text(value.attemptId, "attemptId");
    if (value.type === "publication") event.receipt = text(value.receipt, "publication receipt");
  } else if (value.type === "activation") {
    event.publicationEventId = text(value.publicationEventId, "publicationEventId");
    event.receipt = text(value.receipt, "activation receipt");
  }
  if (value.type === "publication" || value.type === "activation") {
    event.origin = value.origin || "owning_attempt";
    if (!["owning_attempt", "external_observation"].includes(event.origin)) throw new Error("invalid execution origin");
    event.actor = value.actor == null ? null : text(value.actor, "actor");
    if (value.type === "publication" && event.origin === "external_observation" && event.attemptId !== null)
      throw new Error("external observation cannot claim an owning attempt");
  }
  return event;
}

function append(trace, value) {
  const event = normalizeEvent(value);
  const result = structuredClone(trace || { schema: 1, currentActionId: null, events: [] });
  const previous = result.events.find(entry => entry.id === event.id);
  if (previous) {
    if (JSON.stringify(previous) !== JSON.stringify(event)) throw new Error("event id reused with different evidence");
    return { trace: result, changed: false };
  }
  const observation = result.events.find(entry => entry.type === "observed" && entry.actionId === event.actionId);
  if (event.type === "observed") {
    // A digest cannot be reselected to resurrect its old vote or one-shot grant.
    if (observation) throw new Error("action already observed; replay its original event id or use a new card");
    result.currentActionId = event.actionId;
  } else {
    if (!observation) throw new Error("action has not been observed");
    if (event.actionId !== result.currentActionId) throw new Error("action superseded; evidence belongs on its owning card");
    if (event.type === "attempt" && result.events.some(entry => entry.type === "denied" && entry.actionId === event.actionId))
      throw new Error("retry blocked: native approval adapter unavailable");
    const attempts = result.events.filter(entry => entry.type === "attempt" && entry.actionId === event.actionId);
    if (event.type === "attempt" && attempts.some(entry => entry.attemptId === event.attemptId))
      throw new Error("attempt already recorded");
    if (event.type === "publication") {
      const attempt = attempts.find(entry => entry.attemptId === event.attemptId);
      if (event.origin === "owning_attempt" && (!attempt || Date.parse(attempt.at) > Date.parse(event.at))) throw new Error("publication requires its preceding attempt");
      if (event.origin === "owning_attempt" && result.events.some(entry => entry.type === "denied" && entry.actionId === event.actionId &&
        (entry.attemptId === event.attemptId || (entry.attemptId === null && Date.parse(entry.after) <= Date.parse(event.at)))))
        throw new Error("denied attempt cannot prove publication");
      if (result.events.some(entry => entry.type === "publication" && entry.actionId === event.actionId))
        throw new Error("publication already recorded");
    }
    if (event.type === "denied" && result.events.some(entry => entry.type === "publication" && entry.origin === "owning_attempt" && entry.actionId === event.actionId &&
      (entry.attemptId === event.attemptId || (event.attemptId === null && Date.parse(event.after) <= Date.parse(entry.at)))))
      throw new Error("denial conflicts with publication evidence; reconcile on the owning card");
    if (event.type === "activation") {
      const publication = result.events.find(entry => entry.id === event.publicationEventId && entry.type === "publication" && entry.actionId === event.actionId);
      if (!publication || Date.parse(publication.at) > Date.parse(event.at)) throw new Error("activation requires preceding publication evidence");
      if (result.events.some(entry => entry.type === "activation" && entry.actionId === event.actionId))
        throw new Error("activation already recorded");
    }
  }
  result.events.push(event);
  return { trace: result, changed: true };
}

function project(trace) {
  if (!trace) return null;
  const events = trace.events.filter(event => event.actionId === trace.currentActionId);
  const latest = type => events.filter(event => event.type === type).sort((left, right) => Date.parse(left.at) - Date.parse(right.at)).at(-1) || null;
  const denied = latest("denied"), consent = latest("consent"), publication = latest("publication"), activation = latest("activation");
  let chronology = "no_vote_or_denial";
  if (denied && consent) chronology = Date.parse(consent.at) > Date.parse(denied.before) ? "vote_after_denial"
    : Date.parse(consent.at) < Date.parse(denied.after) ? "vote_before_denial" : "order_unproven";
  const reasons = [];
  if (!consent || consent.decision !== "approved") reasons.push("owner_consent_missing");
  if (!denied) reasons.push("denial_missing");
  if (denied && !denied.nativeReviewId) reasons.push("native_denial_id_missing");
  reasons.push("supported_native_adapter_unavailable");
  if (publication) reasons.push("already_published");
  return { actionId: trace.currentActionId, action: latest("observed").action, runtime: latest("observed").runtime || null,
    denied, consent, chronology, publication, activation,
    attemptsAfterDenial: denied ? events.filter(event => event.type === "attempt" && Date.parse(event.at) > Date.parse(denied.before)).length : 0,
    nativeAuthorization: "unavailable", recovery: { executable: false, reasons,
      humanStep: "Request product support for a trusted board-to-native approval surface in the owning task; no new vote or session change is required by this board." } };
}

module.exports = { actionId, append, project };
