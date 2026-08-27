"use strict";
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { z } = require("zod");
const store = require("./store");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDelivered(items) {
  return items
    .map((m) => {
      if (m.direction === "human") return `[${m.id}] the human sent you a message: ${m.title}`;
      const chosen = m.reply.optionChosen ? ` (chose: "${m.reply.optionChosen}")` : "";
      return `[${m.id}] reply to "${m.title}"${chosen}: ${m.reply.text}`;
    })
    .join("\n");
}

function buildServer() {
  const server = new McpServer({ name: "review-board", version: "1.0.0" });

  server.registerTool(
    "send_message",
    {
      description:
        "Queue one or more messages on the human's local review board (a review to look at, a blocking question, or an FYI note). Non-blocking; returns the ids assigned.",
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
        "Block until the human replies to a queued message, or sends a new message of their own. Returns everything delivered since the last call. Times out with 'Nothing yet' — call again to keep waiting.",
      inputSchema: {
        timeoutSeconds: z.number().min(1).max(240).default(120),
      },
    },
    async ({ timeoutSeconds }) => {
      const deadline = Date.now() + timeoutSeconds * 1000;
      while (Date.now() < deadline) {
        const delivered = store.drainDelivered();
        if (delivered.length > 0) {
          return { content: [{ type: "text", text: formatDelivered(delivered) }] };
        }
        await sleep(500);
      }
      return { content: [{ type: "text", text: "Nothing yet" }] };
    }
  );

  server.registerTool(
    "list_messages",
    { description: "List the current queue, with direction/kind/status.", inputSchema: {} },
    async () => {
      const rows = store.list().map((m) => `[${m.id}] ${m.direction}/${m.kind}/${m.status}: ${m.title}`);
      return { content: [{ type: "text", text: rows.length ? rows.join("\n") : "Queue is empty" }] };
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

  return server;
}

module.exports = { buildServer };
