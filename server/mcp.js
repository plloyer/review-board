"use strict";
const fs = require("fs");
const path = require("path");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { z } = require("zod");
const store = require("./store");

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

function buildServer() {
  // The workflow travels with the MCP handshake so every client learns it without
  // needing the repo's WORKFLOW.md (kept in sync with that file, condensed).
  const WORKFLOW_INSTRUCTIONS = [
    "Review-board workflow. States: backlog -> in_progress -> questions -> approbation -> landing -> closed.",
    "Loop: await_replies (at-least-once: acknowledge_messages after reading, or items redeliver; ack = READ, never fixed).",
    "Pick work: the human's feedback backlog cards outrank projet tasks. File your own tasks with create_task.",
    "Start a card: move_task in_progress. Blocked on the human: reply_to_message kind question (auto-moves to questions). Progress notes: kind update (silent).",
    "Done with real proof (markdown images ![p](/api/image?path=<enc>)): reply_to_message kind done (auto-moves to approbation).",
    "He approves -> merge -> move_task landing. Fix present in the build he runs -> close_issue. Never closed before it is in his build; never close what he has not approved.",
    "He refuses -> the card returns to in_progress; iterate.",
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
                text: `IMPORTANT: after you have read and acted on these, call acknowledge_messages with ids [${ids}] — until you do, they will be re-delivered on every await_replies/check. For a human message, acknowledging only marks it read (it stays on their board until they archive it); once you've fixed what they raised, call reply_to_message to tell them it's resolved.`,
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
      const rows = store.list().map((m) => `[${m.id}] ${m.direction}/${m.kind}/${m.status}/${m.state || "-"}: ${m.title}`);
      return { content: [{ type: "text", text: rows.length ? rows.join("\n") : "Queue is empty" }] };
    }
  );

  server.registerTool(
    "recent_history",
    {
      description:
        "Re-fetch the full content (text + images) of everything delivered by await_replies in the last N minutes. Use this if a previous await_replies call seems to have dropped its response (e.g. after a timeout or error) — the human's message isn't lost, it's already in history; this hands it back to you.",
      inputSchema: { minutes: z.number().min(1).max(1440).default(30) },
    },
    async ({ minutes }) => {
      const cutoff = Date.now() - minutes * 60 * 1000;
      const recent = store.history().filter((m) => {
        // A message the human dismissed without an agent ever having received it
        // (archivedAt but no lastDeliveredAt) must not surface here as if it were live.
        if (m.archivedAt && !m.lastDeliveredAt) return false;
        return m.deliveredAt && new Date(m.deliveredAt).getTime() >= cutoff;
      });
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
        "Reply under the human's message/issue on their board (e.g. \"fixed in <sha>\"). This is how you tell the human an issue they filed is resolved — acknowledge_messages only marks it read, it no longer removes it from their board. Kind 'question' also moves the card to state questions; kind 'done' moves it to approbation. When the human has approved AND the fix is delivered, finish with close_issue.",
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
      store.agentReply(id, text, kind);
      if (kind === "question") store.moveTask(id, "questions");
      else if (kind === "done") store.moveTask(id, "approbation");
      return { content: [{ type: "text", text: `Replied to ${id}` }] };
    }
  );

  server.registerTool(
    "close_issue",
    {
      description:
        "Mark a task as present in the human's current build (state closed). He retests it there and archives it himself — this does NOT remove the card from his board. Never close before the fix is actually delivered in his build. Optional note: a final line recorded in the thread.",
      inputSchema: {
        id: z.string(),
        note: z.string().optional(),
      },
    },
    async ({ id, note }) => {
      store.moveTask(id, "closed", note);
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
      },
    },
    async ({ title, context, project }) => {
      const msg = store.createTask({ title, context, project });
      return { content: [{ type: "text", text: msg.id }] };
    }
  );

  server.registerTool(
    "move_task",
    {
      description:
        "Move a task through the board: backlog -> in_progress (you started) -> questions (you need the human — prefer asking via reply_to_message kind question, which moves it automatically) -> approbation (done, proof attached, awaiting his approval) -> landing (approved AND merged) -> closed (present in the build he runs). Optional note lands in the thread.",
      inputSchema: {
        id: z.string(),
        state: z.enum(store.TASK_STATES),
        note: z.string().optional(),
      },
    },
    async ({ id, state, note }) => {
      store.moveTask(id, state, note);
      return { content: [{ type: "text", text: `Moved ${id} to ${state}` }] };
    }
  );

  return server;
}

module.exports = { buildServer };
