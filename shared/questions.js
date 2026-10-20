"use strict";
// The write gate and the browser read the same decision; neither invents an owner choice.
(function () {
  const labels = /^(?:\*\*)?(Question|Recommandation|Cons[ée]quence|D[ée]tails)(?:\*\*)?\s*:\s*(.*)$/i;
  const choices = /^\s*(?:[-*]\s*)?([A-H])\s*[:).\u2014-]\s*(\S.*)$/i;
  // A request addressed to the owner; a technical adjective such as "test valide"
  // is not a decision. Unsupported phrasing is refused rather than guessed.
  const ownerAction = /^(?:(?:valides|validez|acceptes|acceptez|approuves|approuvez|autorises|autorisez|choisis|choisissez|préfères|préférez|gardes|gardez|veux|voulez|souhaites|souhaitez)[- ](?:tu|vous)\b|(?:on|nous|tu|vous)\s+(?:valide|validons|accept|approuv|autoris|chois|préf|gard|publi|lanc|utilis)[a-zéèê-]*\b|quel(?:le)?\b.*\b(?:mettre|choisir|garder|retenir|utiliser)\b|(?:do you want|would you like|can we|shall we|should we|keep it|choose|approve|allow|accept|prefer)\b)/i;
  const secondAction = /\b(?:et|puis|ainsi que|aussi|egalement|and|then|also)\b|[;/]|\bplus\s+(?:le|la|les|un|une|des|ce|cet|cette|ces)\b|,\s*(?:tu|vous|on|nous|you|we)\b/i;

  function parse(text, suppliedOptions = [], title = "") {
    // post.py appends proof images after its provenance line. Keep those image
    // paragraphs for presentation without making them part of the decision fields.
    const [unsigned, ...footer] = String(text || "").split(/\r?\nPosted by:[^\r\n]*(?:\r?\n|$)/i);
    const imageLines = [];
    const body = unsigned.replace(/^[\t ]*!\[[^\r\n]*\r?$/gm, (line) => { imageLines.push(line.trim()); return ""; }).trim();
    const attachments = [...imageLines, ...footer.join("\n").split(/\r?\n\s*\r?\n/)
      .filter((paragraph) => paragraph.includes("!["))].join("\n\n").trim();
    const sections = {};
    const introduction = [];
    let current = null;
    for (const line of body.split(/\r?\n/)) {
      const heading = line.match(labels);
      if (heading) {
        current = heading[1].toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        if (sections[current] !== undefined) return { error: "one Question section is required" };
        sections[current] = heading[2];
      } else if (current) sections[current] += "\n" + line;
      else introduction.push(line);
    }
    const explicit = sections.question !== undefined;
    const source = explicit ? sections.question : [title, body].filter(Boolean).join("\n");
    // A dot between digits belongs to a version, not a sentence boundary.
    const candidates = source.split(/\n/).filter((line) => !choices.test(line)).join("\n").match(/(?:[^.!?\n]|\d\.(?=\d))*\?/g) || [];
    const unique = [...new Set(candidates.map((value) => value.trim()))];
    if (unique.length !== 1) return { error: "one precise owner decision is required; progress belongs in En cours" };
    const question = unique[0].replace(/^\[[^\]]+\]\s*/, "");
    const plainQuestion = question.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    if (!ownerAction.test(question) || secondAction.test(plainQuestion)) {
      return { error: "ask one owner choice or approval; investigation and progress belong in En cours" };
    }
    let options = Array.isArray(suppliedOptions) ? suppliedOptions.map(String).filter((value) => value.trim()) : [];
    const answerSource = explicit ? sections.question : body.split(/^(?:\*\*)?D[ée]tails(?:\*\*)?\s*:/im)[0];
    if (!options.length) options = answerSource.split(/\r?\n/).map((line) => line.match(choices)).filter(Boolean).map((match) => `${match[1].toUpperCase()} : ${match[2]}`);
    if (!options.length && /\bOUI\b[\s\S]*\bNON\b|\bNON\b[\s\S]*\bOUI\b/i.test(answerSource)) options = ["OUI", "NON"];
    if (options.length < 2 || options.length > 8 || new Set(options).size !== options.length) return { error: "give two or more distinct possible answers" };
    const recommendedOptions = answerSource.split(/\r?\n/).filter((line) =>
      /^\s*(?:[-*]\s*)?(?:[A-H]|OUI|NON)\s*[:).\u2014-]\s*.*\(\s*recommande(?:e)?\s*\)/i
        .test(line.normalize("NFD").replace(/[\u0300-\u036f]/g, "")));
    const recommendation = (sections.recommandation || (body.match(/(?:Je recommande|Je conseille)[^\n]*/i) || [])[0]
      || (recommendedOptions.length === 1 ? recommendedOptions[0] : "")).trim();
    if (!recommendation) return { error: "give your recommendation" };
    const consequence = (sections.consequence || "").trim();
    if (explicit && !consequence) return { error: "give the consequence of this owner decision" };
    return { question, options, recommendation, consequence, legacy: !explicit,
      explanation: introduction.join("\n").trim(), attachments, details: (sections.details || "").trim() };
  }

  function latest(msg) {
    const thread = msg.thread || [];
    for (let i = thread.length - 1; i >= 0; i--) {
      if (thread[i].from === "human") return null;
      if (thread[i].from === "agent" && thread[i].kind === "question") return { ...parse(thread[i].text), threadIndex: i };
    }
    return msg.direction === "agent" && msg.kind === "question"
      ? { ...parse(msg.context, msg.options, msg.title), threadIndex: -1 } : null;
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
