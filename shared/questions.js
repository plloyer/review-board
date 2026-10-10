"use strict";
// The write gate and the browser read the same decision; neither invents an owner choice.
(function () {
  const labels = /^(?:\*\*)?(Question|Recommandation|Cons[ée]quence|D[ée]tails)(?:\*\*)?\s*:\s*(.*)$/i;
  const choices = /^\s*(?:[-*]\s*)?([A-H])\s*[:).\u2014-]\s*(\S.*)$/i;
  const ownerAction = /\b(?:accept|valid|approuv|autoris|chois|pr[ée]f[èe]r|gard)[a-zéèê-]*(?:[- ]tu|[- ]vous)?\b|\b(?:do you want|choose|approve|allow|accept|prefer|shall we|should we)\b/i;
  const secondAction = /\b(?:et|puis|and|then)\s+(?:(?:on|tu|vous|we)\s+)?(?:accept|valid|approuv|autoris|chois|pr[ée]f[èe]r|gard)[a-zéèê-]*\b/i;

  function parse(text, suppliedOptions = [], title = "") {
    const body = String(text || "").replace(/\nPosted by:[\s\S]*$/i, "").trim();
    const sections = {};
    let current = null;
    for (const line of body.split(/\r?\n/)) {
      const heading = line.match(labels);
      if (heading) {
        current = heading[1].toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        if (sections[current] !== undefined) return { error: "one Question section is required" };
        sections[current] = heading[2];
      } else if (current) sections[current] += "\n" + line;
    }
    const explicit = sections.question !== undefined;
    const source = explicit ? sections.question : [title, body].filter(Boolean).join("\n");
    const candidates = source.split(/\n/).filter((line) => !choices.test(line)).join("\n").match(/[^.!?\n]*\?/g) || [];
    const unique = [...new Set(candidates.map((value) => value.trim()))];
    if (unique.length !== 1) return { error: "one precise owner decision is required; progress belongs in En cours" };
    const question = unique[0];
    if (!ownerAction.test(question) || secondAction.test(question)) {
      return { error: "ask one owner choice or approval; investigation and progress belong in En cours" };
    }
    let options = Array.isArray(suppliedOptions) ? suppliedOptions.map(String).filter((value) => value.trim()) : [];
    if (!options.length) options = body.split(/\r?\n/).map((line) => line.match(choices)).filter(Boolean).map((match) => `${match[1].toUpperCase()} : ${match[2]}`);
    if (!options.length && /\bOUI\b[\s\S]*\bNON\b|\bNON\b[\s\S]*\bOUI\b/i.test(body)) options = ["OUI", "NON"];
    if (options.length < 2 || options.length > 8 || new Set(options).size !== options.length) return { error: "give two or more distinct possible answers" };
    const recommendation = (sections.recommandation || (body.match(/(?:Je recommande|Je conseille)[^\n]*/i) || [])[0] || "").trim();
    if (!recommendation) return { error: "give your recommendation" };
    const consequence = (sections.consequence || "").trim();
    if (explicit && !consequence) return { error: "give the consequence of this owner decision" };
    return { question, options, recommendation, consequence, legacy: !explicit };
  }

  function latest(msg) {
    const thread = msg.thread || [];
    for (let i = thread.length - 1; i >= 0; i--) {
      if (thread[i].from === "human") return null;
      if (thread[i].from === "agent" && thread[i].kind === "question") return parse(thread[i].text);
    }
    return msg.direction === "agent" && msg.kind === "question" ? parse(msg.context, msg.options, msg.title) : null;
  }

  function requireDecision(text, options, title) {
    const result = parse(text, options, title);
    if (result.error) throw new Error(`OWNER DECISION REQUIRED: ${result.error}`);
    return result;
  }

  const api = { parse, latest, requireDecision };
  if (typeof module !== "undefined") module.exports = api;
  else window.Questions = api;
})();
