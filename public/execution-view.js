(function () {
"use strict";
const escape = value => String(value ?? "").replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
function render(msg) {
  const execution = msg.execution;
  if (!execution) return "";
  const action = execution.action, denied = execution.denied, consent = execution.consent;
  const chronology = { vote_after_denial: "Le vote est postérieur au refus. Aucun examen de ce vote par le contrôle natif n’est établi.",
    vote_before_denial: "Le vote précède le refus. Sa prise en compte par le contrôle natif reste inconnue.",
    order_unproven: "L’ordre du vote et du refus n’est pas établi." }[execution.chronology] || "";
  const row = (name, value) => `<dt>${escape(name)}</dt><dd>${escape(value)}</dd>`;
  const receipt = event => event ? `${event.at} — ${event.receipt} — ${event.origin} — acteur : ${event.actor || "non attribué"}` : "Non constatée";
  const timeline = (msg.executionTrace?.events || []).map(event => `<li><details><summary>${escape(event.type)} — ${escape(event.at)} — ${escape(event.source)}${event.actionId !== execution.actionId ? " — action remplacée" : ""}</summary><pre>${escape(JSON.stringify(event, null, 2))}</pre></details></li>`).join("");
  const buttons = execution.publication ? "" : `<button class="execution-consent" data-card="${escape(msg.id)}" data-action="${escape(execution.actionId)}" data-decision="${consent?.decision === "approved" ? "rejected" : "approved"}">${consent?.decision === "approved" ? "Retirer mon consentement" : "Donner mon consentement à cette action"}</button>`;
  return `<section class="execution-trace"><strong>Exécution : ${execution.publication ? "publication constatée" : denied ? "refusée" : "à vérifier"}</strong><dl>
    ${row("Action exacte", action.command)}${row("Dossier", action.cwd)}
    ${row("Destination", `${action.destination} — ${action.targetRef}`)}${row("Version", action.version)}
    ${row("Tâche propriétaire", action.threadId)}${row("Effets", action.effects.join("; ") || "Aucun effet supplémentaire déclaré")}
    ${row("Refus", denied ? `${denied.after} à ${denied.before} — ${denied.reason || "Raison indisponible"}` : "Aucun refus enregistré")}
    ${row("Source du refus", denied ? `${denied.reasonSource}; provenance interne : ${denied.provenance}; identifiant natif : ${denied.nativeReviewId || "absent"}` : "Inconnue")}
    ${row("Consentement", consent ? `${consent.decision} — ${consent.at} — ${consent.boardReceipt}` : "Aucun vote lié à cette action")}
    ${row("Publication", receipt(execution.publication))}${row("Activation", receipt(execution.activation))}
    ${row("Profil effectif observé", execution.runtime ? JSON.stringify(execution.runtime) : "Inconnu")}</dl>
    <p>${escape(chronology)} Tentatives après le refus : ${execution.attemptsAfterDenial}.</p>
    <p>${execution.publication ? "Cette version est déjà publiée. Aucune reprise de sa publication n’est proposée." : "Reprise bloquée : le raccord natif supporté n’est pas disponible. Le consentement sur le board ne lève pas ce contrôle."}</p>
    <p>Étape humaine : demander au support produit d’exposer l’approbation de cette action via le board. Le critère « tout input via le board » reste non atteint.</p>
    ${buttons}<details><summary>Journal vérifiable (${(msg.executionTrace?.events || []).length})</summary><ol>${timeline}</ol></details></section>`;
}
function summary(msg) {
  if (!msg.execution) return "";
  const status = msg.execution.activation ? "Activée" : msg.execution.publication ? "Publiée" : msg.execution.denied ? "Exécution refusée" : "Exécution à vérifier";
  return `<span class="execution-status">${escape(status)}${!msg.execution.publication && msg.execution.consent?.decision === "approved" ? " · consentement reçu, reprise bloquée" : ""}</span>`;
}
if (typeof module !== "undefined") module.exports = { render, summary };
else window.ExecutionView = { render, summary };
})();
