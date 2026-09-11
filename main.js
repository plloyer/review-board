"use strict";
const { app, BrowserWindow, Notification, screen, nativeImage, clipboard, Menu } = require("electron");
const path = require("path");
const fs = require("fs");
const url = require("url");
const { createApp } = require("./server/web");
const store = require("./server/store");
const push = require("./server/push");
const { isActionableThreadEntry, unseenActionable } = require("./shared/lifecycle");

// Local-only debugging: lets a CDP client attach to inspect the renderer.
app.commandLine.appendSwitch("remote-debugging-port", "9222");

// Without an explicit AppUserModelID, Windows groups the window under plain
// electron.exe and shows the generic Electron icon in the taskbar.
app.setAppUserModelId("com.ployer.review-board");

const PORT = 5677;

function startServer() {
  const web = createApp({ clipboard });

  const notify = (title, body, tag) => {
    if (Notification.isSupported()) new Notification({ title, body }).show();
    push.notifyAll(title, body, tag).catch((err) => console.error("push error:", err));
  };

  const notifiedIds = new Set();
  let lastThreadNotifiedAt = new Date().toISOString();
  store.events.on("change", () => {
    const open = store.list().filter((m) => m.direction === "agent" && m.status === "open");
    const openIds = new Set(open.map((m) => m.id));
    for (const id of notifiedIds) if (!openIds.has(id)) notifiedIds.delete(id); // bound memory
    for (const m of open) {
      if (notifiedIds.has(m.id)) continue;
      notifiedIds.add(m.id);
      notify("Review board", m.title, m.id);
    }
    // An AI reply landing under one of the human's issues pings only when it's
    // actually actionable (a question, or work done and awaiting validation).
    for (const m of store.list()) {
      if (m.direction !== "human" || !(m.thread || []).length) continue;
      const last = m.thread[m.thread.length - 1];
      if (isActionableThreadEntry(last) && last.at > lastThreadNotifiedAt) {
        lastThreadNotifiedAt = last.at;
        const title = last.kind === "question" ? "Review board — l'IA a besoin de toi" : "Review board — travail terminé";
        notify(title, String(last.text || "").split("\n")[0], m.id);
      }
    }
  });

  // Bind to all interfaces so phone/iPad on the same LAN can reach it too.
  // ponytail: no auth — fine on a home LAN, not something to expose past it.
  web.listen(PORT, "0.0.0.0", () => console.log(`Review board listening on http://localhost:${PORT}`));
}

const BOUNDS_FILE = path.join(__dirname, "data", "window-bounds.json");

function loadBounds() {
  try {
    return JSON.parse(fs.readFileSync(BOUNDS_FILE, "utf8"));
  } catch {
    return null;
  }
}

// A saved position can land off-screen if a monitor got unplugged/reconfigured;
// fall back to the default size (centered) rather than open somewhere unreachable.
function boundsOnAnyDisplay(bounds) {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return (
      bounds.x < a.x + a.width && bounds.x + bounds.width > a.x && bounds.y < a.y + a.height && bounds.y + bounds.height > a.y
    );
  });
}

// Yellow-dot taskbar badge (Windows overlay icon) shown while anything on the
// board waits on the human — the visual "something to validate" hint.
const BADGE = nativeImage.createFromDataURL(
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAADfUlEQVR4AcSWQUhUURSG/xmFILJo4RC4iGhR7SLa1Gi5kqxRgqCiFi2CqNC2QmGLpMBtRkXQokVRQRA6ZbiydGoT0a5aRLQQYlpEGYGgM53vvnefT0ebGX3QcM895557zv//7/ruw7T+869uAZ1tau7KqjPXpp7uNvVjxOTYq/d5ahLQ3q5GI+rpatNko1RUWs9T0lBZuoIRk2OPGmrpqUVMVQGANc1pyoiGDDBrVm1kqaWH3mrFywro2KuMPc0IYAaSMYvGji3SgT3SsY7AiMlFBUGQoRcMsIJU5bykgO6stq1J66WV58zcaGmWzhyRHlyVBi9I549KJzsDIybHHjXUuqZgyoEFZrBcOFcIQG05padKabvCH09666KUa5XWrQ2TSzj2qKGWnqjEsMAEO8qFQYWANQ26GyfvOxU8ZVhfs+N06I0aTITDjhJBsEBA+NJExw5AdmdQuJKZXjBivbmQI0pFArg29tL0+x2OEAC/XqkHAyzfDwdcfh0JWD+ns5Z0bzsvEUdo60QGWGCGYJmQyy0jAabsuMvYdGifTQmPOGacywkIP6FZz9m+y0fJ+UWY2ZDTPqDG0VjSbnNu8EHhOrlFghOYYHtIz+lOoJzWVr+xeZOPkvdxbM/pBNi00dNtaPJR8j6O7TnNJ09UD6ITUJJ++Kaf0z5K3sexPacTkCrps6f7+s1Hyfs4tud0AmbTeuvpPnyRfv/xq+Q8mGB7RM/pBIxO6LttFMzcGH/nXKLTIsxCyBl8B2Cyf6se4rFnr5iTtThmnMudAFS/GnTbfNFMU3Ye90eJkjGwwAzRiiGXW0YCxsc1a8oGXNamR2NS4b0FqxxggOVh4IDLryMBJIYndMN83syNwXurEwE5GA4smPIhR7CyeYEAW2tmTqdV1kdiDACOkLgeo4feqMcwHXaUCIIKAWOvVUyVdTgugiM8d03KT/77inLVqKGWHvmfkYMJtk95XyGAjeGCPs2UtN/i6M/BS3TniXTiktR3Xbr5WOIpMWJy7FFDrfX6kQcLTJ+I+yUFUIDakQl12UvTa2t3O8y7wQflxRuJp8SIybnN+alILxhgzacXRssK8GW8NNMNagHMcgWzaqNALT30ViuuKgAArg1g9jSts1JGJR20f6t6jegyRkyOPWqopYfealaTgDgIn9CRgkbzdmWNaAAjJsdevJa4mv0FAAD//2Oe5xsAAAAGSURBVAMALCQoUFX0aooAAAAASUVORK5CYII="
);

let mainWin = null;

function updateBadge() {
  if (!mainWin || mainWin.isDestroyed()) return;
  // Something waits on the human: a new agent item, or an unseen actionable
  // (question/done) AI reply under one of their issues. A routine "update"
  // entry never lights the badge.
  const pending = store
    .list()
    .some((m) => (m.direction === "agent" && m.status === "open") || (m.direction === "human" && unseenActionable(m)));
  if (pending) mainWin.setOverlayIcon(BADGE, "Items waiting for review");
  else mainWin.setOverlayIcon(null, "");
}

store.events.on("change", updateBadge);

// Best-guess filename for a download: the ?path= query param's basename (our
// /api/image?path=... URLs), falling back to whatever Electron derived.
function downloadFilename(srcURL, fallback) {
  try {
    const parsed = new url.URL(srcURL);
    const p = parsed.searchParams.get("path");
    if (p) return path.basename(p);
  } catch {}
  return fallback;
}

function dedupedPath(dir, name) {
  let candidate = path.join(dir, name);
  if (!fs.existsSync(candidate)) return candidate;
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let n = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base}-${n}${ext}`);
    n++;
  }
  return candidate;
}

function setupDownloads(win) {
  win.webContents.on("context-menu", (_event, params) => {
    if (params.mediaType !== "image" && params.mediaType !== "video") return;
    const template = [];
    if (params.mediaType === "image") {
      template.push({
        label: "Copy",
        click: () => win.webContents.copyImageAt(params.x, params.y),
      });
    }
    template.push({
      label: "Download",
      click: () => win.webContents.downloadURL(params.srcURL),
    });
    Menu.buildFromTemplate(template).popup();
  });

  win.webContents.session.on("will-download", (_event, item) => {
    const name = downloadFilename(item.getURL(), item.getFilename());
    item.setSavePath(dedupedPath(app.getPath("downloads"), name));
  });
}

function createWindow() {
  const saved = loadBounds();
  const bounds = saved && boundsOnAnyDisplay(saved) ? saved : { width: 1100, height: 800 };
  const win = new BrowserWindow({ ...bounds, title: "Review Board", icon: path.join(__dirname, "public", "icon.ico") });
  mainWin = win;
  setupDownloads(win);
  win.loadURL(`http://localhost:${PORT}/`);
  win.webContents.once("did-finish-load", updateBadge);
  // The window and the HTTP server start concurrently; if the first load races
  // ahead of listen() it fails with connection-refused and stays blank forever.
  // Retry until the server answers.
  win.webContents.on("did-fail-load", () => {
    setTimeout(() => win.loadURL(`http://localhost:${PORT}/`), 500);
  });

  let saveTimer = null;
  const persistBounds = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      fs.mkdirSync(path.dirname(BOUNDS_FILE), { recursive: true });
      fs.writeFileSync(BOUNDS_FILE, JSON.stringify(win.getBounds()));
    }, 300);
  };
  win.on("resize", persistBounds);
  win.on("move", persistBounds);
}

// Single-instance: a second launch focuses the existing window instead of crashing on EADDRINUSE.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    startServer();
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
