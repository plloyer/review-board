# Spec 6: agent mark, two-line card, new palette (personal board commit b87c04b)

Mirror on the Hub port. lifecycle.js is untouched; a new shared module carries the vendor table.

## Behavior

- New card field `agent: { vendor, model, effort? }`. `vendor` is one of `claude`, `codex`, `antigravity`; `model` is a non-empty trimmed string; `effort` is optional.
- `move_task` takes an optional `agent`. Inside `store.moveTask`, under `actor === "agent"`, entering `in_progress` throws `agentRequiredText(id)` when neither the call nor the card carries an agent. The check sits after the retro gate and before any mutation. The human route stays ungated.
- `reply_to_message` takes an optional `agent` (hand-over); `store.agentReply` stores it when present.
- Blockers are validated before any mutation in `moveTask` (`assignBlockers` result held in a local, applied after the state change) so a bad `blocked_by` leaves the card untouched.
- Entering `backlog` (move or `reopen`) deletes `msg.agent`. Other states keep the last declaration.
- Tools version bumped (personal board: v5). Handshake instructions and WORKFLOW.md state the rule and the hand-over path.
- `shared/agents.js` (IIFE, `module.exports` / `window.Agents`): `AGENT_VENDORS = { claude: { icon, label: "Claude" }, codex: { icon, label: "Codex" }, antigravity: { icon, label: "Antigravity" } }` and `agentRequiredText(id)`. The zod enum is `z.enum(Object.keys(AGENT_VENDORS))`.

## Visual

- Compact card, line 1: priority pill (class `chip chip-prio chip-pN`, 22px wide, centered, `padding: 1px 0`) then title, then the MCR chip if any, then thumb / cancel / marker. The colored dot is gone from compact cards (overlay header keeps it).
- Line 2 (`.ccard-sub`): `position: relative; padding-left: 30px`, 2-line clamp on the element itself. The agent mark is `<span class="agent-mark" title="Claude · Fable 5.1&#10;Effort : max"><img src="agents/claude.svg" alt="Claude"></span>`, absolutely positioned at `left: 0; top: 0`, 22x15, img 14x14. Rendered only when the card has a known vendor; the sub line renders when there is sub text, a source chip or a mark.
- Tooltip is the native `title`: line 1 `<Label> · <model>`, line 2 `Effort : <effort>` when present.
- Priority pills: P0 `#d67070` on `#2a1212`, P1 `#d79e62` on `#2a1a08`, P2 `#cfb96a` on `#2a2308`, P3 `#77ae89` on `#0f2417`. Same pairs on the overlay priority selector.
- Column card tints: backlog `#1e1f22` / border `#2e2f33`; in_progress `#1b242f` / `#2b3a4b`; questions `#2c2519` / `#4a3d17`; approbation `#1c2921` / `#3a5a3a`; landing `#25202d` / `#3a2f4d`; closed `#191a1c` / `#2a2b2e` with opacity .9.

## Overlay (phone fix, same commit series)

- The overlay header is rendered inside `.overlay-scroll`, so the whole card scrolls, description included. `.overlay-head` gets `flex-wrap: wrap` and `margin: -16px -18px 16px` to keep its edge-to-edge border inside the padded scroll area; `.overlay-title-wrap` gets `flex-basis: 100%; order: 1` so pills and buttons form the first row and the title plus description take the full width below; `.overlay-close { margin-left: auto }`.
- `.overlay-scroll { overscroll-behavior: contain }` and `body.overlay-open { overflow: hidden }` (class toggled by openOverlay / closeOverlay) so a touch scroll never reaches the page behind.

## Assets

`public/agents/claude.svg` (Wikimedia Commons Claude symbol, fill `hsl(14.8, 63.1%, 59.6%)`), `public/agents/codex.png` (ChatGPT mark, 48px, pre-tinted `#ebebeb` on alpha), `public/agents/antigravity.png` (Google press-page icon, 48px, full color). These are third-party trademarks: fine on a personal board, check before shipping them inside the Hub.

## Tests (personal board, 199 green)

store: agent stored by moveTask/agentReply; in_progress gate with and without a stored agent; human never gated; bad blocked_by leaves the card untouched; backlog/reopen drop the agent. mcp: missing agent refused with the instructive text, unknown vendor and blank model rejected without touching the card, re-entry without agent allowed, reply_to_message hand-over. views: agent mark HTML and tooltip, unknown/prototype vendor draws nothing, no `dot` on compact views, `chip-prio` class, `agent` in the fingerprint mutation table.
