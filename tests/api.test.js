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
// /api/image's Game Bar captures root hangs off os.homedir() — a temp home keeps
// the tests away from the real ~/Videos/Captures.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "review-board-api-home-"));
process.env.USERPROFILE = home; // os.homedir() on Windows
process.env.HOME = home; // and everywhere else

const { createApp } = require("../server/web");
const store = require("../server/store");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");

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

test("REVIEW_BOARD_ICON and REVIEW_BOARD_TITLE brand the page", async () => {
  const icon = path.join(dir, "brand.png");
  fs.writeFileSync(icon, Buffer.from(TINY_PNG_DATA_URL.split(",")[1], "base64"));
  process.env.REVIEW_BOARD_ICON = icon;
  process.env.REVIEW_BOARD_TITLE = "Three <Crowns>";
  try {
    await withServer(async (base) => {
      const served = Buffer.from(await (await fetch(`${base}/icon.png`)).arrayBuffer());
      assert.deepEqual(served, fs.readFileSync(icon));
      const page = await (await fetch(`${base}/`)).text();
      assert.match(page, /<title>Three &#60;Crowns&#62;<\/title>/);
      assert.match(page, /apple-mobile-web-app-title" content="Three &#60;Crowns&#62;"/);
    });
  } finally {
    delete process.env.REVIEW_BOARD_ICON;
    delete process.env.REVIEW_BOARD_TITLE;
  }
  await withServer(async (base) => {
    assert.match(await (await fetch(`${base}/`)).text(), /<title>Review Board<\/title>/);
  });
});

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

// Old clients send null for an unset name (Python None, Newtonsoft); main fell back to image.png for any falsy name.
test("POST /api/upload treats a null or other falsy filename on an image like a missing one", async () => {
  await withServer(async (base) => {
    for (const filename of [null, "", false, 0]) {
      const res = await fetch(`${base}/api/upload`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dataUrl: TINY_PNG_DATA_URL, filename }),
      });
      assert.equal(res.status, 200, JSON.stringify(filename));
      assert.match(path.basename((await res.json()).path), /^\d{10,}-image(-\d+)?\.png$/);
    }
  });
});

test("GET /api/image 404s on a missing path", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/image?path=${encodeURIComponent(path.join(dir, "nope.png"))}`);
    assert.equal(res.status, 404);
  });
});

test("GET /api/image serves an uploaded file, but 404s on a real, existing file outside the allowed roots", async () => {
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

test("GET /api/image 404s on an image a message references outside the allowed roots (anyone can post that message)", async () => {
  await withServer(async (base) => {
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-board-outside-"));
    const outsideImg = path.join(srcDir, "shot.png");
    fs.writeFileSync(outsideImg, "bytes");
    // A human message never runs ingestFile, so the path stays verbatim — that
    // reference alone used to make /api/image serve any file on the host.
    const msg = await (
      await fetch(`${base}/api/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "see attached", images: [{ path: outsideImg }] }),
      })
    ).json();
    assert.equal(msg.images[0].path, outsideImg);
    const res = await fetch(`${base}/api/image?path=${encodeURIComponent(outsideImg)}`);
    assert.equal(res.status, 404);
  });
});

test("GET /api/image 404s on the push private key and the other non-media files in the data dir", async () => {
  await withServer(async (base) => {
    // push.js wrote vapid-keys.json at require time; make sure the other two exist as well.
    store.addAgentMessage({ title: "persist messages.json" });
    if (!fs.existsSync(path.join(dir, "push-subscriptions.json"))) fs.writeFileSync(path.join(dir, "push-subscriptions.json"), "[]");
    for (const name of ["vapid-keys.json", "messages.json", "push-subscriptions.json"]) {
      const file = path.join(dir, name);
      assert.ok(fs.existsSync(file), name);
      const res = await fetch(`${base}/api/image?path=${encodeURIComponent(file)}`);
      assert.equal(res.status, 404, name);
      assert.equal(await res.text(), "", name);
    }
  });
});

test("GET /api/image 404s on ../ traversal out of uploads, raw or percent-encoded", async () => {
  await withServer(async (base) => {
    const uploads = path.join(dir, "uploads");
    fs.mkdirSync(uploads, { recursive: true });
    // A real image right beside uploads/: the extension alone must not be enough.
    fs.writeFileSync(path.join(dir, "beside-uploads.png"), "png");
    const up = encodeURIComponent(uploads);
    for (const query of [
      `${up}/../vapid-keys.json`,
      `${up}%2F..%2Fvapid-keys.json`,
      `${up}%5C..%5Cvapid-keys.json`,
      `${up}%2F%2e%2e%2Fvapid-keys.json`,
      `${up}%5C%2E%2E%5Cbeside-uploads.png`,
      `${up}%252F..%252Fvapid-keys.json`,
    ]) {
      const res = await fetch(`${base}/api/image?path=${query}`);
      assert.equal(res.status, 404, query);
      assert.equal(await res.text(), "", query);
    }
  });
});

test("GET /api/image answers a NUL byte with a bare 4xx: no path, no stack trace", async () => {
  await withServer(async (base) => {
    const uploads = path.join(dir, "uploads");
    fs.mkdirSync(uploads, { recursive: true });
    fs.writeFileSync(path.join(uploads, "nul.png"), "png");
    for (const query of [
      `${encodeURIComponent(path.join(uploads, "nul.png"))}%00`,
      `${encodeURIComponent(path.join(uploads, "nul"))}%00.png`,
      `${encodeURIComponent(path.join(dir, "vapid-keys.json"))}%00.png`,
    ]) {
      const res = await fetch(`${base}/api/image?path=${query}`);
      assert.ok(res.status >= 400 && res.status < 500, `${query} -> ${res.status}`);
      assert.equal(await res.text(), "", query);
    }
  });
});

test("GET /api/image 404s on an upload whose extension is not plain media (html, svg, txt, none)", async () => {
  await withServer(async (base) => {
    for (const filename of ["page.html", "drawing.svg", "notes.txt", "test"]) {
      const uploaded = await fetch(`${base}/api/upload`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dataUrl: TINY_PNG_DATA_URL, filename }),
      });
      assert.equal(uploaded.status, 200, filename);
      const { path: written } = await uploaded.json();
      assert.ok(fs.existsSync(written), filename);
      const res = await fetch(`${base}/api/image?path=${encodeURIComponent(written)}`);
      assert.equal(res.status, 404, filename);
    }
  });
});

test("GET /api/image still serves an upload byte for byte, whatever the extension's case or the slashes", async () => {
  await withServer(async (base) => {
    for (const filename of ["shot.png", "PHOTO.JPG"]) {
      const uploaded = await fetch(`${base}/api/upload`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dataUrl: TINY_PNG_DATA_URL, filename }),
      });
      const { path: written } = await uploaded.json();
      for (const p of [written, written.split(path.sep).join("/")]) {
        const res = await fetch(`${base}/api/image?path=${encodeURIComponent(p)}`);
        assert.equal(res.status, 200, p);
        assert.deepEqual(Buffer.from(await res.arrayBuffer()), fs.readFileSync(written), p);
      }
    }
  });
});

test("GET /api/image 404s on a file reached through a link inside uploads that points outside it", async () => {
  await withServer(async (base) => {
    const uploads = path.join(dir, "uploads");
    fs.mkdirSync(uploads, { recursive: true });
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "review-board-elsewhere-"));
    fs.writeFileSync(path.join(elsewhere, "secret.png"), "png");
    const link = path.join(uploads, "escape-link");
    fs.symlinkSync(elsewhere, link, "junction"); // a junction needs no admin rights on Windows; a plain dir symlink elsewhere
    const res = await fetch(`${base}/api/image?path=${encodeURIComponent(path.join(link, "secret.png"))}`);
    assert.equal(res.status, 404);
  });
});

test("GET /api/image serves media in the Game Bar captures folder, nothing beside it", async () => {
  await withServer(async (base) => {
    const captures = path.join(home, "Videos", "Captures");
    fs.mkdirSync(captures, { recursive: true });
    const clip = path.join(captures, "Sovereign 2026-09-03 13-37-35.mp4");
    fs.writeFileSync(clip, "mp4");
    fs.writeFileSync(path.join(captures, "notes.txt"), "txt");
    fs.writeFileSync(path.join(home, "Videos", "beside.png"), "png");
    const get = (p) => fetch(`${base}/api/image?path=${encodeURIComponent(p)}`);
    assert.equal((await get(clip)).status, 200);
    assert.equal((await get(path.join(captures, "notes.txt"))).status, 404);
    assert.equal((await get(path.join(home, "Videos", "beside.png"))).status, 404);
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

test("POST /api/messages/:id/reopen sends a closed card back to backlog with the given note; 404s on unknown id", async () => {
  await withServer(async (base) => {
    const unknown = await fetch(`${base}/api/messages/does-not-exist/reopen`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(unknown.status, 404);

    const task = store.createTask({ title: "Do the thing" });
    store.moveTask(task.id, "closed");
    const res = await fetch(`${base}/api/messages/${task.id}/reopen`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "still broken" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.state, "backlog");
    assert.equal(body.thread.at(-1).text, "still broken");
  });
});

test("POST /api/messages/:id/priority sets 0-3, rejects a bad value without changing the stored priority, 404s on unknown id", async () => {
  await withServer(async (base) => {
    const task = store.createTask({ title: "Triage me" });

    for (const p of [0, 1, 2, 3]) {
      const res = await fetch(`${base}/api/messages/${task.id}/priority`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ priority: p }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.priority, p);
    }

    const bad = await fetch(`${base}/api/messages/${task.id}/priority`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ priority: 5 }),
    });
    assert.equal(bad.status, 400);
    assert.equal(store.list().find((m) => m.id === task.id).priority, 3, "bad value must not change the stored priority");

    const unknown = await fetch(`${base}/api/messages/does-not-exist/priority`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ priority: 1 }),
    });
    assert.equal(unknown.status, 404);
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

test("POST /api/upload accepts a video data url and keeps its extension", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/upload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dataUrl: "data:video/mp4;base64,AAAAIGZ0eXBpc29t", filename: "clip.mp4" }),
    });
    assert.equal(res.status, 200);
    const { path: written } = await res.json();
    assert.ok(fs.existsSync(written));
    assert.match(written, /\.mp4$/);
    const noName = await fetch(`${base}/api/upload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dataUrl: "data:video/webm;base64,GkXf" }),
    });
    assert.match((await noName.json()).path, /\.webm$/);
  });
});

test("a multi-MiB .tc upload downloads identical binary bytes with attachment headers", async () => {
  await withServer(async (base) => {
    const bytes = Buffer.alloc(5 * 1024 * 1024 + 1);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    const uploaded = await fetch(`${base}/api/upload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dataUrl: `data:application/octet-stream;base64,${bytes.toString("base64")}`, filename: "player-save.tc" }),
    });
    assert.equal(uploaded.status, 200);
    const result = await uploaded.json();
    assert.deepEqual(fs.readFileSync(result.path), bytes);
    assert.match(result.path, /player-save\.tc$/);
    assert.equal(new URL(result.downloadUrl, base).searchParams.get("path"), result.path);
    const downloaded = await fetch(new URL(result.downloadUrl, base));
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.headers.get("content-type"), "application/octet-stream");
    assert.equal(downloaded.headers.get("content-disposition"), 'attachment; filename="player-save.tc"');
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
  });
});

test("save uploads reject unknown MIME types, wrong/missing filenames and malformed base64", async () => {
  await withServer(async (base) => {
    const before = fs.readdirSync(path.join(dir, "uploads"));
    for (const body of [
      { dataUrl: "data:application/zip;base64,AA==", filename: "save.tc" },
      { dataUrl: "data:application/octet-stream;base64,AA==", filename: "save.bin" },
      { dataUrl: "data:application/octet-stream;base64,AA==" },
      { dataUrl: "data:application/octet-stream;base64,AA==", filename: null },
      { dataUrl: "data:application/octet-stream;base64,AA==", filename: 42 },
      { dataUrl: "data:application/octet-stream;base64,???=", filename: "save.tc" },
      { dataUrl: "data:application/octet-stream;base64,AAA", filename: "save.tc" },
      { dataUrl: "data:application/octet-stream;base64,", filename: "save.tc" },
    ]) {
      const res = await fetch(`${base}/api/upload`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.deepEqual(fs.readdirSync(path.join(dir, "uploads")), before, "rejections must not write files");
  });
});

test("save uploads above the 32 MiB limit return 413 and write nothing", async () => {
  await withServer(async (base) => {
    const before = fs.readdirSync(path.join(dir, "uploads"));
    const bytes = Buffer.alloc(32 * 1024 * 1024 + 1, 0xff);
    const res = await fetch(`${base}/api/upload`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ dataUrl: `data:application/octet-stream;base64,${bytes.toString("base64")}`, filename: "too-big.tc" }),
    });
    assert.equal(res.status, 413);
    assert.deepEqual(fs.readdirSync(path.join(dir, "uploads")), before);
  });
});

test("/api/file blocks traversal, prefix siblings, directories and card-referenced files outside uploads", async () => {
  await withServer(async (base) => {
    const uploads = path.join(dir, "uploads");
    const sibling = path.join(dir, "uploads-other");
    fs.mkdirSync(sibling, { recursive: true });
    const outside = path.join(dir, "outside.tc");
    const siblingFile = path.join(sibling, "outside.tc");
    fs.writeFileSync(outside, "private");
    fs.writeFileSync(siblingFile, "private");
    store.addHumanMessage("a reference is not download authorization", [{ path: outside }]);
    for (const file of [outside, siblingFile, path.join(uploads, "..", "outside.tc"), uploads, path.join(uploads, "missing.tc")]) {
      const res = await fetch(`${base}/api/file?path=${encodeURIComponent(file)}`);
      assert.equal(res.status, 404, file);
    }
    // Keep the traversal literal so path.join doesn't normalize it before the request.
    assert.equal((await fetch(`${base}/api/file?path=${encodeURIComponent(`${uploads}${path.sep}..${path.sep}outside.tc`)}`)).status, 404);
    assert.equal((await fetch(`${base}/api/file`)).status, 404);
    assert.equal((await fetch(`${base}/api/file?path=a&path=b`)).status, 404);
  });
});

test("/api/file refuses a symlink/junction escape from uploads", async () => {
  await withServer(async (base) => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-board-download-outside-"));
    fs.writeFileSync(path.join(outsideDir, "private.tc"), "secret");
    const link = path.join(dir, "uploads", "external-link");
    fs.symlinkSync(outsideDir, link, process.platform === "win32" ? "junction" : "dir");
    const res = await fetch(`${base}/api/file?path=${encodeURIComponent(path.join(link, "private.tc"))}`);
    assert.equal(res.status, 404);
  });
});

test("/api/file downloads only saves and media: a copied-in secret, an html upload or a NUL byte is a bare 4xx", async () => {
  await withServer(async (base) => {
    // send_message's ingestFile copies whatever local path it is handed into uploads/.
    const secret = store.addAgentMessage({ title: "attach", images: [{ path: path.join(dir, "vapid-keys.json") }] }).images[0].path;
    assert.equal(path.dirname(secret), path.join(dir, "uploads"));
    const upload = async (filename) =>
      (
        await (
          await fetch(`${base}/api/upload`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ dataUrl: TINY_PNG_DATA_URL, filename }),
          })
        ).json()
      ).path;
    const page = await upload("page.html");
    const save = path.join(dir, "uploads", "nul-save.tc");
    fs.writeFileSync(save, "save");
    for (const query of [
      encodeURIComponent(secret),
      encodeURIComponent(page),
      `${encodeURIComponent(save)}%00`,
      `${encodeURIComponent(path.join(dir, "uploads", "nul-save"))}%00.tc`,
    ]) {
      const res = await fetch(`${base}/api/file?path=${query}`);
      assert.ok(res.status >= 400 && res.status < 500, `${query} -> ${res.status}`);
      assert.equal(await res.text(), "", query);
    }
    // Every upload's downloadUrl points here, so media still downloads.
    const shot = await upload("shot.png");
    const res = await fetch(`${base}/api/file?path=${encodeURIComponent(shot)}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-disposition"), 'attachment; filename="shot.png"');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), fs.readFileSync(shot));
  });
});

test("upload sanitizes filenames before storing and returning a usable download link", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/upload`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ dataUrl: "data:application/octet-stream;base64,AP8=", filename: '../player "save".tc' }),
    });
    assert.equal(res.status, 200);
    const uploaded = await res.json();
    assert.equal(path.dirname(uploaded.path), path.join(dir, "uploads"));
    assert.match(path.basename(uploaded.path), /^[a-zA-Z0-9._-]+\.tc$/);
    assert.equal((await fetch(new URL(uploaded.downloadUrl, base))).status, 200);
  });
});

for (const endpoint of ["/mcp", "/mcp-live"]) {
  test(`create_task over HTTP ${endpoint} creates feedback and retains the projet default`, async () => {
    await withServer(async (base) => {
      const client = new Client({ name: "feedback-http-test", version: "1" });
      await client.connect(new StreamableHTTPClientTransport(new URL(endpoint, base)));
      try {
        const context = "Loading day 42 crashes. [Save](/api/file?path=example.tc)";
        const result = await client.callTool({ name: "create_task", arguments: { title: "Player bug", context, taskKind: "feedback" } });
        assert.notEqual(result.isError, true, result.content[0].text);
        const cards = await (await fetch(`${base}/api/reviews`)).json();
        const card = cards.find((m) => m.id === result.content[0].text);
        assert.equal(card.taskKind, "feedback");
        assert.equal(card.state, "backlog");
        assert.equal(card.direction, "human");
        assert.equal(card.context, context);
        const project = await client.callTool({ name: "create_task", arguments: { title: "Default project" } });
        assert.equal(store.list().find((m) => m.id === project.content[0].text).taskKind, "projet");
        const count = store.list().length;
        const invalid = await client.callTool({ name: "create_task", arguments: { title: "Invalid", taskKind: "unknown" } });
        assert.equal(invalid.isError, true);
        assert.equal(store.list().length, count);
      } finally {
        await client.close();
      }
    });
  });
}

test("HTTP Questions move requires an actual decision and serves the shared contract", async () => {
  const task = store.addHumanMessage("HTTP investigation", []);
  await withServer(async (base) => {
    const before = JSON.stringify(store.list());
    const response = await fetch(`${base}/api/messages/${task.id}/move`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state: "questions", note: "Je compare les erreurs." }) });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /OWNER DECISION REQUIRED/);
    assert.equal(JSON.stringify(store.list()), before);
    const contract = await fetch(`${base}/shared/questions.js`);
    assert.equal(contract.status, 200);
    assert.match(await contract.text(), /requireDecision/);
    const accepted = await fetch(`${base}/api/messages/${task.id}/move`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state: "questions", note: "Question : Valides-tu cet affichage ?\nA : Garder cet affichage.\nB : Garder le précédent.\nRecommandation : A pour sa lisibilité.\nConséquence : Le prochain écran utilise cet affichage." }) });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).state, "questions");
  });
});
