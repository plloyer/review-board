"use strict";
// Single owner of "who works a card": the vendor ids the MCP accepts and the
// icon/label the board draws for each. Loads unmodified in Node (server/) and
// in the browser (public/views.js via window.Agents), same IIFE reasoning as
// shared/lifecycle.js.
(function () {
const AGENT_VENDORS = {
  claude: { icon: "agents/claude.svg", label: "Claude" },
  codex: { icon: "agents/codex.png", label: "Codex" },
  antigravity: { icon: "agents/antigravity.png", label: "Antigravity" },
};

function agentRequiredText(id) {
  const vendors = Object.keys(AGENT_VENDORS)
    .map((v) => `"${v}"`)
    .join("|");
  return `${id} cannot enter in_progress without agent: {vendor: ${vendors}, model: "<your model>", effort: "<your effort setting, optional>"} so the board shows who is working the card`;
}

const Agents = { AGENT_VENDORS, agentRequiredText };

if (typeof module !== "undefined") module.exports = Agents;
else window.Agents = Agents;
})();
