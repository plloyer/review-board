"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
global.marked = require("../public/marked.min.js");
const Views = require("../public/views");

const surfaces = {
  card: message => { const view = Views.deriveCardView(message); return view.contextHTML + view.details + view.detailBlocks + view.images; },
  sent: message => { const view = Views.deriveSentView(message, false); return view.contextHTML + view.images + view.thread; },
  overlay: message => Views.deriveOverlayView(message).bodyHTML,
};

test("the latest done text and labeled proof are outside every fold on all expanded approval surfaces", () => {
  for (const direction of ["agent", "human"]) {
    const message = { id: `approval-proof-${direction}`, direction, kind: "review", state: "approbation", status: "open",
      title: "Save window ready", context: "Original description.", images: [{ path: "card-proof.png", label: "Card attachment" }],
      thread: [
        { from: "agent", kind: "done", text: "Previous delivery." },
        { from: "human", text: "Please fix the heading." },
        { from: "agent", kind: "update", text: "Earlier technical note." },
        { from: "agent", kind: "done", text: 'The **save window** is ready for approval.\n\nPosted by: test-host\n\n![After](/api/image?path=done-proof.png "Completed save window")' },
        { from: "agent", kind: "update", text: "Later technical note." },
      ] };
    for (const [surface, render] of Object.entries(surfaces)) {
      const html = render(message);
      // Strip every details block, including log folds, before checking the evidence.
      const visible = html.replace(/<details\b[^>]*>[\s\S]*?<\/details>/g, "");
      assert.match(visible, /The <strong>save window<\/strong> is ready for approval\./, surface);
      assert.match(visible, /<img[^>]*src="\/api\/image\?path=done-proof\.png"/, surface);
      assert.match(visible, /card-proof\.png/, surface);
      assert.match(visible, /<figcaption>After · Completed save window<\/figcaption>/, surface);
      assert.equal((html.match(/done-proof\.png/g) || []).length, 1, surface);
      assert.doesNotMatch(visible, /Previous delivery|Please fix the heading|technical note|Original description|Posted by/, surface);
      assert.doesNotMatch(html, /<details[^>]*\sopen(?:\s|>)/, surface);
      for (const text of ["Previous delivery.", "Please fix the heading.", "Earlier technical note.", "Later technical note.", "Original description."]) assert.ok(html.includes(text), `${surface}: ${text}`);
    }
  }
});

test("approval cards without a done reply and cards in other states retain their ordinary body", () => {
  for (const state of ["in_progress", "approbation", "closed"]) {
    const message = { id: `ordinary-${state}`, direction: "agent", kind: "review", state, status: "open", context: "Review this result.", thread: [] };
    assert.match(Views.deriveOverlayView(message).bodyHTML, /Review this result/);
    assert.doesNotMatch(Views.deriveOverlayView(message).bodyHTML, /owner-approval/);
  }
});
