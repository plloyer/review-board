"use strict";
const fs = require("fs");
const path = require("path");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { z } = require("zod");
const store = require("./store");
const { activeBlockers, extractPathRefs } = require("../shared/lifecycle");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// await_replies polls every 500ms and re-reads the same screenshots each time; memoize
// by path+mtime so an unchanged file is only base64-encoded once.
const IMAGE_CACHE_MAX = 50;
const imageCache = new Map();

function imageBlock(imgPath) {
  try {
    const key = `${imgPath}:${fs.statSync(imgPath).mtimeMs}`;
    const cached = imageCache.get(key);
    if (cached) return cached;
    const ext = path.extname(imgPath).slice(1).toLowerCase() || "png";
    const mimeType = `image/${ext === "jpg" ? "jpeg" : ext}`;
    const block = { type: "image", data: fs.readFileSync(imgPath).toString("base64"), mimeType };
    if (imageCache.size >= IMAGE_CACHE_MAX) imageCache.clear(); // ponytail: full-clear instead of real LRU
    imageCache.set(key, block);
    return block;
  } catch {
    return null;
  }
}

// Uploaded files are stored as "<timestamp>-<original name>"; hand the agent back
// the original name — the human names files exactly as the agent asked, so the
// name is part of the message.
function originalName(p) {
  return path.basename(p).replace(/^\d{10,}-/, "");
}

function pushImages(blocks, images) {
  for (const img of images || []) {
    const block = imageBlock(img.path);
    if (!block) continue;
    blocks.push({ type: "text", text: `attached image: ${originalName(img.path)}` });
    blocks.push(block);
  }
}

function formatDelivered(items) {
  const blocks = [];
  for (const m of items) {
    if (m.unblockNotice) {
      blocks.push({ type: "text", text: `[${m.id}] débloquée : ses bloqueurs sont fermés` });
      continue;
    }
    if (m.direction === "human") {
      blocks.push({ type: "text", text: `[${m.id}] the human sent you a message: ${m.title}` });
      pushImages(blocks, m.images);
      continue;
    }
    const chosen = m.reply.optionChosen ? ` (chose: "${m.reply.optionChosen}")` : "";
    const decision = m.reply.decision ? ` [decision: ${m.reply.decision}]` : "";
    blocks.push({ type: "text", text: `[${m.id}] reply to "${m.title}"${chosen}${decision}: ${m.reply.text}` });
    pushImages(blocks, m.reply.images);
  }
  return blocks;
}

// Shared by every tool that can set a card's priority (1 = highest, 3 = lowest,
// absent = normal/2).
const PRIORITY_SCHEMA = z.union([z.literal(1), z.literal(2), z.literal(3)]).optional();

// Attachment validation (live incident: a path unreadable on the board machine
// renders as a broken image/video there, with no signal back to the agent).
// Checked at the MCP tool boundary, before anything is created/replied — the
// store layer itself stays permissive (addAgentMessage keeps a remote-machine
// path verbatim, which is correct for the file itself, just not for a client
// that never uploaded the bytes first).
function attachmentErrorText(missing) {
  return (
    `Not readable on this machine: ${missing.join(", ")}\n` +
    "These paths are not readable on the board machine. POST the bytes first: /api/upload {dataUrl, filename} -> {path}, then attach that path."
  );
}

function missingLocalPaths(messages) {
  const missing = [];
  for (const m of messages) {
    for (const img of m.images || []) if (!fs.existsSync(img.path)) missing.push(img.path);
    for (const vid of m.videos || []) if (!fs.existsSync(vid.path)) missing.push(vid.path);
  }
  return missing;
}

// Same check for a markdown image/video ref embedded in reply text (e.g. proof
// screenshots): a bare local path or an /api/image?path= target must either
// exist here or already sit under our own data dir — an http(s)/data: URL
// never reaches this list (extractPathRefs skips those).
function missingTextRefs(text) {
  return extractPathRefs(text).filter((p) => !fs.existsSync(p) && !store.isUnderDataDir(path.resolve(p)));
}

// Bumped whenever a tool contract changes (new tool, changed schema/behavior).
// Stateless HTTP has no tools/list_changed channel, so the version rides every
// await_replies trailer instead — a session that connected under an older
// version learns from the delivery text that its cached tool list is stale.
const TOOLS_VERSION = "v3";

function buildServer() {
  // The workflow travels with the MCP handshake so every client learns it without
  // needing the repo's WORKFLOW.md (kept in sync with that file, condensed).
  const WORKFLOW_INSTRUCTIONS = [
    `Review-board workflow (tools ${TOOLS_VERSION}). States: backlog -> in_progress -> questions -> approbation -> landing -> closed.`,
    "Loop: await_replies (at-least-once: acknowledge_messages after reading, or items redeliver; ack = READ, never fixed).",
    "Pick work: the human's feedback backlog cards outrank projet tasks. File your own tasks with create_task.",
    "Dependencies: set_blockers / blocked_by on create_task/move_task (blocked until blockers reach landing/closed; you get a \"débloquée\" delivery). Priority: set_priority / priority 1-3 (1 first).",
    "Start a card: move_task in_progress. Blocked on the human: reply_to_message kind question (auto-moves to questions). Progress notes: kind update (silent).",
    "Done with real proof (markdown images ![p](/api/image?path=<enc>)): reply_to_message kind done (auto-moves to approbation).",
    "Moving to landing/closed requires the human's approval unless the task was created no_review (create_task no_review: true).",
    "Proof files must be readable by the BOARD's machine. Running elsewhere? First POST the bytes: /api/upload {dataUrl, filename} -> {path}, then reference THAT path. A path from your own disk renders as a broken image on his board.",
    "He approves -> merge -> move_task landing. Fix present in the build he runs -> close_issue. Never closed before it is in his build; never close what he has not approved.",
    "He refuses -> the card returns to in_progress; iterate.",
    "Board bug or missing tool? request_change — never patch the board yourself.",
  ].join("\n");

  const server = new McpServer(
    { name: "review-board", version: "1.0.0" },
    { capabilities: { logging: {} }, instructions: WORKFLOW_INSTRUCTIONS }
  );

  server.registerTool(
    "send_message",
    {
      description:
        "Queue one or more messages on the human's local review board — a review to look at (attach screenshots via `images` and/or a short clip via `videos` so they can see what it looks like/plays like), a blocking question, or an FYI note. Non-blocking; returns the ids assigned.",
      inputSchema: {
        messages: z
          .array(
            z.object({
              title: z.string().describe("Required. For a question, ask it here."),
              kind: z.enum(["review", "question", "note"]).default("review"),
              options: z.array(z.string()).max(8).optional().describe("One-click answers for a question."),
              context: z.string().optional().describe("One line of context."),
              details: z.array(z.string()).optional().describe("Bullet points."),
              images: z.array(z.object({ path: z.string() })).optional().describe("Absolute local file paths."),
              videos: z.array(z.object({ path: z.string() })).optional().describe("Absolute local video file paths (mp4/webm) — a gameplay/before-after clip."),
              project: z.string().optional(),
            })
          )
          .min(1),
      },
    },
    async ({ messages }) => {
      const missing = missingLocalPaths(messages);
      if (missing.length) return { isError: true, content: [{ type: "text", text: attachmentErrorText(missing) }] };
      const created = messages.map((m) => store.addAgentMessage(m));
      return { content: [{ type: "text", text: created.map((m) => m.id).join(", ") }] };
    }
  );

  server.registerTool(
    "await_replies",
    {
      description:
        "Block until the human replies to a queued message, or sends a new message of their own. Returns everything currently deliverable (replies + human messages). Delivery is at-least-once: items stay queued and will be returned again on every call until you confirm receipt with acknowledge_messages(ids). Never lose data to a dropped response again.",
      inputSchema: {
        timeoutSeconds: z.number().min(1).max(240).default(120),
      },
    },
    async ({ timeoutSeconds }) => {
      const deadline = Date.now() + timeoutSeconds * 1000;
      while (Date.now() < deadline) {
        const delivered = store.peekDeliverable();
        if (delivered.length > 0) {
          const ids = delivered.map((m) => m.id).join(", ");
          return {
            content: [
              ...formatDelivered(delivered),
              {
                type: "text",
                text: `IMPORTANT: after you have read and acted on these, call acknowledge_messages with ids [${ids}] — until you do, they will be re-delivered on every await_replies/check. For a human message, acknowledging only marks it read (it stays on their board until they archive it); once you've fixed what they raised, call reply_to_message to tell them it's resolved. [board tools ${TOOLS_VERSION} — if your session connected under an older version, your cached tool list is stale: reconnect the review-board MCP server to pick up new tools]`,
              },
            ],
          };
        }
        await sleep(500);
      }
      return { content: [{ type: "text", text: "Nothing yet" }] };
    }
  );

  server.registerTool(
    "list_messages",
    {
      description:
        "List the current queue, with direction/kind/status. Read-only: reading a human message here does NOT clear it — after acting on it, call acknowledge_messages (or drain via await_replies), or it stays stuck on the human's board as \"waiting\".",
      inputSchema: {},
    },
    async () => {
      const live = store.list();
      const rows = live.map((m) => {
        let row = `[${m.id}] ${m.direction}/${m.kind}/${m.status}/${m.state || "-"}: ${m.title}`;
        if (m.priority === 1 || m.priority === 3) row += ` p${m.priority}`;
        // Only the still-active blockers, matching what the board itself shows
        // (a landed/closed blocker no longer counts, even if still listed in
        // blockedBy).
        const active = activeBlockers(m, live);
        if (active.length) row += ` blocked_by: ${active.join(",")}`;
        return row;
      });
      return { content: [{ type: "text", text: rows.length ? rows.join("\n") : "Queue is empty" }] };
    }
  );

  server.registerTool(
    "recent_history",
    {
      description:
        "Re-fetch the full content (text + images) of everything delivered by await_replies in the last N minutes. Use this if a previous await_replies call seems to have dropped its response (e.g. after a timeout or error) — the human's message isn't lost, it's already in history; this hands it back to you. Replays everything delivered to ANY client in the window.",
      inputSchema: { minutes: z.number().min(1).max(1440).default(30) },
    },
    async ({ minutes }) => {
      const cutoff = Date.now() - minutes * 60 * 1000;
      const fromHistory = store.history().filter((m) => {
        // A message the human dismissed without an agent ever having received it
        // (archivedAt but no lastDeliveredAt) must not surface here as if it were live.
        if (m.archivedAt && !m.lastDeliveredAt) return false;
        return m.deliveredAt && new Date(m.deliveredAt).getTime() >= cutoff;
      });
      // A delivered item stays on the live board now that ack keeps cards around
      // (only archive/withdraw removes them) — scan store.list() too, or a card
      // still sitting in its column would look like it was never delivered.
      const fromLive = store.list().filter((m) => m.lastDeliveredAt && new Date(m.lastDeliveredAt).getTime() >= cutoff);
      const seen = new Set();
      const recent = [];
      for (const m of [...fromHistory, ...fromLive]) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        recent.push(m);
      }
      if (recent.length === 0) return { content: [{ type: "text", text: "Nothing delivered in that window" }] };
      return { content: formatDelivered(recent) };
    }
  );

  server.registerTool(
    "withdraw_messages",
    {
      description: "Retire messages you solved yourself, so they stop waiting on the human.",
      inputSchema: { ids: z.array(z.string()).min(1) },
    },
    async ({ ids }) => {
      const removed = store.withdraw(ids);
      return { content: [{ type: "text", text: `Withdrew ${removed} message(s)` }] };
    }
  );

  server.registerTool(
    "acknowledge_messages",
    {
      description:
        "Confirm receipt of items returned by await_replies (replies AND human messages) after you've read/acted on them. Either way this stops re-delivery: an agent reply retires to history only once its card is closed (or has no kanban state); until then, like a human message, it just stops being re-delivered and stays in its column on the board until archived or closed. Also usable after list_messages. After fixing an issue a human filed, call reply_to_message to tell them it's resolved.",
      inputSchema: { ids: z.array(z.string()).min(1) },
    },
    async ({ ids }) => {
      const acked = store.acknowledge(ids);
      return { content: [{ type: "text", text: `Acknowledged ${acked} message(s)` }] };
    }
  );

  server.registerTool(
    "reply_to_message",
    {
      description:
        "Reply under the human's message/issue on their board (e.g. \"fixed in <sha>\"). This is how you tell the human an issue they filed is resolved — acknowledge_messages only marks it read, it no longer removes it from their board. Kind 'question' also moves the card to state questions; kind 'done' moves it to approbation. Embedded proof images must use a path readable by the board's machine — from another machine, POST /api/upload {dataUrl, filename} first and reference the returned path. When the human has approved AND the fix is delivered, finish with close_issue.",
      inputSchema: {
        id: z.string(),
        text: z.string(),
        kind: z
          .enum(["update", "question", "done"])
          .default("update")
          .describe(
            "kind: 'update' (default) for routine progress notes — silent, no notification; 'question' when you need the human's input to continue — pings them and moves the card to questions; 'done' when the work on this issue is complete and awaits their validation — pings them and moves the card to approbation."
          ),
      },
    },
    async ({ id, text, kind }) => {
      const missing = missingTextRefs(text);
      if (missing.length) return { isError: true, content: [{ type: "text", text: attachmentErrorText(missing) }] };
      store.agentReply(id, text, kind);
      return { content: [{ type: "text", text: `Replied to ${id}` }] };
    }
  );

  server.registerTool(
    "close_issue",
    {
      description:
        "Mark a task as present in the human's current build (state closed). He retests it there and archives it himself — this does NOT remove the card from his board. Never close before the fix is actually delivered in his build. Requires his approval on the card first, unless it was created with no_review. Optional note: a final line recorded in the thread.",
      inputSchema: {
        id: z.string(),
        note: z.string().optional(),
      },
    },
    async ({ id, note }) => {
      // Same gate as move_task — closed is the other road past approbation, and
      // an ungated close_issue would make the move_task gate pointless.
      store.moveTask(id, "closed", note, { actor: "agent" });
      return { content: [{ type: "text", text: `Closed ${id}` }] };
    }
  );

  server.registerTool(
    "create_task",
    {
      description:
        "Add a project task to the human's backlog (state backlog). His feedback cards always outrank project tasks — work feedback first.",
      inputSchema: {
        title: z.string(),
        context: z.string().optional(),
        project: z.string().optional(),
        blocked_by: z.array(z.string()).optional().describe("Ids of cards that must land/close before this one is unblocked."),
        priority: PRIORITY_SCHEMA,
        no_review: z
          .boolean()
          .optional()
          .describe("Marks a task that will not need the human's approval to land/close — it still shows on the board like any other."),
      },
    },
    async ({ title, context, project, blocked_by, priority, no_review }) => {
      const msg = store.createTask({ title, context, project, blockedBy: blocked_by, priority, noReview: no_review });
      return { content: [{ type: "text", text: msg.id }] };
    }
  );

  server.registerTool(
    "move_task",
    {
      description:
        "Move a task through the board: backlog -> in_progress (you started) -> questions (you need the human — prefer asking via reply_to_message kind question, which moves it automatically) -> approbation (done, proof attached, awaiting his approval) -> landing (approved AND merged) -> closed (present in the build he runs). Moving to landing/closed requires the human's approval unless the task was created no_review. Optional note lands in the thread.",
      inputSchema: {
        id: z.string(),
        state: z.enum(store.TASK_STATES),
        note: z.string().optional(),
        blocked_by: z.array(z.string()).optional().describe("Replaces this card's blockers (ids); empty list unblocks."),
        priority: PRIORITY_SCHEMA,
      },
    },
    async ({ id, state, note, blocked_by, priority }) => {
      store.moveTask(id, state, note, { blockedBy: blocked_by, priority, actor: "agent" });
      return { content: [{ type: "text", text: `Moved ${id} to ${state}` }] };
    }
  );

  server.registerTool(
    "set_blockers",
    {
      description: "Replace a card's blockers; empty list unblocks; a card is blocked while any blocker is not landing/closed.",
      inputSchema: {
        id: z.string(),
        blocked_by: z.array(z.string()),
      },
    },
    async ({ id, blocked_by }) => {
      store.setBlockers(id, blocked_by);
      return { content: [{ type: "text", text: `Set blockers for ${id}: [${blocked_by.join(", ")}]` }] };
    }
  );

  server.registerTool(
    "set_priority",
    {
      description: "Set a card's priority: 1 (highest) to 3 (lowest); absent/2 is normal.",
      inputSchema: {
        id: z.string(),
        priority: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      },
    },
    async ({ id, priority }) => {
      store.setPriority(id, priority);
      return { content: [{ type: "text", text: `Set priority for ${id}: ${priority}` }] };
    }
  );

  server.registerTool(
    "request_change",
    {
      description:
        "File a change request about the review board itself (new tool, workflow change, bug in the board). It needs the human's validation before anyone builds it — do not implement board changes yourself.",
      inputSchema: {
        title: z.string(),
        details: z.string().optional(),
      },
    },
    async ({ title, details }) => {
      const msg = store.createChangeRequest({ title, details });
      return { content: [{ type: "text", text: msg.id }] };
    }
  );

  return server;
}

module.exports = { buildServer };
