"use strict";
// Real Markdown renderer: prove the uploaded image becomes an image element,
// rather than merely finding its URL in escaped or collapsed reply text.
const test = require("node:test"), assert = require("node:assert/strict");
global.marked = require("../public/marked.min.js");
const Views = require("../public/views");
const decision = "Question : Valides-tu cet affichage ?\nA : Garder cet affichage.\nB : Garder le précédent.\nRecommandation : A pour sa lisibilité.\nConséquence : Le prochain écran utilise cet affichage.";
const explanation = "The **save window** now keeps its heading above the list.";
const proof = '![After](/api/image?path=active-proof.png "The save window")';
const question = `${explanation}\n\n${decision}\n\nPosted by: test-host\n\n${proof}`;
const surfaces = {
  card: (message) => Views.deriveCardView(message).contextHTML,
  sent: (message) => Views.deriveSentView(message, false).contextHTML,
  overlay: (message) => Views.deriveOverlayView(message).bodyHTML,
};

function checkVisibleQuestion(html) {
  const fold = html.indexOf('<details class="question-details">');
  assert.ok(fold > 0);
  const visible = html.slice(0, fold), history = html.slice(fold);
  const heading = visible.indexOf("<h3>Question</h3>");
  assert.ok(visible.indexOf("The <strong>save window</strong>") >= 0);
  assert.ok(visible.indexOf("The <strong>save window</strong>") < heading);
  assert.match(visible, /<img class="embedded-image" src="\/api\/image\?path=active-proof\.png" alt="After" title="The save window">/);
  assert.ok(visible.indexOf('alt="After"') > visible.indexOf("Conséquence"));
  assert.match(visible, /<figcaption>After · The save window<\/figcaption>/);
  assert.equal((html.match(/active-proof\.png/g) || []).length, 1);
  assert.doesNotMatch(history, /The <strong>save window<\/strong>|active-proof\.png/);
  assert.match(visible, /data-opt=/);
  assert.match(visible, /Recommandation/);
  assert.match(visible, /Conséquence/);
  assert.doesNotMatch(visible, /Posted by/);
  assert.doesNotMatch(html, /<details class="question-details" open/);
  return { visible, history };
}

test("the active reply's explanation precedes Question and its labeled images follow Consequence on every expanded surface", () => {
  for (const direction of ["human", "agent"]) {
    const message = { id: `active-context-${direction}`, direction, kind: "question", state: "questions", status: "open",
      context: "Original card description.", images: [{ path: "card-proof.png", label: "Card attachment" }],
      thread: [
        { from: "agent", kind: "question", text: `Old explanation.\n\n${decision}` },
        { from: "human", text: "Which window?" },
        { from: "agent", kind: "question", text: question },
        { from: "agent", kind: "update", text: "Later technical note." },
      ] };
    for (const render of Object.values(surfaces)) {
      const { visible, history } = checkVisibleQuestion(render(message));
      assert.match(visible, /card-proof\.png/);
      assert.ok(visible.indexOf("card-proof.png") > visible.indexOf("Conséquence"));
      assert.match(visible, /<figcaption>Card attachment<\/figcaption>/);
      assert.doesNotMatch(visible, /Old explanation|Which window|Later technical note|Original card description/);
      for (const text of ["Old explanation.", "Which window?", "Later technical note.", "Original card description."]) assert.ok(history.includes(text));
    }
  }
});

test("an agent's root question shows its context once and preserves older replies", () => {
  const message = { id: "root-context", direction: "agent", kind: "question", state: "questions", status: "open",
    context: question, thread: [{ from: "agent", kind: "update", text: "Older technical note." }] };
  for (const render of Object.values(surfaces)) {
    const { history } = checkVisibleQuestion(render(message));
    assert.match(history, /Older technical note/);
  }
});

test("an owner answer and non-Questions state keep the ordinary full thread", () => {
  for (const state of ["questions", "in_progress"]) {
    const message = { id: `answered-context-${state}`, direction: "human", state, context: "Card description.",
      thread: [{ from: "agent", kind: "question", text: question }, { from: "human", text: "A" }] };
    const html = Views.deriveOverlayView(message).bodyHTML;
    assert.doesNotMatch(html, /class="owner-decision"/);
    assert.match(html, /active-proof\.png/);
    assert.match(html, /The <strong>save window<\/strong>/);
  }
});

test("a board.py root question excludes leading and trailing provenance from visible context", () => {
  for (const newline of ["\n", "\r\n"]) {
    const message = { id: "signed-root-context", direction: "agent", kind: "question", state: "questions", status: "open",
      context: `Posted by: leading-host\n\n${question}`.replace(/\n/g, newline), thread: [] };
    for (const render of Object.values(surfaces)) checkVisibleQuestion(render(message));
  }
});

test("a legacy reply shows its decision fields once without treating them as explanation", () => {
  const message = { id: "legacy-reply-context", direction: "human", state: "questions", status: "open",
    context: "Original card description.", thread: [{ from: "agent", kind: "question",
      text: `Intro.\nValides-tu cet affichage ?\nA : Oui\nB : Non\nJe recommande A.\n\nPosted by: test-host\n\n${proof}` }] };
  for (const render of Object.values(surfaces)) {
    const html = render(message), fold = html.indexOf('<details class="question-details">');
    assert.ok(fold > 0);
    const visible = html.slice(0, fold);
    assert.equal((visible.match(/Valides-tu cet affichage/g) || []).length, 1);
    assert.equal((visible.match(/Je recommande A\./g) || []).length, 1);
    assert.equal((visible.match(/data-opt=/g) || []).length, 2);
    assert.doesNotMatch(visible, /Intro\.|Posted by|<p>A : Oui|<p>B : Non/);
    assert.match(visible, /<img class="embedded-image"/);
    assert.ok(visible.indexOf('alt="After"') > visible.indexOf("Conséquence"));
  }
});

test("the legacy root text/options API shows its recommendation once", () => {
  const message = { id: "legacy-root-context", direction: "agent", kind: "question", state: "questions", status: "open",
    title: "On accepte cet affichage ?", context: "Je recommande OUI.", options: ["OUI", "NON"], thread: [] };
  for (const render of Object.values(surfaces)) {
    const html = render(message), fold = html.indexOf('<details class="question-details">');
    assert.ok(fold > 0);
    const visible = html.slice(0, fold);
    assert.equal((visible.match(/On accepte cet affichage/g) || []).length, 1);
    assert.equal((visible.match(/Je recommande OUI\./g) || []).length, 1);
    assert.equal((visible.match(/data-opt=/g) || []).length, 2);
    assert.doesNotMatch(visible, /class="question-context"/);
  }
});
