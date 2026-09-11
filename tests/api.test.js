"use strict";
// Spins server/web.js's express app directly (no Electron — main.js requires
// electron and can't be loaded here) against an ephemeral port. Sets
// REVIEW_BOARD_DATA_DIR to a temp dir BEFORE requiring anything under server/
// so store.js and push.js (VAPID keys, subscriptions) never touch real data/.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-board-api-test-"));
process.env.REVIEW_BOARD_DATA_DIR = dir;
process.env.REVIEW_BOARD_NO_SUMMARY = "1"; // never spawn the summarizer CLI in tests

const { createApp } = require("../server/web");
const store = require("../server/store");

// 1x1 transparent PNG.
const TINY_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function withServer(fn, opts) {
  const app = createApp(opts);
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("POST /api/messages requires text or images", async () => {
  await withServer(async (base) => {
    const empty = await fetch(`${base}/api/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(empty.status, 400);

    const ok = await fetch(`${base}/api/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.ok(body.id.startsWith("u"));
  });
});

test("GET /api/reviews lists messages", async () => {
  await withServer(async (base) => {
    store.addAgentMessage({ title: "Review this" });
    const res = await fetch(`${base}/api/reviews`);
    assert.equal(res.status, 200);
    const list = await res.json();
    assert.ok(list.some((m) => m.title === "Review this"));
  });
});

test("POST /api/reviews/:id/reply 404s on unknown id, succeeds on a real id", async () => {
  await withServer(async (base) => {
    const unknown = await fetch(`${base}/api/reviews/does-not-exist/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x" }),
    });
    assert.equal(unknown.status, 404);

    const msg = store.addAgentMessage({ title: "Review this too" });
    const real = await fetch(`${base}/api/reviews/${msg.id}/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "approved" }),
    });
    assert.equal(real.status, 200);
    const body = await real.json();
    assert.equal(body.status, "answered");
  });
});

test("POST /api/upload rejects a non-dataUrl body and writes a file for a valid tiny png", async () => {
  await withServer(async (base) => {
    const bad = await fetch(`${base}/api/upload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dataUrl: "not-a-data-url" }),
    });
    assert.equal(bad.status, 400);

    const good = await fetch(`${base}/api/upload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dataUrl: TINY_PNG_DATA_URL, filename: "test.png" }),
    });
    assert.equal(good.status, 200);
    const { path: written } = await good.json();
    assert.ok(fs.existsSync(written));
  });
});

test("GET /api/image 404s on a missing path", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/image?path=${encodeURIComponent(path.join(dir, "nope.png"))}`);
    assert.equal(res.status, 404);
  });
});

test("GET /api/image serves a file under the data dir (an uploaded one), but 404s on a real, existing file outside it and not referenced by any message", async () => {
  await withServer(async (base) => {
    const uploaded = await fetch(`${base}/api/upload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dataUrl: TINY_PNG_DATA_URL, filename: "disclosure.png" }),
    });
    const { path: uploadedPath } = await uploaded.json();
    const ok = await fetch(`${base}/api/image?path=${encodeURIComponent(uploadedPath)}`);
    assert.equal(ok.status, 200);

    // package.json exists on disk, is not under the data dir, and isn't referenced by
    // any message — must not be disclosed.
    const outside = path.join(__dirname, "..", "package.json");
    assert.ok(fs.existsSync(outside));
    const blocked = await fetch(`${base}/api/image?path=${encodeURIComponent(outside)}`);
    assert.equal(blocked.status, 404);
  });
});

test("GET /api/image serves a path referenced by a message's images even when outside the data dir", async () => {
  await withServer(async (base) => {
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-board-outside-"));
    const outsideImg = path.join(srcDir, "shot.png");
    fs.writeFileSync(outsideImg, "bytes");
    // A remote-machine path stays verbatim (ingestFile only copies locally-reachable
    // files) — but this one IS locally reachable, so give it a fake unreachable stand-in
    // by referencing it directly on a human message instead, which never runs ingestFile.
    const msg = await (
      await fetch(`${base}/api/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "see attached", images: [{ path: outsideImg }] }),
      })
    ).json();
    assert.equal(msg.images[0].path, outsideImg);
    const res = await fetch(`${base}/api/image?path=${encodeURIComponent(outsideImg)}`);
    assert.equal(res.status, 200);
  });
});

test("DELETE /api/messages/:id refuses to cancel an agent message", async () => {
  await withServer(async (base) => {
    const agentMsg = store.addAgentMessage({ title: "Review this" });
    const res = await fetch(`${base}/api/messages/${agentMsg.id}`, { method: "DELETE" });
    assert.equal(res.status, 400);
    assert.ok(store.list().some((m) => m.id === agentMsg.id), "agent message must survive the DELETE attempt");
  });
});

test("DELETE /api/messages/:id cancels a human message", async () => {
  await withServer(async (base) => {
    const created = await (
      await fetch(`${base}/api/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "withdraw me" }),
      })
    ).json();
    const res = await fetch(`${base}/api/messages/${created.id}`, { method: "DELETE" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.removed, 1);
  });
});

test("GET and DELETE /mcp-live return 405 (the stateful session machinery is gone; POST still works as an alias of /mcp)", async () => {
  await withServer(async (base) => {
    const get = await fetch(`${base}/mcp-live`);
    assert.equal(get.status, 405);
    const del = await fetch(`${base}/mcp-live`, { method: "DELETE" });
    assert.equal(del.status, 405);
  });
});

test("GET /api/clipboard-image returns 204 when the injected clipboard stub is empty", async () => {
  const emptyClipboard = { readImage: () => ({ isEmpty: () => true }) };
  await withServer(
    async (base) => {
      const res = await fetch(`${base}/api/clipboard-image`);
      assert.equal(res.status, 204);
    },
    { clipboard: emptyClipboard }
  );
});

test("GET /api/clipboard-image rejects a loopback request that carries forwarding headers (a reverse proxy)", async () => {
  const clipboard = { readImage: () => ({ isEmpty: () => true }) };
  await withServer(
    async (base) => {
      const viaXff = await fetch(`${base}/api/clipboard-image`, { headers: { "x-forwarded-for": "1.2.3.4" } });
      assert.equal(viaXff.status, 403);
      const viaXfh = await fetch(`${base}/api/clipboard-image`, { headers: { "x-forwarded-host": "evil.example" } });
      assert.equal(viaXfh.status, 403);
      const viaVia = await fetch(`${base}/api/clipboard-image`, { headers: { via: "1.1 proxy" } });
      assert.equal(viaVia.status, 403);
    },
    { clipboard }
  );
});
