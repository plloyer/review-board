const { unseenActionable, agentAwaitingDecision, awaitingAgent, COLUMN_STATES, activeBlockers } = window.Lifecycle;
const { imgSrc, deriveCompactView, deriveCardView, deriveSentView, deriveOverlayView, pruneViewCache } = window.Views;

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// msg.id -> array of server-side file paths queued to go out with that reply.
const pendingImages = new Map();

// Cheap per-message pending-image-count summary — one of the fingerprint inputs
// derive*View's memoization (public/views.js) uses to decide whether to
// recompute; views.js has no access to this Map itself, so it's threaded in.
// Checks all three keys a message's composer could be queued under (reply-text,
// comment, followup).
function pendingCountsFor(id) {
  const sid = String(id);
  return [pendingImages.get(sid), pendingImages.get(`comment:${sid}`), pendingImages.get(`followup:${sid}`)].map((list) =>
    list ? list.length : 0
  );
}

// msg.id -> draft text stranded by a rebuild into a card shape with no textarea
// (e.g. a column move). reconcileSection stashes here when it can't find a
// textarea to restore into; it and renderOverlayBody both re-attempt the
// restore once a textarea for that id exists again.
const pendingDrafts = new Map();

// Same breakpoint as the mobile layout in style.css: on a phone, Enter should just
// type a newline (no convenient Shift key on the on-screen keyboard) — Send is the
// only way to submit. On desktop, Enter submits and Shift+Enter is the newline.
function submitsOnEnter(e) {
  return e.key === "Enter" && !e.shiftKey && !window.matchMedia("(max-width: 900px)").matches;
}

// Grows a textarea to fit its content; CSS max-height (5 lines) plus overflow-y:
// auto takes over past that, so this never needs to know the cap itself.
function autoGrow(el) {
  // Empty box -> one row: scrollHeight would otherwise count a wrapped
  // placeholder and keep the box two lines tall in a narrow window.
  if (el.value === "") { el.style.height = ""; return; }
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

// Shared by every reply/comment/followup textarea (compact card, overlay footer) —
// same POST, just a different textarea selector / pendingImages key. Snapshot +
// clear the textarea and pending images BEFORE the await so a second Enter/click
// can't double-send; restore both on failure.
async function submitThreadComment(el, textSelector, key, title, threadMsgId) {
  const ta = el.querySelector(textSelector);
  const text = ta.value.trim();
  const imgs = pendingImages.get(key) || [];
  if (!text && imgs.length === 0) return;
  ta.value = "";
  pendingImages.delete(key);
  renderPendingRows(key);
  try {
    await fetchJSON("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: text ? `Re "${title}": ${text}` : `Re "${title}"`,
        images: imgs.map((p) => ({ path: p })),
        // Delivery vehicle of a thread reply: hidden from the board (the thread
        // note below is what renders), still delivered to the agent.
        replyTo: threadMsgId || null,
      }),
    });
    // On an issue card, also record the reply in ITS thread — that's what the
    // board shows and what moves the card out of "À toi de répondre".
    if (threadMsgId) {
      await fetchJSON(`/api/messages/${threadMsgId}/thread-note`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text || "(image)" }),
      }).catch(() => {});
      // Answered: nothing left to read here — collapse before the card moves
      // back down to the issues section.
      expandedSent.delete(String(threadMsgId));
    }
    refresh(true);
  } catch (err) {
    ta.value = text;
    pendingImages.set(key, imgs);
    renderPendingRows(key);
  }
}

// Shared by card() and the overlay's agent body: a detail line renders as a list
// item unless it's block-level markdown (headings/lists/multiple paragraphs), in
// which case it gets its own block instead of being crammed into a bullet.
// (moved to public/views.js as renderDetail — used by deriveCardView there)

function card(msg) {
  const view = deriveCardView(msg, { pendingCounts: pendingCountsFor(msg.id) });
  const el = document.createElement("section");
  el.className = `card ${msg.kind} ${msg.status}`;
  el.dataset.msgId = msg.id;

  const followupKey = `followup:${msg.id}`;

  el.innerHTML = `
    <div class="card-head">
      <span class="kind-badge">${view.kindBadge}</span>
      <strong>${view.title}</strong>
      ${view.project}
    </div>
    ${view.contextHTML}
    ${view.details ? `<ul>${view.details}</ul>` : ""}
    ${view.detailBlocks}
    ${view.images ? `<div class="images">${view.images}</div>` : ""}
    ${view.videos ? `<div class="videos">${view.videos}</div>` : ""}
    ${
      msg.status === "answered"
        ? `<div class="answered">${view.answeredHTML}</div>
          <div class="reply-row">
            <textarea class="growable-text followup-text" rows="1" placeholder="Add a follow-up comment… (Shift+Enter for a new line, paste an image to attach)"></textarea>
            <button class="send-followup">Send</button>
          </div>
          <div class="pending-row" data-pending-key="${followupKey}"></div>`
        : `<div class="reply-row">
            ${view.isReview ? `<button class="approve-btn">✅ Approve</button>` : ""}
            ${view.options}
            <textarea class="growable-text reply-text" rows="1" placeholder="Comment… (Shift+Enter for a new line, paste an image to attach)"></textarea>
            <label class="attach-btn">📎<input type="file" accept="image/*" class="attach-input" hidden /></label>
            <button class="send-reply">Reply</button>
          </div>
          <div class="pending-row" data-pending-key="${msg.id}"></div>`
    }
  `;

  if (msg.status === "answered") {
    const submitFollowup = () => submitThreadComment(el, ".followup-text", followupKey, msg.title);
    el.querySelector(".send-followup").addEventListener("click", submitFollowup);
    el.querySelector(".followup-text").addEventListener("keydown", (e) => {
      if (submitsOnEnter(e)) {
        e.preventDefault();
        submitFollowup();
      }
    });
    wirePasteToAttach(el.querySelector(".followup-text"), followupKey);
  } else {
    el.querySelectorAll(".opt").forEach((btn) =>
      btn.addEventListener("click", () => sendReply(msg.id, { optionChosen: decodeURIComponent(btn.dataset.opt) }))
    );
    const imgsFor = () => (pendingImages.get(msg.id) || []).map((p) => ({ path: p }));
    el.querySelector(".approve-btn")?.addEventListener("click", async () => {
      const text = el.querySelector(".reply-text").value;
      el.querySelector(".reply-text").value = "";
      try {
        await sendReply(msg.id, { decision: "approved", text, images: imgsFor() });
      } catch (err) {
        el.querySelector(".reply-text").value = text;
      }
    });
    // A typed reply with no explicit decision reads as "at least another iteration",
    // never a silent approval — approving is only ever the dedicated button above.
    const submitReply = async () => {
      const text = el.querySelector(".reply-text").value;
      const imgs = imgsFor();
      if (!text.trim() && !imgs.length) return;
      el.querySelector(".reply-text").value = "";
      try {
        await sendReply(msg.id, { decision: "iteration", text, images: imgs });
      } catch (err) {
        el.querySelector(".reply-text").value = text;
      }
    };
    el.querySelector(".send-reply").addEventListener("click", submitReply);
    el.querySelector(".reply-text").addEventListener("keydown", (e) => {
      if (submitsOnEnter(e)) {
        e.preventDefault();
        submitReply();
      }
    });
    el.querySelector(".attach-input").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const path = await uploadFile(file);
      addPendingImage(msg.id, path);
    });
    wirePasteToAttach(el.querySelector(".reply-text"), msg.id);
  }
  wireDropToAttach(el, msg.status === "answered" ? followupKey : msg.id);
  el.querySelectorAll(".pending-row").forEach((row) => renderPendingChips(row, row.dataset.pendingKey));

  el.querySelectorAll(".thumb").forEach((img) =>
    img.addEventListener("click", () => openLightbox(img.src, msg.id, msg.status !== "answered", galleryOf(el)))
  );
  el.querySelectorAll(".growable-text").forEach((ta) => ta.addEventListener("input", () => autoGrow(ta)));

  return el;
}

function pendingChipsHTML(key) {
  return (pendingImages.get(key) || [])
    .map(
      (p, i) =>
        `<span class="pending-chip"><img src="${imgSrc(p)}" /><button class="remove-pending" data-key="${key}" data-i="${i}">×</button></span>`
    )
    .join("");
}

// Rebuilds only the chip row for `key` in place — no card rebuild, so an attach/
// remove never touches the textarea or anything else in the card.
function renderPendingChips(container, key) {
  container.innerHTML = pendingChipsHTML(key);
  container.querySelectorAll(".remove-pending").forEach((btn) =>
    btn.addEventListener("click", () => {
      const list = pendingImages.get(btn.dataset.key) || [];
      list.splice(Number(btn.dataset.i), 1);
      renderPendingRows(btn.dataset.key);
    })
  );
}

// The same key can have two rows at once: the compact card on the board and
// the overlay open over it. Painting only the first match leaves the visible
// one stale (dropped images "not appearing" until the overlay is reopened).
function renderPendingRows(key) {
  document.querySelectorAll(`.pending-row[data-pending-key="${CSS.escape(String(key))}"]`).forEach((row) => renderPendingChips(row, key));
}

function addPendingImage(key, path) {
  if (!pendingImages.has(key)) pendingImages.set(key, []);
  pendingImages.get(key).push(path);
  if (key === "compose") {
    renderComposeChips();
    return;
  }
  renderPendingRows(key);
}

// Ctrl+V a screenshot into any of these boxes and it rides along as an attachment,
// same as the 📎 button — paste only intercepts when the clipboard actually has an
// image, so pasting text keeps working normally.
function pasteLog(entry) {
  (window.__pasteLog || (window.__pasteLog = [])).push({ t: Date.now(), ...entry });
}

// A paste that silently attaches nothing reads as "the app ate my screenshot" —
// surface the failure where the user is looking.
function showToast(text) {
  let toast = document.getElementById("toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "toast";
    document.body.appendChild(toast);
  }
  toast.textContent = text;
  toast.classList.add("visible");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => toast.classList.remove("visible"), 5000);
}

async function handlePasteAttach(e, key) {
    pasteLog({ evt: "paste", key, hasFocus: document.hasFocus(), items: [...(e.clipboardData?.items || [])].map((i) => i.type) });
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
    const file = item && item.getAsFile();
    if (file) {
      e.preventDefault();
      try {
        const path = await uploadFile(file);
        addPendingImage(key, path);
        pasteLog({ evt: "attached-from-item", key });
        return;
      } catch (err) {
        // A real OS paste can hand us a File whose bytes aren't readable yet (seen
        // on Windows: getAsFile() succeeds but FileReader fails) — fall through to
        // the main-process clipboard read below instead of dropping the paste.
        pasteLog({ evt: "item-read-error", key, err: String(err) });
      }
    }
    // A text paste is a text paste — don't attach a stale clipboard image alongside it.
    if (e.clipboardData?.getData("text")) return;
    // Electron's paste event doesn't reliably expose clipboardData.items for an
    // image (item present but getAsFile() null, or no items at all) — fall back to
    // reading the OS clipboard via the main process.
    try {
      const res = await fetch("/api/clipboard-image");
      if (res.status !== 200) {
        pasteLog({ evt: "clipboard-image-empty", key, status: res.status });
        return;
      }
      const { dataUrl } = await res.json();
      const path = await uploadDataUrl(dataUrl, "clipboard.png");
      addPendingImage(key, path);
      pasteLog({ evt: "attached-from-fallback", key });
    } catch (err) {
      pasteLog({ evt: "fallback-error", key, err: String(err) });
      showToast("⚠️ L'image collée n'a pas pu être attachée (" + (String(err).includes("too large") ? "trop grosse" : "erreur") + ")");
    }
}

function wirePasteToAttach(textarea, key) {
  textarea.dataset.pasteWired = "1";
  textarea.addEventListener("paste", (e) => handlePasteAttach(e, key));
}

// Focus-proof paste: Ctrl+V with nothing (or something un-wired) focused still
// attaches to the compose message instead of silently going nowhere.
// A proof image whose file never reached this machine (agent on another box,
// path-only attachment) 404s — show a labelled placeholder instead of the
// browser's broken-image glyph, so the failure explains itself.
document.addEventListener(
  "error",
  (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.closest("#board, #overlayPanel, #blockHistory")) return;
    const ph = document.createElement("span");
    ph.className = "img-missing";
    const src = img.getAttribute("src") || "";
    ph.textContent = `🖼️ image indisponible (${src.length > 60 ? `${src.slice(0, 60)}…` : src})`;
    ph.title = src;
    img.replaceWith(ph);
  },
  true
);

document.addEventListener("paste", (e) => {
  if (e.target instanceof Element && e.target.closest("textarea[data-paste-wired]")) return;
  handlePasteAttach(e, "compose");
});

// Drag an image file onto `el` (a card or the compose header) and it rides along
// as an attachment, same as paste/📎. Counts enter/leave since dragleave also fires
// when crossing child elements — a plain toggle would flicker the outline on/off
// as the pointer moves over child nodes.
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => e.preventDefault());

// `key` is normally a plain string, fixed for that element's lifetime. Pass a
// function instead when the element is a persistent node re-rendered in place
// (the overlay panel) — it's called at drop time so the target always matches
// whatever composer is currently showing, and the listener is wired only once.
function wireDropToAttach(el, key) {
  let depth = 0;
  el.addEventListener("dragenter", (e) => {
    e.preventDefault();
    depth++;
    el.classList.add("drag-over");
  });
  el.addEventListener("dragover", (e) => e.preventDefault());
  el.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) el.classList.remove("drag-over");
  });
  el.addEventListener("drop", async (e) => {
    e.preventDefault();
    depth = 0;
    el.classList.remove("drag-over");
    const resolvedKey = typeof key === "function" ? key() : key;
    if (!resolvedKey) return;
    const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith("image/"));
    for (const file of files) {
      const path = await uploadFile(file);
      addPendingImage(resolvedKey, path);
    }
  });
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function uploadFile(file) {
  const dataUrl = await fileToDataUrl(file);
  const { path } = await fetchJSON("/api/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dataUrl, filename: file.name }),
  });
  return path;
}

async function uploadDataUrl(dataUrl, filename) {
  const { path } = await fetchJSON("/api/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dataUrl, filename }),
  });
  return path;
}

// ponytail: single freehand red pen, no color/shape picker, no undo — add if it's
// ever not enough for pointing at the thing in the screenshot.
// Every image a card or overlay shows, in document order: the set the lightbox
// arrows cycle through when one of them is opened.
function galleryOf(root) {
  return [...root.querySelectorAll(".thumb, .thread img")].map((i) => ({ src: i.src, label: i.alt, caption: i.title }));
}

function openLightbox(src, msgId, annotatable, gallery = []) {
  const overlay = document.createElement("div");
  overlay.className = "lightbox";

  const found = gallery.findIndex((g) => g.src === src);
  const entries = found >= 0 ? gallery : [{ src, label: "", caption: "" }];
  const srcs = entries.map((g) => g.src);
  let index = Math.max(0, found);

  // Label ("Before") and caption (what the image shows) over the image, so
  // the human knows what he is looking at; hidden when the agent gave none.
  const captionEl = document.createElement("div");
  captionEl.className = "lightbox-caption";
  const paintCaption = () => {
    const { label, caption } = entries[index];
    captionEl.hidden = !label && !caption;
    captionEl.replaceChildren();
    if (label) {
      const strong = document.createElement("strong");
      strong.textContent = label;
      captionEl.appendChild(strong);
    }
    if (label && caption) captionEl.appendChild(document.createTextNode(" \u00b7 "));
    if (caption) captionEl.appendChild(document.createTextNode(caption));
  };
  paintCaption();
  overlay.appendChild(captionEl);

  const wrap = document.createElement("div");
  wrap.className = "lightbox-wrap";
  const img = document.createElement("img");
  img.src = src;
  img.draggable = false;
  const canvas = document.createElement("canvas");
  canvas.className = "annotate-canvas";
  wrap.appendChild(img);
  wrap.appendChild(canvas);
  overlay.appendChild(wrap);

  let drawing = false;
  let annotateOn = false;

  // Every window-level listener opened below is tracked here so closeLightbox()
  // can remove them all — window persists across lightbox opens, so leaving
  // them wired would leak a growing pile of listeners on stale canvases/imgs.
  const windowListeners = [];
  const onWindow = (type, handler) => {
    window.addEventListener(type, handler);
    windowListeners.push([type, handler]);
  };
  function closeLightbox() {
    windowListeners.forEach(([type, handler]) => window.removeEventListener(type, handler));
    overlay.remove();
  }

  const closeOnBackdrop = (e) => {
    if (e.target === overlay) closeLightbox();
  };
  overlay.addEventListener("click", closeOnBackdrop);

  // Pan/zoom: the image starts scaled to fit the screen (CSS max-width/height in
  // style.css), and scale/tx/ty are an additional transform on top of that — wheel
  // or pinch to zoom in past fit, drag to pan once zoomed. Disabled while annotating
  // so draw coordinates stay simple 1:1 with the canvas.
  let scale = 1,
    tx = 0,
    ty = 0;
  const MIN_SCALE = 1,
    MAX_SCALE = 5;
  const clampScale = (s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
  const applyTransform = () => {
    wrap.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  };
  const resetTransform = () => {
    scale = 1;
    tx = 0;
    ty = 0;
    applyTransform();
  };

  wrap.addEventListener(
    "wheel",
    (e) => {
      if (annotateOn) return;
      e.preventDefault();
      scale = clampScale(scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
      if (scale <= 1.001) resetTransform();
      else applyTransform();
    },
    { passive: false }
  );

  let dragging = false;
  let dragStart = null;
  wrap.addEventListener("mousedown", (e) => {
    if (annotateOn || scale <= 1) return;
    dragging = true;
    dragStart = { x: e.clientX - tx, y: e.clientY - ty };
  });
  onWindow("mousemove", (e) => {
    if (!dragging) return;
    tx = e.clientX - dragStart.x;
    ty = e.clientY - dragStart.y;
    applyTransform();
  });
  onWindow("mouseup", () => (dragging = false));

  wrap.addEventListener("dblclick", () => {
    if (!annotateOn) resetTransform();
  });

  // Left/right arrows (keys or the on-screen buttons) step through the card's
  // images; a pending annotation does not follow, the canvas is redrawn blank
  // for the new image by sizeCanvasBuffer on load.
  if (srcs.length > 1) {
    const nav = document.createElement("div");
    nav.className = "lightbox-nav";
    nav.innerHTML = `<button class="lightbox-prev" aria-label="Previous">‹</button><span class="lightbox-counter"></span><button class="lightbox-next" aria-label="Next">›</button>`;
    nav.addEventListener("click", (e) => e.stopPropagation());
    overlay.appendChild(nav);
    const counter = nav.querySelector(".lightbox-counter");
    const show = (i) => {
      index = (i + srcs.length) % srcs.length;
      img.src = srcs[index];
      resetTransform();
      paintCaption();
      counter.textContent = `${index + 1} / ${srcs.length}`;
    };
    nav.querySelector(".lightbox-prev").addEventListener("click", () => show(index - 1));
    nav.querySelector(".lightbox-next").addEventListener("click", () => show(index + 1));
    onWindow("keydown", (e) => {
      if (e.key === "ArrowRight") show(index + 1);
      else if (e.key === "ArrowLeft") show(index - 1);
    });
    counter.textContent = `${index + 1} / ${srcs.length}`;
  }

  const touchDist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  const touchMid = (a, b) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });
  let touchState = null;
  wrap.addEventListener(
    "touchstart",
    (e) => {
      if (annotateOn) return;
      if (e.touches.length === 2) {
        e.preventDefault();
        touchState = {
          startDist: touchDist(e.touches[0], e.touches[1]),
          startScale: scale,
          startTx: tx,
          startTy: ty,
          startMid: touchMid(e.touches[0], e.touches[1]),
        };
      } else if (e.touches.length === 1 && scale > 1) {
        touchState = { pan: true, lastX: e.touches[0].clientX, lastY: e.touches[0].clientY };
      }
    },
    { passive: false }
  );
  wrap.addEventListener(
    "touchmove",
    (e) => {
      if (annotateOn || !touchState) return;
      if (e.touches.length === 2 && touchState.startDist) {
        e.preventDefault();
        const newDist = touchDist(e.touches[0], e.touches[1]);
        scale = clampScale(touchState.startScale * (newDist / touchState.startDist));
        const newMid = touchMid(e.touches[0], e.touches[1]);
        tx = touchState.startTx + (newMid.x - touchState.startMid.x);
        ty = touchState.startTy + (newMid.y - touchState.startMid.y);
        applyTransform();
      } else if (touchState.pan && e.touches.length === 1) {
        e.preventDefault();
        tx += e.touches[0].clientX - touchState.lastX;
        ty += e.touches[0].clientY - touchState.lastY;
        touchState.lastX = e.touches[0].clientX;
        touchState.lastY = e.touches[0].clientY;
        applyTransform();
      }
    },
    { passive: false }
  );
  wrap.addEventListener("touchend", () => (touchState = null));

  // The canvas's internal buffer is the image's natural resolution, but it's
  // displayed scaled down to fit — offsetX/Y are in displayed CSS pixels, so they
  // must be scaled up to the buffer's coordinate space or every draw lands wrong
  // whenever the image was shrunk to fit (i.e. almost always for a real screenshot).
  const canvasPoint = (e) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) * canvas.width) / rect.width,
      y: ((e.clientY - rect.top) * canvas.height) / rect.height,
    };
  };
  const startDraw = (e) => {
    if (!annotateOn) return;
    drawing = true;
    const ctx = canvas.getContext("2d");
    ctx.strokeStyle = "#ff3b30";
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    const p = canvasPoint(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  };
  const draw = (e) => {
    if (!drawing) return;
    const ctx = canvas.getContext("2d");
    const p = canvasPoint(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  };
  const endDraw = () => (drawing = false);

  canvas.addEventListener("mousedown", startDraw);
  canvas.addEventListener("mousemove", draw);
  onWindow("mouseup", endDraw);

  if (annotatable) {
    const toolbar = document.createElement("div");
    toolbar.className = "lightbox-toolbar";
    toolbar.innerHTML = `<button class="annotate-toggle">✏️ Annotate</button><button class="attach-annotated" hidden>Attach to reply</button>`;
    toolbar.addEventListener("click", (e) => e.stopPropagation());
    overlay.appendChild(toolbar);

    const toggleBtn = toolbar.querySelector(".annotate-toggle");
    const attachBtn = toolbar.querySelector(".attach-annotated");
    toggleBtn.addEventListener("click", () => {
      annotateOn = !annotateOn;
      if (annotateOn) resetTransform();
      canvas.classList.toggle("active", annotateOn);
      toggleBtn.classList.toggle("active", annotateOn);
      attachBtn.hidden = !annotateOn;
    });
    attachBtn.addEventListener("click", async () => {
      const flat = document.createElement("canvas");
      flat.width = img.naturalWidth;
      flat.height = img.naturalHeight;
      const ctx = flat.getContext("2d");
      ctx.drawImage(img, 0, 0);
      ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, flat.width, flat.height);
      const path = await uploadDataUrl(flat.toDataURL("image/png"), `annotated-${Date.now()}.png`);
      addPendingImage(msgId, path);
      closeLightbox();
    });
  }

  // Canvas is sized to 100%/100% by CSS (matches the img immediately, no layout-timing
  // race); only its internal pixel buffer needs the natural size, once known.
  const sizeCanvasBuffer = () => {
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
  };
  if (img.complete && img.naturalWidth) sizeCanvasBuffer();
  else img.addEventListener("load", sizeCanvasBuffer);

  document.body.appendChild(overlay);
}

async function sendReply(id, body) {
  // Clear pending images before the await too (same double-submit guard as
  // submitThreadComment); restore them if the request fails.
  const imgs = pendingImages.get(id);
  pendingImages.delete(id);
  try {
    await fetchJSON(`/api/reviews/${id}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    refresh(true);
  } catch (err) {
    if (imgs) {
      pendingImages.set(id, imgs);
      renderPendingRows(id);
    }
    throw err;
  }
}

// A message you sent from the compose box — not something the AI authored, so it
// gets its own small card instead of the review/question layout. Used only by the
// History section now (the live board uses compactCard()/the overlay instead);
// renders compact by default (one-line title + status subline); click anywhere on
// the row (except a link/button/thumb) expands it in place. Expansion is tracked
// here rather than in msg data so a refresh tick (which reconciles by unchanged
// sig, leaving the DOM node untouched) never collapses a card the user has open.
const expandedSent = new Set();

function sentCard(msg, delivered) {
  const el = document.createElement("section");
  const msgId = String(msg.id);
  const commentKey = `comment:${msgId}`;

  const submitComment = () => submitThreadComment(el, ".comment-text", commentKey, msg.title, msg.id);

  const approveIssueInPlace = async () => {
    await fetchJSON("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `Re "${msg.title}": Approuvé`, images: [], replyTo: msg.id }),
    });
    await fetchJSON(`/api/messages/${msg.id}/thread-note`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Approuvé ✅" }),
    }).catch(() => {});
    await fetchJSON(`/api/messages/${msg.id}/seen`, { method: "POST" }).catch(() => {});
    expandedSent.delete(msgId);
    refresh(true);
  };

  function paint() {
    const view = deriveSentView(msg, delivered, { pendingCounts: pendingCountsFor(msg.id) });
    const expanded = expandedSent.has(msgId);
    el.className = view.className + (expanded ? " expanded" : "");
    // "Approuver" shows whenever the last thread entry needs a human (question/done),
    // seen or not — narrower than the dot's "unseen" highlight.
    const cancelBtn = view.cancelable ? `<button class="cancel-sent" title="Cancel this message">×</button>` : "";
    const approveBtn = view.approveBtn ? `<button class="approve-issue-btn">✅ Approuver</button>` : "";

    if (expanded) {
      el.innerHTML = `
        <div class="issue-row">
          <span class="issue-dot${view.unseenDot ? " actionable" : ""}"></span>
          <div class="issue-full">${view.summaryTitle}</div>
          ${cancelBtn}
          <span class="archive-link">Archiver</span>
        </div>
        ${view.images ? `<div class="images">${view.images}</div>` : ""}
        ${view.thread ? `<div class="thread">${view.thread}</div>` : ""}
        <div class="issue-sub">${view.sub}</div>
        <div class="reply-row">
          ${approveBtn}
          <textarea class="growable-text comment-text" rows="1" placeholder="Commenter… (Shift+Enter for a new line, paste an image to attach)"></textarea>
          <button class="send-comment">Send</button>
        </div>
        <div class="pending-row" data-pending-key="${commentKey}"></div>
      `;
      wirePasteToAttach(el.querySelector(".comment-text"), commentKey);
      el.querySelectorAll(".growable-text").forEach((ta) => ta.addEventListener("input", () => autoGrow(ta)));
      renderPendingChips(el.querySelector(".pending-row"), commentKey);
      // Agents embed proof images in thread markdown, sometimes as a bare local
      // path — route those through /api/image, and open all of them in the lightbox.
      el.querySelectorAll(".thread img").forEach((img) => {
        const src = img.getAttribute("src") || "";
        if (!/^(https?:|data:|\/api\/image)/i.test(src)) img.src = imgSrc(src);
        img.addEventListener("click", (e) => {
          e.stopPropagation();
          openLightbox(img.src, commentKey, true, galleryOf(el));
        });
      });
      el.querySelectorAll(".thread video").forEach((v) => {
        const src = v.getAttribute("src") || "";
        if (src && !/^(https?:|data:|\/api\/image)/i.test(src)) v.src = imgSrc(src);
        v.setAttribute("controls", "");
      });
    } else {
      el.innerHTML = `
        <div class="issue-row">
          <span class="issue-dot${view.unseenDot ? " actionable" : ""}"></span>
          <div class="issue-main">
            <div class="issue-title">${view.summaryTitle}</div>
            <div class="issue-sub">${view.sub}</div>
          </div>
          ${view.miniThumb}
          ${cancelBtn}
          ${approveBtn}
          <span class="archive-link">Archiver</span>
        </div>
      `;
    }
  }

  paint();

  // Delegated on the persistent `el` (repainted via innerHTML, not recreated) so
  // this is wired exactly once regardless of how many times paint() re-renders.
  el.addEventListener("click", (e) => {
    const thumb = e.target.closest(".thumb");
    if (thumb) {
      // Annotations drawn here ride along with the card's next comment.
      openLightbox(thumb.src, commentKey, true, galleryOf(el));
      return;
    }
    if (e.target.closest(".archive-link")) {
      fetchJSON(`/api/messages/${msg.id}/archive`, { method: "POST" }).then(() => refresh(true));
      return;
    }
    if (e.target.closest(".cancel-sent")) {
      fetch(`/api/messages/${msg.id}`, { method: "DELETE" }).then(() => refresh(true));
      return;
    }
    if (e.target.closest(".send-comment")) {
      submitComment();
      return;
    }
    if (e.target.closest(".approve-issue-btn")) {
      approveIssueInPlace();
      return;
    }
    // Toggle only from the title row — clicking in the body (to select/copy
    // text, read the thread, etc.) must never collapse the card. A live text
    // selection also never toggles.
    if (!e.target.closest(".issue-row")) return;
    if (String(window.getSelection && window.getSelection())) return;
    if (expandedSent.has(msgId)) {
      expandedSent.delete(msgId);
    } else {
      expandedSent.add(msgId);
      if (unseenActionable(msg)) {
        // Optimistic: clear the dot locally so the /seen round-trip (excluded
        // from the sig on purpose) doesn't need a rebuild to reflect it.
        msg.threadSeenAt = new Date().toISOString();
        fetchJSON(`/api/messages/${msgId}/seen`, { method: "POST" }).catch(() => {});
      }
    }
    paint();
  });
  el.addEventListener("keydown", (e) => {
    if (e.target.classList.contains("comment-text") && submitsOnEnter(e)) {
      e.preventDefault();
      submitComment();
    }
  });
  wireDropToAttach(el, commentKey);

  return el;
}

// ============================================================================
// Kanban board: 6 state columns + backlog/closed collapse rails + the expanded
// overlay. The History section above still uses card()/sentCard() unchanged.
// ============================================================================

// (compactSubline moved to public/views.js — used by deriveCompactView there)

// Standalone (unlike sentCard's own local closure) since it's shared by the
// compact card and the overlay footer, neither of which has sentCard's
// expandedSent bookkeeping to also clear.
async function approveIssue(msg) {
  await fetchJSON("/api/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: `Re "${msg.title}": Approuvé`, images: [], replyTo: msg.id }),
  });
  await fetchJSON(`/api/messages/${msg.id}/thread-note`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Approuvé ✅" }),
  }).catch(() => {});
  await fetchJSON(`/api/messages/${msg.id}/seen`, { method: "POST" }).catch(() => {});
  closeOverlayIfOpen(msg.id);
  refresh(true);
}

// Shared by compactCard and the overlay panel: each blocker gets its own badge
// (data-blocker-id) — clicking one scrolls/flashes that card, expanding its
// Backlog/Closed rail first if it's currently collapsed (an element inside a
// `hidden` column has no layout box, so scrollIntoView on it would silently
// no-op without this).
function wireBlockedBadges(container) {
  container.querySelectorAll(".blocked-badge").forEach((badge) => {
    badge.addEventListener("click", (e) => {
      e.stopPropagation();
      const blockerId = e.currentTarget.dataset.blockerId;
      const target = document.querySelector(`[data-msg-id="${CSS.escape(blockerId)}"]`);
      if (!target) return;
      const col = target.closest(".column");
      if (col?.hidden) setCollapsed(col.dataset.state, false);
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      target.classList.add("flash");
      setTimeout(() => target.classList.remove("flash"), 1000);
    });
  });
}

function compactCard(msg, blockedInfo) {
  const view = deriveCompactView(msg, blockedInfo);
  const el = document.createElement("div");
  el.className = `ccard${view.dimmed ? " blocked" : ""}${view.awaitingAgent ? " repondu" : ""}`;
  el.dataset.msgId = msg.id;

  el.innerHTML = `
    <div class="ccard-row">
      ${view.priorityChip}
      <span class="ccard-title">${view.title}</span>
      ${view.tagChips}
      ${view.chip}
      ${view.miniThumb}
      ${view.cancelBtn}
      ${view.marker || ""}
    </div>
    ${view.blockedBadge ? `<div class="blocked-row">${view.blockedBadge}</div>` : ""}
    ${
      view.sub || view.sourceChip || view.agentMark
        ? `<div class="ccard-sub ${view.sub ? view.sub.cls : ""}">${view.agentMark}${view.sourceChip ? `${view.sourceChip}${view.sub ? " · " : ""}` : ""}${view.sub ? view.sub.text : ""}</div>`
        : ""
    }
    ${view.actionsHTML}
  `;

  wireBlockedBadges(el);

  // A Répondu card renders actionsHTML: "" except when msg.state is "closed"
  // (wired unconditionally below, since that's the one action it keeps) —
  // nothing else here to bind to. It can still receive a dropped image though
  // (wireDropToAttach below is unconditional too).
  if (!view.awaitingAgent) {
    if (msg.state === "questions" && msg.direction === "agent") {
      el.querySelectorAll(".opt").forEach((btn) =>
        btn.addEventListener("click", () => sendReply(msg.id, { optionChosen: decodeURIComponent(btn.dataset.opt) }))
      );
      const imgsFor = () => (pendingImages.get(msg.id) || []).map((p) => ({ path: p }));
      el.querySelector(".approve-btn")?.addEventListener("click", async () => {
        const ta = el.querySelector(".reply-text");
        const text = ta.value;
        ta.value = "";
        try {
          await sendReply(msg.id, { decision: "approved", text, images: imgsFor() });
        } catch {
          ta.value = text;
        }
      });
      const submitReply = async () => {
        const ta = el.querySelector(".reply-text");
        const text = ta.value;
        const imgs = imgsFor();
        if (!text.trim() && !imgs.length) return;
        ta.value = "";
        try {
          await sendReply(msg.id, { decision: "iteration", text, images: imgs });
        } catch {
          ta.value = text;
        }
      };
      el.querySelector(".send-reply").addEventListener("click", submitReply);
      el.querySelector(".reply-text").addEventListener("keydown", (e) => {
        if (submitsOnEnter(e)) {
          e.preventDefault();
          submitReply();
        }
      });
      el.querySelector(".attach-input").addEventListener("change", async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        addPendingImage(msg.id, await uploadFile(file));
      });
      wirePasteToAttach(el.querySelector(".reply-text"), msg.id);
    } else if (msg.state === "questions" && msg.direction === "human") {
      const commentKey = `comment:${msg.id}`;
      const submitComment = () => submitThreadComment(el, ".comment-text", commentKey, msg.title, msg.id);
      el.querySelector(".send-comment").addEventListener("click", submitComment);
      el.querySelector(".comment-text").addEventListener("keydown", (e) => {
        if (submitsOnEnter(e)) {
          e.preventDefault();
          submitComment();
        }
      });
      el.querySelector(".approve-issue-btn")?.addEventListener("click", () => approveIssue(msg));
      wirePasteToAttach(el.querySelector(".comment-text"), commentKey);
    } else if (msg.state === "approbation") {
      el.querySelector(".approve-btn").addEventListener("click", () => {
        if (msg.direction === "agent") sendReply(msg.id, { decision: "approved", text: "", images: [] });
        else approveIssue(msg);
      });
      el.querySelector(".open-overlay-fix").addEventListener("click", (e) => {
        e.stopPropagation();
        openOverlay(msg, el, { focusReply: true, blockedBy: blockedInfo?.blockedBy });
      });
    }
  }
  // Unconditional on awaitingAgent: a closed+Répondu card keeps the archive
  // action too (deriveCompactView's actionsHTML includes it either way).
  if (msg.state === "closed") {
    el.querySelector(".archive-link-btn").addEventListener("click", () => {
      fetchJSON(`/api/messages/${msg.id}/archive`, { method: "POST" }).then(() => refresh(true));
    });
  }
  // Any compact card can receive a dropped image, not just ones with a visible
  // composer — same key the overlay would attach to for this message. Also
  // unconditional: a Répondu card accepts drops again (comment:<id>, like other
  // non-decision cards).
  wireDropToAttach(el, msg.direction === "agent" && agentAwaitingDecision(msg) ? msg.id : `comment:${msg.id}`);

  el.querySelectorAll(".growable-text").forEach((ta) => ta.addEventListener("input", () => autoGrow(ta)));
  el.querySelectorAll(".pending-row").forEach((row) => renderPendingChips(row, row.dataset.pendingKey));

  // Delegated: click-to-open overlay, mini-thumb, cancel — wired regardless of
  // state. Buttons/textareas/inputs already handled their own click above; this
  // only ever fires the overlay open when the click lands on plain card surface
  // (the title row), matching the guard used elsewhere for expand-in-place.
  el.addEventListener("click", (e) => {
    const thumb = e.target.closest(".thumb");
    if (thumb) {
      openLightbox(
        thumb.src,
        msg.direction === "agent" ? msg.id : `comment:${msg.id}`,
        msg.direction === "agent" ? agentAwaitingDecision(msg) : true,
        galleryOf(el)
      );
      return;
    }
    if (e.target.closest(".cancel-sent")) {
      fetch(`/api/messages/${msg.id}`, { method: "DELETE" }).then(() => refresh(true));
      return;
    }
    if (e.target.closest("button, textarea, input, label, a")) return;
    if (String(window.getSelection && window.getSelection())) return;
    openOverlay(msg, el, { blockedBy: blockedInfo?.blockedBy });
  });

  return el;
}

// (compactSig deleted — reconcileSection now signs with JSON.stringify(deriveCompactView(m)))

// ---------------------------------------------------------------------------
// Backlog/Closed collapse rails — click a rail to expand, click the column's
// own collapse arrow to fold it back. Persisted so a reload keeps the choice;
// default (nothing stored yet) is collapsed, per spec.
// ---------------------------------------------------------------------------

const narrowMedia = window.matchMedia("(max-width: 900px)");
// Each column's wide-mode collapse glyph (restored when leaving narrow mode).
const wideCollapseGlyph = { backlog: "‹", closed: "›" };

function isCollapsed(state) {
  try {
    const v = localStorage.getItem(`rb-collapsed-${state}`);
    return v === null ? true : v === "true";
  } catch {
    return true;
  }
}
// Renders the current collapsed state, branching on layout: wide folds the whole
// column down to its rail (as before); narrow keeps the column + its header/count
// and only hides the cards (.folded -> CSS hides .column-scroll), flipping the
// collapse glyph to ▾ (open) / ▸ (folded).
function applyCollapsed(state, collapsed) {
  const col = document.getElementById(`col-${state}`);
  const rail = document.getElementById(`rail-${state}`);
  const glyph = col.querySelector(".column-collapse");
  if (narrowMedia.matches) {
    rail.hidden = true;
    col.hidden = false;
    col.classList.toggle("folded", collapsed);
    if (glyph) glyph.textContent = collapsed ? "▸" : "▾";
  } else {
    col.classList.remove("folded");
    rail.hidden = !collapsed;
    col.hidden = collapsed;
    if (glyph) glyph.textContent = wideCollapseGlyph[state];
  }
}
function setCollapsed(state, collapsed) {
  try {
    localStorage.setItem(`rb-collapsed-${state}`, String(collapsed));
  } catch {}
  applyCollapsed(state, collapsed);
}
["backlog", "closed"].forEach((state) => {
  applyCollapsed(state, isCollapsed(state));
  // Rail click (wide mode only — the rail is hidden in narrow) expands.
  document.getElementById(`rail-${state}`).addEventListener("click", () => setCollapsed(state, false));
  // The whole column header toggles fold/unfold — a lone tiny arrow is too small
  // a target. Toggle (not fold-only) so narrow mode, where the header stays
  // visible while folded, can unfold from the same click.
  const header = document.getElementById(`col-${state}`).querySelector(".column-header");
  header.style.cursor = "pointer";
  header.addEventListener("click", () => setCollapsed(state, !isCollapsed(state)));
});
// Re-apply on crossing the wide/narrow threshold so glyph + fold/rail mechanics
// match the active layout.
narrowMedia.addEventListener("change", () => {
  ["backlog", "closed"].forEach((state) => applyCollapsed(state, isCollapsed(state)));
});

// ---------------------------------------------------------------------------
// Expanded overlay: full card content + sticky footer, animated open from the
// clicked card's rect (FLIP-style), closes on Esc/backdrop, and stays open
// across a refresh — re-rendering in place only when the underlying message
// actually changed (same sig contract as the column cards).
// ---------------------------------------------------------------------------

let openCardId = null;

// (overlayHeader/overlayAgentBody/overlayHumanBody/threadHTML moved to
// public/views.js as deriveOverlayView; overlaySig deleted — reconcileOverlay
// now signs with JSON.stringify(deriveOverlayView(m)))

function wireOverlayMedia(panel, msg) {
  panel.querySelectorAll(".thumb").forEach((img) =>
    img.addEventListener("click", () =>
      openLightbox(
        img.src,
        msg.direction === "agent" ? msg.id : `comment:${msg.id}`,
        msg.direction === "agent" ? agentAwaitingDecision(msg) : true,
        galleryOf(panel)
      )
    )
  );
  panel.querySelectorAll(".thread img").forEach((img) => {
    const src = img.getAttribute("src") || "";
    if (!/^(https?:|data:|\/api\/image)/i.test(src)) img.src = imgSrc(src);
    img.addEventListener("click", (e) => {
      e.stopPropagation();
      openLightbox(img.src, `comment:${msg.id}`, true, galleryOf(panel));
    });
  });
  panel.querySelectorAll(".thread video").forEach((v) => {
    const src = v.getAttribute("src") || "";
    if (src && !/^(https?:|data:|\/api\/image)/i.test(src)) v.src = imgSrc(src);
    v.setAttribute("controls", "");
  });
}

function wireOverlayFooter(panel, msg) {
  if (msg.direction === "agent") {
    if (msg.status === "answered" && !agentAwaitingDecision(msg)) {
      const followupKey = `followup:${msg.id}`;
      const submitFollowup = () => submitThreadComment(panel, ".followup-text", followupKey, msg.title);
      panel.querySelector(".send-followup").addEventListener("click", submitFollowup);
      panel.querySelector(".followup-text").addEventListener("keydown", (e) => {
        if (submitsOnEnter(e)) {
          e.preventDefault();
          submitFollowup();
        }
      });
      wirePasteToAttach(panel.querySelector(".followup-text"), followupKey);
    } else {
      panel.querySelectorAll(".opt").forEach((btn) =>
        btn.addEventListener("click", () => sendReply(msg.id, { optionChosen: decodeURIComponent(btn.dataset.opt) }))
      );
      const imgsFor = () => (pendingImages.get(msg.id) || []).map((p) => ({ path: p }));
      panel.querySelector(".approve-btn")?.addEventListener("click", async () => {
        const ta = panel.querySelector(".reply-text");
        const text = ta.value;
        ta.value = "";
        try {
          await sendReply(msg.id, { decision: "approved", text, images: imgsFor() });
          closeOverlayIfOpen(msg.id);
        } catch {
          ta.value = text;
        }
      });
      const submitReply = async () => {
        const ta = panel.querySelector(".reply-text");
        const text = ta.value;
        const imgs = imgsFor();
        if (!text.trim() && !imgs.length) return;
        ta.value = "";
        try {
          await sendReply(msg.id, { decision: "iteration", text, images: imgs });
          closeOverlayIfOpen(msg.id);
        } catch {
          ta.value = text;
        }
      };
      panel.querySelector(".send-reply").addEventListener("click", submitReply);
      panel.querySelector(".reply-text").addEventListener("keydown", (e) => {
        if (submitsOnEnter(e)) {
          e.preventDefault();
          submitReply();
        }
      });
      panel.querySelector(".attach-input").addEventListener("change", async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        addPendingImage(msg.id, await uploadFile(file));
      });
      wirePasteToAttach(panel.querySelector(".reply-text"), msg.id);
    }
  } else {
    const commentKey = `comment:${msg.id}`;
    const submitComment = () =>
      submitThreadComment(panel, ".comment-text", commentKey, msg.title, msg.id).then(() => closeOverlayIfOpen(msg.id));
    panel.querySelector(".send-comment").addEventListener("click", submitComment);
    panel.querySelector(".comment-text").addEventListener("keydown", (e) => {
      if (submitsOnEnter(e)) {
        e.preventDefault();
        submitComment();
      }
    });
    panel.querySelector(".approve-issue-btn")?.addEventListener("click", () => approveIssue(msg));
    wirePasteToAttach(panel.querySelector(".comment-text"), commentKey);
  }
  panel.querySelectorAll(".pending-row").forEach((row) => renderPendingChips(row, row.dataset.pendingKey));
  panel.querySelectorAll(".growable-text").forEach((ta) => ta.addEventListener("input", () => autoGrow(ta)));
}

// Re-renders the overlay's content from `msg` in place — preserving scroll and
// any unsent draft — and re-wires it. Called both on open and, from refresh(),
// whenever a live update changes the open card's sig.
function renderOverlayBody(msg, blockedBy = []) {
  const panel = document.getElementById("overlayPanel");
  const prevScroll = panel.querySelector(".overlay-scroll");
  const scrollBefore = prevScroll ? prevScroll.scrollTop : 0;
  const prevTa = panel.querySelector("textarea");
  // Keyed to the message the draft belonged to — the panel is a single reused
  // DOM node, so an unkeyed harvest here would leak card A's draft into card
  // B's overlay the moment B opens with A's textarea still sitting in the DOM.
  const sameCardDraft = prevTa && panel.dataset.msgId === String(msg.id) ? prevTa.value : "";

  const view = deriveOverlayView(msg, { blockedBy, pendingCounts: pendingCountsFor(msg.id) });
  panel.innerHTML = `<div class="overlay-scroll">${view.headerHTML}${view.bodyHTML}</div><div class="overlay-footer">${view.footerHTML}</div>`;
  panel.dataset.sig = JSON.stringify(view);
  panel.dataset.msgId = String(msg.id);

  const scrollEl = panel.querySelector(".overlay-scroll");
  if (scrollEl) scrollEl.scrollTop = scrollBefore;
  const ta = panel.querySelector("textarea");
  // Same-card typing wins; otherwise fall back to a draft stranded by a column
  // move into a composer-less card shape (see reconcileSection/pendingDrafts).
  const draft = sameCardDraft || pendingDrafts.get(String(msg.id)) || "";
  if (ta && draft) {
    ta.value = draft;
    autoGrow(ta);
    pendingDrafts.delete(String(msg.id));
  }

  panel.querySelector("#overlayClose").addEventListener("click", closeOverlay);
  panel.querySelector("#overlayArchive")?.addEventListener("click", () => {
    fetchJSON(`/api/messages/${msg.id}/archive`, { method: "POST" }).then(() => {
      closeOverlay();
      refresh(true);
    });
  });
  // The issues the human just typed (if any) become the reopen reason — same
  // box the reply/comment/followup composer already uses, whichever is showing.
  panel.querySelector("#overlayReopen")?.addEventListener("click", () => {
    const note = panel.querySelector("textarea")?.value.trim() || "";
    fetchJSON(`/api/messages/${msg.id}/reopen`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note }),
    }).then(() => {
      closeOverlay();
      refresh(true);
    });
  });
  // BACKLOG-only priority selector (views.js's prioritySelectorHTML) — absent
  // elsewhere, so this just no-ops on other cards. Left open on click (refresh(true)
  // re-renders the panel in place, per refresh()'s openCardId sync) rather than
  // closed, so he can keep triaging without reopening the card each time.
  panel.querySelectorAll(".prio-set").forEach((btn) =>
    btn.addEventListener("click", () => {
      fetchJSON(`/api/messages/${msg.id}/priority`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priority: Number(btn.dataset.priority) }),
      }).then(() => refresh(true));
    })
  );
  wireOverlayFooter(panel, msg);
  wireOverlayMedia(panel, msg);
}

function onOverlayKeydown(e) {
  if (e.key !== "Escape") return;
  // A lightbox opened from inside the overlay stacks on top of it — Esc closes
  // just the lightbox first; a second Esc then closes the overlay itself.
  const lightbox = document.querySelector(".lightbox");
  if (lightbox) {
    lightbox.click();
    return;
  }
  closeOverlay();
}

function openOverlay(msg, cardEl, opts = {}) {
  openCardId = String(msg.id);
  if (unseenActionable(msg)) {
    // Optimistic, same as the old expand-in-place behavior: clear the dot
    // locally so the /seen round-trip doesn't need a rebuild to reflect it.
    msg.threadSeenAt = new Date().toISOString();
    fetchJSON(`/api/messages/${msg.id}/seen`, { method: "POST" }).catch(() => {});
  }
  const backdrop = document.getElementById("overlayBackdrop");
  const panel = document.getElementById("overlayPanel");
  backdrop.hidden = false;
  document.body.classList.add("overlay-open");
  renderOverlayBody(msg, opts.blockedBy || []);

  // FLIP: jump the (now naturally centered) panel back to the clicked card's
  // rect via transform, then transition to identity on the next frame.
  const cardRect = cardEl.getBoundingClientRect();
  panel.style.transition = "none";
  panel.style.transform = "none";
  panel.style.opacity = "1";
  requestAnimationFrame(() => {
    const panelRect = panel.getBoundingClientRect();
    const scaleX = cardRect.width / panelRect.width;
    const scaleY = cardRect.height / panelRect.height;
    const dx = cardRect.left - panelRect.left;
    const dy = cardRect.top - panelRect.top;
    panel.style.transform = `translate(${dx}px, ${dy}px) scale(${scaleX}, ${scaleY})`;
    panel.style.opacity = "0.3";
    requestAnimationFrame(() => {
      panel.style.transition = "transform 0.2s ease, opacity 0.2s ease";
      panel.style.transform = "translate(0, 0) scale(1, 1)";
      panel.style.opacity = "1";
    });
  });

  if (opts.focusReply) {
    setTimeout(() => panel.querySelector(".reply-text, .comment-text")?.focus(), 210);
  }
  document.addEventListener("keydown", onOverlayKeydown);
}

function closeOverlay() {
  openCardId = null;
  document.getElementById("overlayBackdrop").hidden = true;
  document.body.classList.remove("overlay-open");
  document.removeEventListener("keydown", onOverlayKeydown);
}

function closeOverlayIfOpen(id) {
  if (openCardId === String(id)) closeOverlay();
}

document.getElementById("overlayBackdrop").addEventListener("click", (e) => {
  if (e.target.id === "overlayBackdrop") closeOverlay();
});

// The panel node persists across every renderOverlayBody() re-render (only its
// innerHTML is replaced), so wiring this inside wireOverlayFooter would stack a
// fresh drop listener on every re-render. Wire it once here; the key is read
// off whichever composer's pending-row is currently in the footer.
wireDropToAttach(document.getElementById("overlayPanel"), () => document.querySelector("#overlayPanel .pending-row")?.dataset.pendingKey);

// Answered/delivered items (still-queued or already drained into /api/history) are
// shown only when the toggle is on, and always after the live board. Persisted so
// a reload — including the auto-reload-on-new-build below — doesn't silently drop
// back to "History off" out from under you.
let showAnswered = false;
try {
  showAnswered = localStorage.getItem("showAnswered") === "true";
} catch {}
document.getElementById("historyToggle").classList.toggle("active", showAnswered);

// A cheap fingerprint of everything card()/sentCard() render for a message —
// including the pendingImages chips, since those are baked into the card's HTML
// too. Unchanged sig = the existing DOM node is left completely alone (no rebuild,
// no move), which is what keeps a playing <video> playing across a refresh.
// (cardSig/sentSig deleted — reconcileSection now signs History cards with
// JSON.stringify(deriveCardView(m)) / JSON.stringify(deriveSentView(m, true)).
// threadSeenAt is deliberately never in deriveSentView: expanding a card posts
// /seen, and rebuilding the card the user just opened makes it flash — the dot
// is updated optimistically in sentCard's own paint() instead.)

// `force: true` is for explicit user actions (sending a reply, toggling History) —
// those must always re-render, even though the just-submitted textarea still holds
// its text at that instant. Passive callers (SSE, poll, visibility) stay guarded.
// Reconciles one container against its desired card list, keyed by msg id + sig
// (unchanged sig = DOM node untouched) — shared by the 6 board columns and the
// History section alike.
function reconcileSection(containerEl, desired, drafts) {
  const existing = new Map();
  [...containerEl.children].forEach((el) => existing.set(el.dataset.msgId, el));

  let cursor = containerEl.firstChild;
  for (const d of desired) {
    let el = existing.get(d.id);
    if (el) existing.delete(d.id);
    if (!el || el.dataset.sig !== d.sig) {
      const fresh = d.build();
      fresh.dataset.msgId = d.id;
      fresh.dataset.sig = d.sig;
      // Swap in place rather than remove-then-insert — no layout gap, no flash.
      if (el && el.parentNode === containerEl) {
        if (cursor === el) cursor = el.nextSibling;
        el.replaceWith(fresh);
      }
      el = fresh;
    }
    if (cursor !== el) containerEl.insertBefore(el, cursor);
    else cursor = cursor.nextSibling;
  }
  for (const stale of existing.values()) stale.remove();

  for (const [id, value] of Object.entries(drafts)) {
    const t = containerEl.querySelector(`[data-msg-id="${id}"] textarea`);
    if (t && t.value === "") {
      t.value = value;
      autoGrow(t);
      pendingDrafts.delete(id);
    } else if (!t) {
      // This card was rebuilt into a shape with no textarea (e.g. moved to a
      // column whose compact card has no composer) — keep the draft around so
      // it's still recoverable from the overlay, or restored here once the
      // card regains a textarea on a later rebuild.
      pendingDrafts.set(id, value);
    }
  }
}

// Bumped on every refresh() entry; a refresh that finds itself no longer the
// latest after its awaits bails instead of reconciling with stale data.
let refreshToken = 0;

async function refresh(force) {
  // Never rebuild the DOM out from under an open lightbox — a rebuild under an
  // open annotate canvas would lose the drawing reference. Keyed reconciliation
  // plus the draft-harvest below already protect an in-progress typed draft, so
  // that used to be a second skip condition here; it isn't anymore.
  if (force !== true && document.querySelector(".lightbox")) return;

  const myToken = ++refreshToken;
  const [live, history] = await Promise.all([fetchJSON("/api/reviews"), fetchJSON("/api/history")]);
  if (myToken !== refreshToken) return;

  // Stale pendingImages/expandedSent/pendingDrafts entries (msg archived/deleted
  // elsewhere) never get cleaned up on their own — prune anything whose id no
  // longer shows up in either list. "compose" is the one non-msg-id pendingImages key.
  const liveAndHistoryIds = new Set([...live, ...history].map((m) => String(m.id)));
  for (const key of [...pendingImages.keys()]) {
    if (key === "compose") continue;
    const id = key.startsWith("followup:") ? key.slice(9) : key.startsWith("comment:") ? key.slice(8) : key;
    if (!liveAndHistoryIds.has(id)) pendingImages.delete(key);
  }
  for (const id of [...expandedSent]) {
    if (!liveAndHistoryIds.has(id)) expandedSent.delete(id);
  }
  for (const id of [...pendingDrafts.keys()]) {
    if (!liveAndHistoryIds.has(id)) pendingDrafts.delete(id);
  }
  pruneViewCache(liveAndHistoryIds);

  // Every live card that belongs on the board carries a kanban `state` (a
  // replyTo human message is a thread-reply delivery vehicle and has none).
  const byState = {};
  for (const s of COLUMN_STATES) byState[s] = [];
  for (const m of live) if (byState[m.state]) byState[m.state].push(m);
  for (const s of COLUMN_STATES) byState[s].reverse(); // newest first
  // Priority (0 first, absent = 2) is a stable sort on top of newest-first, in
  // every column — applied before the backlog-only taskKind sort below so that
  // sort's grouping remains the FIRST key (stable sort preserves this order
  // within each group). `?? 2`, not `|| 2`: priority 0 (P0/critical) is falsy
  // but a real, valid value — `|| 2` would silently normal-ize it.
  for (const s of COLUMN_STATES) byState[s].sort((a, b) => (a.priority ?? 2) - (b.priority ?? 2));
  // Within Backlog: feedback, then change-request, then projet (stable sort
  // keeps the priority/newest-first order within each group).
  const BACKLOG_RANK = { feedback: 0, "change-request": 1 };
  byState.backlog.sort((a, b) => (BACKLOG_RANK[a.taskKind] ?? 2) - (BACKLOG_RANK[b.taskKind] ?? 2));

  // Archived stuff only (store.history()) — a still-live card, however settled-
  // looking (status "answered" sitting in an unfinished state, e.g. re-asked via
  // move_task after an earlier reply), already has its column on the live board
  // above and would otherwise show up twice.
  let historyDesired = [];
  if (showAnswered) {
    const answered = [
      ...history.filter((m) => m.direction === "agent"),
      ...history.filter((m) => m.direction === "human" && !m.replyTo),
    ];
    const sortKey = (m) => m.deliveredAt || (m.reply && m.reply.at) || m.createdAt;
    answered.sort((a, b) => (sortKey(b) > sortKey(a) ? 1 : sortKey(b) < sortKey(a) ? -1 : 0));
    historyDesired = answered.map((m) =>
      m.direction === "agent"
        ? { id: String(m.id), sig: JSON.stringify(deriveCardView(m, { pendingCounts: pendingCountsFor(m.id) })), build: () => card(m) }
        : {
            id: String(m.id),
            sig: JSON.stringify(deriveSentView(m, true, { pendingCounts: pendingCountsFor(m.id) })),
            build: () => sentCard(m, true),
          }
    );
  }

  // Carry unsent drafts across a rebuild (only rebuilt cards lose their textarea —
  // an untouched card keeps its draft simply by not being touched): harvest by
  // card msg id, restore after reconciling.
  const drafts = {};
  document.querySelectorAll("#board [data-msg-id] textarea, #cardsHistory [data-msg-id] textarea").forEach((t) => {
    const holder = t.closest("[data-msg-id]");
    if (t.value !== "") drafts[holder.dataset.msgId] = t.value;
  });
  // Anything stranded by an earlier tick's rebuild (no textarea to land in at
  // the time) rides along too, so it keeps getting retried until one reappears.
  for (const [id, value] of pendingDrafts) {
    if (!(id in drafts)) drafts[id] = value;
  }

  // A card rebuilt/inserted/removed above the viewport shifts every card below
  // it, dragging the scroll position along even though the card the user is
  // reading was never touched — restore it, unless focus moved (e.g. a submit
  // scrolled a new element into view on purpose).
  const scrollY = window.scrollY;
  const focusBefore = document.activeElement;

  for (const s of COLUMN_STATES) {
    const container = document.getElementById(`cards-${s}`);
    const toDesired = (m) => {
      const blockedInfo = { blockedBy: activeBlockers(m, live), pendingCounts: pendingCountsFor(m.id) };
      return { id: String(m.id), sig: JSON.stringify(deriveCompactView(m, blockedInfo)), build: () => compactCard(m, blockedInfo) };
    };
    // Répondu subsection: his word is the latest event, the agent hasn't reacted
    // yet. Split preserves each list's existing order (newest-first, priority,
    // then — backlog only — taskKind), just partitions it in two.
    const activeMsgs = byState[s].filter((m) => !awaitingAgent(m));
    const answeredMsgs = byState[s].filter((m) => awaitingAgent(m));
    const desired = activeMsgs.map(toDesired);
    reconcileSection(container, desired, drafts);
    container.classList.toggle("empty", desired.length === 0);
    document.getElementById(`col-${s}`).classList.toggle("empty-col", desired.length === 0 && answeredMsgs.length === 0);
    // The column-count pill and rail count show the TOTAL (active + Répondu) —
    // the Répondu divider's own count below stays scoped to just that list.
    const totalCount = desired.length + answeredMsgs.length;
    const countText = totalCount > 0 ? String(totalCount) : "";
    document.getElementById(`count-${s}`).textContent = countText;
    const railCount = document.getElementById(`railcount-${s}`);
    if (railCount) railCount.textContent = countText;

    const answeredDesired = answeredMsgs.map(toDesired);
    reconcileSection(document.getElementById(`cards-answered-${s}`), answeredDesired, drafts);
    document.getElementById(`answered-${s}`).hidden = answeredDesired.length === 0;
    document.getElementById(`answered-count-${s}`).textContent = answeredDesired.length > 0 ? String(answeredDesired.length) : "";
  }

  reconcileSection(document.getElementById("cardsHistory"), historyDesired, drafts);

  if (document.activeElement === focusBefore) window.scrollTo(0, scrollY);

  document.getElementById("blockHistory").classList.toggle("hidden", showAnswered && historyDesired.length === 0);
  document.getElementById("historyHint").hidden = showAnswered;

  // Keep an open overlay in sync with the live message it's showing — re-render
  // only on an actual content change (sig), same contract as the column cards.
  if (openCardId) {
    const openMsg = live.find((m) => String(m.id) === openCardId) || history.find((m) => String(m.id) === openCardId);
    if (!openMsg) {
      closeOverlay();
    } else {
      const panel = document.getElementById("overlayPanel");
      const openBlockedBy = activeBlockers(openMsg, live);
      const openOpts = { blockedBy: openBlockedBy, pendingCounts: pendingCountsFor(openMsg.id) };
      if (panel.dataset.sig !== JSON.stringify(deriveOverlayView(openMsg, openOpts))) renderOverlayBody(openMsg, openBlockedBy);
    }
  }
}

function toggleHistory() {
  showAnswered = !showAnswered;
  document.getElementById("historyToggle").classList.toggle("active", showAnswered);
  try {
    localStorage.setItem("showAnswered", String(showAnswered));
  } catch {}
  refresh(true);
}
document.getElementById("historyToggle").addEventListener("click", toggleHistory);
document.getElementById("historyHint").addEventListener("click", toggleHistory);

function renderComposeChips() {
  renderPendingChips(document.getElementById("composeChips"), "compose");
}

document.getElementById("composeText").addEventListener("input", (e) => autoGrow(e.target));
document.getElementById("composeText").addEventListener("keydown", (e) => {
  if (submitsOnEnter(e)) {
    e.preventDefault();
    document.getElementById("compose").requestSubmit();
  }
});
wirePasteToAttach(document.getElementById("composeText"), "compose");
wireDropToAttach(document.querySelector("header"), "compose");

document.getElementById("compose").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("composeText");
  const button = e.target.querySelector("button");
  const text = input.value.trim();
  const imgs = (pendingImages.get("compose") || []).map((p) => ({ path: p }));
  if (!text && imgs.length === 0) return;
  await fetchJSON("/api/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, images: imgs }),
  });
  input.value = "";
  autoGrow(input);
  pendingImages.delete("compose");
  renderComposeChips();
  const original = button.textContent;
  button.textContent = "Sent ✓";
  setTimeout(() => (button.textContent = original), 1200);
});

// iOS Safari (and any backgrounded tab) can pause/drop the SSE connection silently;
// refresh on every (re)connect too, not just on a push, so a missed event while
// disconnected doesn't leave the page stale until the next unrelated change.
const stream = new EventSource("/api/events");
stream.addEventListener("open", refresh);
stream.addEventListener("message", refresh);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refresh();
});
refresh();

// A page left open runs whatever JS it loaded — a server restart (new code) never
// reaches it on its own. Piggyback the same triggers refresh() already uses to
// check for a new build and reload before rendering with stale logic.
let buildId = null;
async function checkForNewBuild() {
  const { buildId: current } = await fetchJSON("/api/build-id");
  if (buildId === null) buildId = current;
  else if (current !== buildId) location.reload();
}
stream.addEventListener("open", checkForNewBuild);
stream.addEventListener("message", checkForNewBuild);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") checkForNewBuild();
});
checkForNewBuild();

// Belt-and-braces: if the SSE stream silently dies (observed in the always-visible
// Electron window), nothing above ever fires again — poll as a last-resort sync.
setInterval(() => {
  refresh();
  checkForNewBuild();
}, 10000);

// Push notifications: needs a secure context (HTTPS, or localhost) — a plain
// http://<ip> page can't register a service worker at all, so the button just
// explains that instead of silently doing nothing.
function urlBase64ToUint8Array(base64) {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

// alert() is unreliable inside an installed standalone PWA on Android — write
// status into the page itself instead so it's actually visible.
function setNotifyStatus(msg) {
  const el = document.getElementById("notifyStatus");
  el.textContent = msg;
  el.hidden = !msg;
}

// Register (and thus update-check) the service worker on every load, not just when
// enabling notifications — otherwise it only ever refreshes on the rare occasion
// someone clicks the button again, and a stale worker silently misbehaves.
let swRegistration = null;
if ("serviceWorker" in navigator && window.isSecureContext) {
  swRegistration = navigator.serviceWorker.register("/sw.js");
} else {
  setNotifyStatus(
    `Notifications unavailable on this page: ${window.isSecureContext ? "" : "not HTTPS"}${!window.isSecureContext && !("serviceWorker" in navigator) ? ", " : ""}${"serviceWorker" in navigator ? "" : "no service worker support"}. Origin: ${location.origin}`
  );
}

async function enableNotifications() {
  if (!window.isSecureContext || !("serviceWorker" in navigator) || !("PushManager" in window)) {
    setNotifyStatus("Push notifications need HTTPS — open the board through the Tailscale https:// URL, not the IP.");
    return;
  }
  try {
    setNotifyStatus("Enabling…");
    const reg = await swRegistration;
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setNotifyStatus(`Notification permission: ${permission}. Allow notifications for this site in your browser settings and try again.`);
      return;
    }
    const { publicKey } = await fetchJSON("/api/push-public-key");
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    await fetchJSON("/api/push-subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sub),
    });
    setNotifyStatus("Notifications enabled ✓");
  } catch (err) {
    setNotifyStatus(`Couldn't enable notifications: ${err.message}`);
    return;
  }
  document.getElementById("notifyToggle").classList.add("active");
}

document.getElementById("notifyToggle").addEventListener("click", enableNotifications);

if (window.isSecureContext && "serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistration().then(async (reg) => {
    const sub = reg && (await reg.pushManager.getSubscription());
    if (sub) document.getElementById("notifyToggle").classList.add("active");
  });
}
