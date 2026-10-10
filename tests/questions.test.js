"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Questions = require("../shared/questions");
const valid = "Question : Valides-tu cet affichage ?\nA : Garder cet affichage.\nB : Garder le précédent.\nRecommandation : Je recommande A pour sa lisibilité.\nConséquence : Le prochain écran utilise cet affichage.";

test("one owner decision retains explicit choices, recommendation and consequence", () => {
  const result = Questions.requireDecision(valid);
  assert.equal(result.question, "Valides-tu cet affichage ?");
  assert.equal(result.options.length, 2);
  assert.match(result.consequence, /prochain écran/);
});

test("missing, two decisions and technical progress cannot enter Questions", () => {
  for (const text of ["Je compare les deux erreurs.", valid.replace("Valides-tu cet affichage ?", "Valides-tu cet affichage ? Autorises-tu cette dépense ?"),
    valid.replace("Valides-tu cet affichage ?", "Le traitement est-il encore en cours ?"),
    valid.replace("Valides-tu cet affichage ?", "Valides-tu cet affichage et autorises-tu cette dépense ?")]) {
    assert.throws(() => Questions.requireDecision(text), /OWNER DECISION REQUIRED/);
  }
});

test("the existing text/options API stays usable for a single owner approval", () => {
  const result = Questions.requireDecision("Je recommande OUI.", ["OUI", "NON"], "On accepte cet affichage ?");
  assert.equal(result.legacy, true);
  assert.equal(result.consequence, "");
});

test("a later owner answer makes a previous question historical", () => {
  const msg = { direction: "human", thread: [{ from: "agent", kind: "question", text: valid }, { from: "human", text: "A" }] };
  assert.equal(Questions.latest(msg), null);
});

module.exports.validQuestion = valid;

test("review probes: technical adjectives, bundled choices and Details cannot invent decisions", () => {
  for (const question of ["Le test de hash est-il valide ?", "Is the build acceptable after the rerun ?",
    "Valides-tu le texte ainsi que le nouveau cadre et la couleur ?", "Valides-tu le texte, tu choisis aussi le cadre ?"]) {
    assert.throws(() => Questions.requireDecision(valid.replace("Valides-tu cet affichage ?", question)), /OWNER DECISION REQUIRED/);
  }
  const notesAsChoices = "Question : Valides-tu cet affichage ?\nRecommandation : Garder cet affichage.\nConséquence : La partie utilise cet affichage.\nDétails :\na. relancé le test\nb. capture refaite";
  assert.throws(() => Questions.requireDecision(notesAsChoices), /distinct possible answers/);
});

test("review probes: common French owner choices are accepted without keyword adjectives", () => {
  for (const question of ["On publie la nouvelle version sur Steam ce soir ?", "Veux-tu qu'on lance la partie à trois ce soir ?", "Quel cadre mettre autour des portraits ?"]) {
    assert.equal(Questions.requireDecision(valid.replace("Valides-tu cet affichage ?", question)).question, question);
  }
});

test("known closure counterexamples cannot bundle a second decision", () => {
  for (const question of ["Valides-tu le texte; tu choisis le cadre ?", "Valides-tu le texte / choisis-tu le cadre ?",
    "Valides-tu le texte plus le cadre ?", "Valides-tu le texte également le cadre ?"]) {
    assert.throws(() => Questions.requireDecision(valid.replace("Valides-tu cet affichage ?", question)), /OWNER DECISION REQUIRED/);
  }
  assert.equal(Questions.requireDecision(valid.replace("Valides-tu cet affichage ?", "Veux-tu plus de contraste ?")).question, "Veux-tu plus de contraste ?");
});
