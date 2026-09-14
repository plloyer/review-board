"use strict";
// Pure view-model layer: for each render surface (compactCard, card, sentCard,
// overlay), a derive*View(msg) function computes every msg-dependent value the
// matching paint function in app.js needs — plain, JSON-serializable objects
// (mostly pre-rendered HTML fragments, since that's what the paint half injects
// verbatim). JSON.stringify(derive(msg)) IS the change-detection signature now
// (replaces the old hand-maintained compactSig/cardSig/sentSig/overlaySig).
//
// Dependency-free apart from `marked` (a global, loaded by marked.min.js in the
// browser; tests stub `global.marked`) — no fs/DOM, so this loads unmodified in
// Node (tests/views.test.js) and in the browser (index.html, before app.js).
// Depends on window.Lifecycle/global Lifecycle for the card-lifecycle predicates.

// Wrapped in an IIFE: this file, shared/lifecycle.js and app.js all load as
// plain (non-module) <script> tags sharing ONE global let/const scope in the
// browser — an unwrapped top-level const/function name here would collide with
// the same name declared by another of those files (a real SyntaxError that
// silently kills every script on the page, seen when app.js's own top-level
// `const { unseenActionable, ... }` collided with this file's). The IIFE keeps
// everything but the final window.Views assignment private to this file.
(function () {
const LocalLifecycle = typeof module !== "undefined" ? require("../shared/lifecycle") : window.Lifecycle;
const { dotColor, lastThreadEntry, isActionableThreadEntry, unseenActionable, agentAwaitingDecision, awaitingAgent, STATE_LABEL } = LocalLifecycle;

function imgSrc(p) {
  return `/api/image?path=${encodeURIComponent(p)}`;
}

// Escapes user/agent text interpolated into innerHTML that isn't already
// markdown-rendered (marked.parse escapes on its own).
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// ponytail: real DOM textContent would strip tags perfectly, but this file also
// has to run in Node (no DOM) — marked's own output is simple enough (p/br/ul-li/
// strong/em/a/code) that a regex strip + entity-decode matches it byte for byte
// in practice. Upgrade to a real HTML parser if marked output ever gets hairier.
const HTML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };
function stripTags(html) {
  return html.replace(/<[^>]*>/g, "").replace(/&(#39|amp|lt|gt|quot|apos|nbsp);/g, (_, e) => HTML_ENTITIES[e]);
}

// Renders markdown to HTML then strips it back to plain text — strips `**`/`#`/
// `[text](url)`/etc noise instead of just taking the raw first line, which used
// to let markdown syntax leak into compact surfaces.
function mdToPlainText(s) {
  return stripTags(marked.parse(String(s ?? ""), { breaks: true })).replace(/\s+/g, " ").trim();
}

// Shared cap for any body text shown in compact mode (subline, inline question
// context): plain text, no markdown, max 200 chars. Escaped for interpolation.
function compactSnippet(s) {
  return esc(mdToPlainText(s).slice(0, 200));
}

// A title can start with a "[Tag] " prefix meant to render as a small source
// chip rather than literal text — the raw title/summary in the message data
// is never touched, only the rendered HTML splits it.
const SOURCE_TAG_RE = /^\[([^\]]{1,16})\]\s*/;
function splitSourceTag(title) {
  const s = String(title ?? "");
  const m = s.match(SOURCE_TAG_RE);
  return m ? { tag: m[1], rest: s.slice(m[0].length) } : { tag: null, rest: s };
}
// Compact source marker: "3C-host" -> "host" — a dim word before the title,
// not a boxed chip (PL: the chips ate half the card for little information).
function sourceChipHTML(tag) {
  if (!tag) return "";
  const short = tag.replace(/^3C-/i, "").toLowerCase();
  return `<span class="source-tag">${esc(short)}</span>`;
}

// Shared by card() and the overlay's agent body: a detail line renders as a list
// item unless it's block-level markdown (headings/lists/multiple paragraphs), in
// which case it gets its own block instead of being crammed into a bullet.
function renderDetail(d) {
  const html = marked.parse(d, { breaks: true });
  const paraCount = (html.match(/<p[\s>]/g) || []).length;
  const isBlock = /<h[1-6][\s>]/.test(html) || /<ul[\s>]/.test(html) || /<ol[\s>]/.test(html) || paraCount > 1;
  if (isBlock) return { block: true, html: `<div class="md">${html}</div>` };
  return { block: false, html: `<li>${marked.parseInline(d, { breaks: true })}</li>` };
}

// Splits a details[] array into the (items, blocks) HTML pair every detail-list
// surface (card, overlay agent body) needs — same renderDetail() call, same
// filter/join, done once instead of at each call site.
function detailsHTML(details) {
  const rendered = (details || []).map(renderDetail);
  return {
    items: rendered.filter((r) => !r.block).map((r) => r.html).join(""),
    blocks: rendered.filter((r) => r.block).map((r) => r.html).join(""),
  };
}

// Shared by overlayAgentBody/overlayHumanBody/sentCard's expanded view — one
// message's thread can carry entries from either side; rendered identically
// regardless of which body the message ends up in.
function threadHTML(msg) {
  return (msg.thread || [])
    .map((t) => `<div class="thread-entry from-${t.from}">${marked.parse(t.text, { breaks: true })}</div>`)
    .join("");
}

// Shared by overlayAgentBody/overlayHumanBody: the worker's retrospective,
// captured at delivery time (reply_to_message's kind:done retro param) or
// attached late (close_issue's retro param) — discreet, rendered after the
// thread like any other card markdown. Empty when the card has none.
function retroHTML(msg) {
  if (!msg.retro) return "";
  return `<div class="retro"><div class="retro-label">Rétro</div>${marked.parse(msg.retro, { breaks: true })}</div>`;
}

// Full-size images grid: card()/overlayAgentBody tag each <img> with data-msg-id
// (lets the lightbox know which agent card an annotation rides back on) — pass
// msgId for those; omit it for the human-side surfaces (sentCard/overlayHumanBody),
// which key the lightbox off a `comment:<id>` string instead, at the call site.
function imagesHTML(images, msgId) {
  return (images || [])
    .map((img) => `<img src="${imgSrc(img.path)}" class="thumb"${msgId != null ? ` data-msg-id="${msgId}"` : ""} />`)
    .join("");
}

function videosHTML(videos) {
  return (videos || []).map((v) => `<video src="${imgSrc(v.path)}" controls preload="metadata"></video>`).join("");
}

function optionsHTML(options) {
  return (options || [])
    .map((opt) => `<button class="opt" data-opt="${encodeURIComponent(opt)}">${esc(opt)}</button>`)
    .join("");
}

// The one-line summary of a reply/decision shown once a card is "answered" —
// same expression the card body and the overlay's answered footer both need.
function answeredSummaryHTML(reply) {
  if (!reply) return "";
  return `${reply.decision ? `[${esc(reply.decision)}] ` : ""}${esc(reply.optionChosen || reply.text || "(no comment)")}`;
}

// Classifies the LAST thread entry (if any) into the one shape every subline
// needs: who it's from, and — for an agent entry — whether it's a question, a
// done, or a plain update. compactSubline/sentSubline each still own their own
// exact text/markup (genuinely different per surface — sentCard spells out
// "L'IA a besoin de toi" where the compact card just shows "❓"), but neither
// re-derives this classification itself anymore.
function threadTail(msg) {
  const thread = msg.thread || [];
  const last = thread[thread.length - 1];
  if (!last) return null;
  const snippet = compactSnippet(last.text);
  if (last.from === "human") return { kind: "human", snippet };
  if (last.kind === "question") return { kind: "question", snippet };
  if (last.kind === "done") return { kind: "done", snippet };
  return { kind: "agent", snippet };
}

// The compact card's second line: the last thread entry if there is one (same
// kind/color convention as sentCard's subline below), else — for a not-yet-
// threaded r-card — its own context/question text, else a delivery-state hint
// for a not-yet-threaded human card.
function compactSubline(msg, tail) {
  if (tail) {
    if (tail.kind === "human") return { cls: "sub-human", text: `↳ Toi : ${tail.snippet}` };
    if (tail.kind === "question") return { cls: "sub-question", text: `❓ ${tail.snippet}` };
    if (tail.kind === "done") return { cls: "sub-done", text: `✅ ${tail.snippet}` };
    return { cls: "", text: `↳ IA : ${tail.snippet}` };
  }
  if (msg.direction === "agent" && msg.context) {
    const snippet = compactSnippet(msg.context);
    if (msg.kind === "question") return { cls: "sub-question", text: `❓ ${snippet}` };
    if (msg.kind === "review") return { cls: "sub-done", text: snippet };
    return { cls: "", text: snippet };
  }
  if (msg.direction === "human") {
    if (msg.createdBy === "agent") return { cls: "", text: "Créée par l'IA" };
    if (msg.acknowledgedAt) return { cls: "", text: "✓ Lu par l'IA · en attente d'une réponse" };
    if (msg.lastDeliveredAt) return { cls: "", text: "Livré — attend confirmation" };
  }
  return null;
}

// sentCard's subline: same idea as compactSubline above, different markup/labels
// (this surface predates it) — kept as its own function rather than unified so
// neither one risks changing the other's exact rendered text.
function sentSubline(msg, delivered, tail) {
  if (tail) {
    if (tail.kind === "human") return `<span class="ia-reply">↳ Toi : ${tail.snippet}</span>`;
    if (tail.kind === "question") return `<span class="ia-reply ia-question">❓ L'IA a besoin de toi : ${tail.snippet}</span>`;
    if (tail.kind === "done") return `<span class="ia-reply ia-done">✅ Terminé — à valider : ${tail.snippet}</span>`;
    return `<span class="ia-reply">↳ IA : ${tail.snippet}</span>`;
  }
  if (msg.direction === "human" && msg.createdBy === "agent") return "Créée par l'IA";
  if (msg.acknowledgedAt) return "✓ Lu par l'IA · en attente d'une réponse";
  if (delivered || msg.lastDeliveredAt) return "Livré — attend confirmation";
  return "En attente de livraison";
}

// ---------------------------------------------------------------------------
// deriveCardCore: the msg-dependent fields every render surface needs the SAME
// way (dot color, source-tag split, title variants, thread-tail classification,
// approve/awaiting/unseen flags, mini-thumb). The four derive*View functions
// below are thin decorators over this — they pick the core fields they need and
// add only their own surface-specific extras (compact's state-dependent action
// row, the overlay's header/body/footer split, etc).
// ---------------------------------------------------------------------------
// `blockedBy` is the list of still-active blocker ids (computed by the caller —
// app.js's refresh() — via Lifecycle.activeBlockers(msg, liveMessages), since
// that needs the full live card list and this stays a pure per-message view).
function deriveCardCore(msg, { blockedBy = [] } = {}) {
  const { tag: sourceTag, rest: titleRest } = splitSourceTag(msg.summary || msg.title);
  const firstImage = (msg.images || [])[0];
  return {
    dot: dotColor(msg),
    kindLabel: esc(msg.kind),
    sourceTag,
    sourceChip: sourceChipHTML(sourceTag),
    shortTitle: esc(titleRest),
    fullTitle: esc(msg.title),
    summaryOrTitle: esc(msg.summary || msg.title),
    miniThumbHTML: firstImage ? `<img src="${imgSrc(firstImage.path)}" class="thumb mini-thumb" />` : "",
    threadHTML: threadHTML(msg),
    retroHTML: retroHTML(msg),
    tail: threadTail(msg),
    canApprove: isActionableThreadEntry(lastThreadEntry(msg)),
    awaitingDecision: agentAwaitingDecision(msg),
    unseenActionable: unseenActionable(msg),
    awaitingAgent: awaitingAgent(msg),
    blocked: blockedBy.length > 0,
    blockedBy,
  };
}

// The human's own last word on an awaitingAgent card: msg.reply for an
// agent-direction card (the reply that flipped it to "answered" — never
// recorded in msg.thread), the last thread entry's text for a human-direction
// card (his own comment/approval, which IS the tail by awaitingAgent's own
// contract).
function awaitingHumanWord(msg) {
  if (msg.direction === "agent") {
    const r = msg.reply || {};
    return r.optionChosen || r.text || "";
  }
  return (lastThreadEntry(msg) || {}).text || "";
}

// The tail reads as an approval either via the recorded reply's decision, or
// (human-direction, no such field) by the comment text itself being EXACTLY an
// approval. The regex lives in lifecycle.js (shared with the agent move gate);
// this stays tail-based on purpose — the marker describes the LAST entry, while
// the gate's approvedByHuman reads the latest HUMAN entry.
const APPROVAL_TEXT_RE = LocalLifecycle.APPROVAL_TEXT_RE;
function awaitingApproved(msg) {
  if (msg.direction === "agent") return (msg.reply || {}).decision === "approved";
  return APPROVAL_TEXT_RE.test(String((lastThreadEntry(msg) || {}).text || "").trim());
}

// taskKind -> chip label. Everything not listed renders as its own taskKind
// verbatim (e.g. "feedback", "projet") — only "change-request" needs the
// shorter MCR label the mock calls for.
const TASK_KIND_CHIP_LABEL = { "change-request": "MCR" };

function priorityChipHTML(priority) {
  const n = priority ?? 2; // absent = normal/2
  return `<span class="chip chip-p${n}">p${n}</span>`;
}

// Human-only triage control (BACKLOG cards only, in the expanded overlay): four
// buttons instead of the static pill, the current level marked active — reuses
// the same chip-pN color so it reads consistently with the pill everywhere
// else. `n === 0` must stay a `===` check here, never `n || ...`: P0 is falsy.
function prioritySelectorHTML(priority) {
  const current = priority ?? 2; // absent = normal/2, same convention as the pill
  const buttons = [0, 1, 2, 3]
    .map((n) => `<button class="prio-set${n === current ? ` active chip-p${n}` : ""}" data-priority="${n}">P${n}</button>`)
    .join("");
  return `<div class="prio-select" id="overlayPrio">${buttons}</div>`;
}

// One badge per blocker (finding: list/navigate ALL blockers, not just the
// first) — each carries its own data-blocker-id so app.js can wire every
// badge to scroll/flash that specific card, not only blockedBy[0].
function blockedBadgeHTML(blockedBy) {
  return blockedBy.map((id) => `<span class="blocked-badge" data-blocker-id="${esc(id)}">bloqué par ${esc(id)}</span>`).join(" ");
}

function archiveActionHTML() {
  return `<div class="ccard-actions"><button class="archive-link-btn">Testé ✓ Archiver</button></div>`;
}

// ---------------------------------------------------------------------------
// Per-message memoization: marked.parse() (thread/detail/context markdown) is
// the expensive part of every derive*View call below — re-running it on every
// refresh tick (poll + SSE, every few seconds) for every visible card is
// wasted work when nothing about the message actually changed. Concretely:
// server/store.js's peekDeliverable() restamps lastDeliveredAt on every single
// agent poll, which used to force a full markdown re-render of every
// deliverable card on every poll.
//
// Each derive*View function below is backed by its own cache (keyed by msg
// id) holding {inputsKey, view, json}: a call recomputes the expensive view
// only when `inputsKey` — a cheap fingerprint of every raw field that can
// affect what ANY surface renders — differs from the cached entry; otherwise
// the already-built view is returned untouched. This reintroduces a hand-list
// (the old per-surface compactSig/cardSig/sentSig/overlaySig this file's
// header comment mentions replacing), but as ONE list shared by every cache
// instead of four separately hand-maintained ones — the remaining risk (a
// field some surface renders but this list omits, serving a stale view) is
// bounded by tests/views.test.js asserting inputsKey changes for every
// rendered field.
//
// `extra` carries what no derive function can read off msg itself: the
// caller-resolved list of still-ACTIVE blocker ids ("blockedNow" — msg.blockedBy
// is every blocker ever declared, not just the ones still blocking; see
// shared/lifecycle.js's activeBlockers), pending-image counts (pendingImages
// is an app.js-only Map, never touched from this dependency-free file), and —
// deriveSentView only — the `delivered` flag, a second positional argument
// rather than a msg field.
function messageFingerprint(msg, extra = {}) {
  const thread = msg.thread || [];
  const last = thread[thread.length - 1];
  return JSON.stringify([
    msg.id,
    msg.direction,
    msg.kind,
    msg.state,
    msg.status,
    msg.priority,
    msg.taskKind,
    msg.blockedBy || null,
    msg.summary,
    msg.title,
    msg.context,
    msg.project,
    msg.replyTo,
    msg.options || null,
    msg.details || null,
    thread.length,
    last ? [last.at, last.from, last.kind] : null,
    (msg.reply || {}).at,
    Boolean(msg.lastDeliveredAt),
    msg.acknowledgedAt,
    msg.threadSeenAt,
    (msg.images || []).map((i) => i.path),
    (msg.videos || []).map((v) => v.path),
    msg.retro || null,
    extra.blockedNow || [],
    extra.pendingCounts || null,
    extra.delivered,
  ]);
}

function memoize(cache, msg, inputsKey, compute) {
  const hit = cache.get(msg.id);
  if (hit && hit.inputsKey === inputsKey) return hit.view;
  const view = compute();
  cache.set(msg.id, { inputsKey, view, json: JSON.stringify(view) });
  return view;
}

const compactCache = new Map();
const cardCache = new Map();
const sentCache = new Map();
const overlayCache = new Map();

// Called from app.js's refresh(), alongside its own pendingImages/expandedSent/
// pendingDrafts prune, so a card archived/deleted elsewhere doesn't sit in
// these caches forever. `liveIds` is a Set of String(id).
function pruneViewCache(liveIds) {
  for (const cache of [compactCache, cardCache, sentCache, overlayCache]) {
    for (const id of [...cache.keys()]) {
      if (!liveIds.has(String(id))) cache.delete(id);
    }
  }
}

function deriveCompactView(msg, { blockedBy = [], pendingCounts } = {}) {
  const inputsKey = messageFingerprint(msg, { blockedNow: blockedBy, pendingCounts });
  return memoize(compactCache, msg, inputsKey, () => {
    const core = deriveCardCore(msg, { blockedBy });
    // feedback/projet chips dropped: the dot color + backlog grouping already
    // carry that; only the change-request chip stays (semantic, rare).
    const chip =
      msg.state === "backlog" && msg.taskKind === "change-request"
        ? `<span class="chip chip-${msg.taskKind}">${esc(TASK_KIND_CHIP_LABEL[msg.taskKind] || msg.taskKind)}</span>`
        : "";
    const priorityChip = priorityChipHTML(msg.priority);
    const undelivered = msg.direction === "human" && !msg.replyTo && !msg.lastDeliveredAt && !msg.acknowledgedAt;
    const cancelBtn = undelivered ? `<button class="cancel-sent" title="Annuler">×</button>` : "";

    // Répondu subsection: his word is the latest event, the agent hasn't reacted
    // yet — grayed, no action row (except the one exception below), just a
    // marker + what he said (deriveCompactView computes this branch itself
    // rather than taking a passed-in flag, since awaitingAgent is pure on msg
    // and every caller already has msg in hand).
    if (core.awaitingAgent) {
      const snippet = compactSnippet(awaitingHumanWord(msg));
      return {
        dot: core.dot,
        chip,
        priorityChip,
        sourceChip: core.sourceChip,
        title: core.shortTitle,
        miniThumb: core.miniThumbHTML,
        // No cancel button either — a card with a recorded reply/comment
        // already went out. "No action buttons" per the mock holds except one:
        // a closed card must still offer Testé ✓ Archiver, its only way out.
        cancelBtn: "",
        marker: `<span class="answered-marker">${awaitingApproved(msg) ? "✓ Approuvé" : "✓ toi"}</span>`,
        sub: { cls: "sub-human", text: `↳ Toi : ${snippet} · en attente de l'IA` },
        actionsHTML: msg.state === "closed" ? archiveActionHTML() : "",
        blocked: core.blocked,
        blockedBadge: blockedBadgeHTML(blockedBy),
        awaitingAgent: true,
      };
    }

    const sub = compactSubline(msg, core.tail);

    let actionsHTML = "";
    if (msg.state === "questions" && msg.direction === "agent") {
      actionsHTML = `
        <div class="ccard-actions">
          ${msg.kind === "review" ? `<button class="approve-btn">✅ Approve</button>` : ""}
          ${optionsHTML(msg.options)}
          <textarea class="growable-text reply-text" rows="1" placeholder="Répondre…"></textarea>
          <label class="attach-btn">📎<input type="file" accept="image/*" class="attach-input" hidden /></label>
          <button class="send-reply">Reply</button>
        </div>
        <div class="pending-row" data-pending-key="${msg.id}"></div>`;
    } else if (msg.state === "questions" && msg.direction === "human") {
      const commentKey = `comment:${msg.id}`;
      const approveBtn = core.canApprove ? `<button class="approve-issue-btn">✅ Approuver</button>` : "";
      actionsHTML = `
        <div class="ccard-actions">
          ${approveBtn}
          <textarea class="growable-text comment-text" rows="1" placeholder="Répondre…"></textarea>
          <button class="send-comment">Send</button>
        </div>
        <div class="pending-row" data-pending-key="${commentKey}"></div>`;
    } else if (msg.state === "approbation") {
      actionsHTML = `
        <div class="ccard-actions">
          <button class="approve-btn">✅ Approuver</button>
          <button class="open-overlay-fix">À corriger…</button>
        </div>`;
    } else if (msg.state === "closed") {
      actionsHTML = archiveActionHTML();
    }

    return {
      dot: core.dot,
      chip,
      priorityChip,
      sourceChip: core.sourceChip,
      title: core.shortTitle,
      miniThumb: core.miniThumbHTML,
      cancelBtn,
      marker: "",
      sub,
      actionsHTML,
      blocked: core.blocked,
      blockedBadge: blockedBadgeHTML(blockedBy),
      awaitingAgent: false,
    };
  });
}

function deriveCardView(msg, { pendingCounts } = {}) {
  const inputsKey = messageFingerprint(msg, { pendingCounts });
  return memoize(cardCache, msg, inputsKey, () => {
    const core = deriveCardCore(msg);
    const { items: details, blocks: detailBlocks } = detailsHTML(msg.details);

    return {
      kindBadge: core.kindLabel,
      title: core.fullTitle,
      project: msg.project ? `<span class="project">${esc(msg.project)}</span>` : "",
      contextHTML: msg.context ? `<div class="context md">${marked.parse(msg.context, { breaks: true })}</div>` : "",
      details,
      detailBlocks,
      images: imagesHTML(msg.images, msg.id),
      videos: videosHTML(msg.videos),
      options: optionsHTML(msg.options),
      isReview: msg.kind === "review",
      answeredHTML: msg.status === "answered" ? answeredSummaryHTML(msg.reply) : "",
    };
  });
}

function deriveSentView(msg, delivered, { pendingCounts } = {}) {
  const inputsKey = messageFingerprint(msg, { pendingCounts, delivered });
  return memoize(sentCache, msg, inputsKey, () => {
    const core = deriveCardCore(msg);
    const read = Boolean(msg.acknowledgedAt);
    return {
      className: delivered ? "card sent answered" : "card sent",
      cancelable: !delivered && !read,
      approveBtn: core.canApprove,
      unseenDot: core.unseenActionable,
      summaryTitle: core.summaryOrTitle,
      images: imagesHTML(msg.images),
      miniThumb: core.miniThumbHTML,
      thread: core.threadHTML,
      sub: sentSubline(msg, delivered, core.tail),
    };
  });
}

function overlayHeader(msg, blockedBy = []) {
  const core = deriveCardCore(msg, { blockedBy });
  const dot = core.dot || "#77777d";
  const kindBadge = msg.direction === "agent" ? `<span class="kind-badge">${core.kindLabel}</span>` : "";
  const subtitle = msg.summary ? `<div class="overlay-subtitle">${core.fullTitle}</div>` : "";
  return `
    <div class="overlay-head">
      <span class="ccard-dot" style="background:${dot}"></span>
      ${core.sourceChip}
      <div class="overlay-title-wrap">
        <strong class="overlay-title">${core.shortTitle}</strong>
        ${subtitle}
      </div>
      ${msg.state === "backlog" ? prioritySelectorHTML(msg.priority) : priorityChipHTML(msg.priority)}
      ${kindBadge}
      <span class="overlay-badge">${esc(STATE_LABEL[msg.state] || msg.state)}</span>
      ${msg.state === "closed" ? `<span class="archive-link" id="overlayReopen">Reopen</span>` : ""}
      ${msg.direction === "human" ? `<span class="archive-link" id="overlayArchive">Archiver</span>` : ""}
      <button class="overlay-close" id="overlayClose">✕</button>
    </div>
    ${core.blocked ? `<div class="blocked-row">${blockedBadgeHTML(blockedBy)}</div>` : ""}`;
}

function overlayAgentBody(msg) {
  const core = deriveCardCore(msg);
  const { items: detailItems, blocks: detailBlocks } = detailsHTML(msg.details);
  const images = imagesHTML(msg.images, msg.id);
  const videos = videosHTML(msg.videos);
  const options = optionsHTML(msg.options);
  const thread = core.threadHTML;
  const followupKey = `followup:${msg.id}`;
  const awaitingDecision = core.awaitingDecision;

  const bodyHTML = `
    ${msg.context ? `<div class="context md">${marked.parse(msg.context, { breaks: true })}</div>` : ""}
    ${detailItems ? `<ul>${detailItems}</ul>` : ""}
    ${detailBlocks}
    ${images ? `<div class="images">${images}</div>` : ""}
    ${videos ? `<div class="videos">${videos}</div>` : ""}
    ${thread ? `<div class="thread">${thread}</div>` : ""}
    ${core.retroHTML}
  `;

  const footerHTML =
    msg.status === "answered" && !awaitingDecision
      ? `<div class="answered">${answeredSummaryHTML(msg.reply)}</div>
        <div class="reply-row overlay-footer-row">
          <textarea class="growable-text followup-text" rows="1" placeholder="Add a follow-up comment… (Shift+Enter for a new line, paste an image to attach)"></textarea>
          <button class="send-followup">Send</button>
        </div>
        <div class="pending-row" data-pending-key="${followupKey}"></div>`
      : `<div class="reply-row overlay-footer-row">
          ${msg.kind === "review" || msg.state === "approbation" ? `<button class="approve-btn">✅ Approuver</button>` : ""}
          ${options}
          <textarea class="growable-text reply-text" rows="1" placeholder="Commenter… (Ctrl+V ou glisse une image)"></textarea>
          <label class="attach-btn">📎<input type="file" accept="image/*" class="attach-input" hidden /></label>
          <button class="send-reply">Reply</button>
        </div>
        <div class="pending-row" data-pending-key="${msg.id}"></div>`;

  return { bodyHTML, footerHTML };
}

function overlayHumanBody(msg) {
  const core = deriveCardCore(msg);
  const images = imagesHTML(msg.images);
  const thread = core.threadHTML;
  const commentKey = `comment:${msg.id}`;
  const approveBtn = core.canApprove ? `<button class="approve-issue-btn">✅ Approuver</button>` : "";

  const bodyHTML = `
    ${images ? `<div class="images">${images}</div>` : ""}
    ${thread ? `<div class="thread">${thread}</div>` : ""}
    ${core.retroHTML}
  `;

  const footerHTML = `
    <div class="reply-row overlay-footer-row">
      ${approveBtn}
      <textarea class="growable-text comment-text" rows="1" placeholder="Commenter… (Ctrl+V ou glisse une image)"></textarea>
      <button class="send-comment">Send</button>
    </div>
    <div class="pending-row" data-pending-key="${commentKey}"></div>
  `;

  return { bodyHTML, footerHTML };
}

function deriveOverlayView(msg, { blockedBy = [], pendingCounts } = {}) {
  const inputsKey = messageFingerprint(msg, { blockedNow: blockedBy, pendingCounts });
  return memoize(overlayCache, msg, inputsKey, () => {
    const headerHTML = overlayHeader(msg, blockedBy);
    const { bodyHTML, footerHTML } = msg.direction === "agent" ? overlayAgentBody(msg) : overlayHumanBody(msg);
    return { headerHTML, bodyHTML, footerHTML };
  });
}

const Views = {
  imgSrc,
  esc,
  mdToPlainText,
  compactSnippet,
  splitSourceTag,
  sourceChipHTML,
  renderDetail,
  threadHTML,
  threadTail,
  compactSubline,
  sentSubline,
  overlayHeader,
  overlayAgentBody,
  overlayHumanBody,
  prioritySelectorHTML,
  deriveCardCore,
  deriveCompactView,
  deriveCardView,
  deriveSentView,
  deriveOverlayView,
  messageFingerprint,
  pruneViewCache,
};

if (typeof module !== "undefined") module.exports = Views;
else window.Views = Views;
})();
