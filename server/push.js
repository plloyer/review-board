"use strict";
const fs = require("fs");
const path = require("path");
const webpush = require("web-push");

const DATA_DIR = process.env.REVIEW_BOARD_DATA_DIR || path.join(__dirname, "..", "data");
const KEYS_FILE = path.join(DATA_DIR, "vapid-keys.json");
const SUBS_FILE = path.join(DATA_DIR, "push-subscriptions.json");

function loadOrCreateKeys() {
  try {
    return JSON.parse(fs.readFileSync(KEYS_FILE, "utf8"));
  } catch {
    const keys = webpush.generateVAPIDKeys();
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2));
    return keys;
  }
}

const keys = loadOrCreateKeys();
webpush.setVapidDetails("mailto:pierreluc.loyer@unity3d.com", keys.publicKey, keys.privateKey);

function loadSubs() {
  try {
    return JSON.parse(fs.readFileSync(SUBS_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveSubs(subs) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2));
}

function addSubscription(sub) {
  const subs = loadSubs().filter((s) => s.endpoint !== sub.endpoint);
  subs.push(sub);
  saveSubs(subs);
}

async function sendToAll(payloadObj) {
  const subs = loadSubs();
  if (subs.length === 0) return;
  const payload = JSON.stringify(payloadObj);
  const stillValid = [];
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, payload);
      stillValid.push(sub);
    } catch (err) {
      // 404/410 = the subscription expired or was revoked on the device; drop it.
      const expired = err.statusCode === 404 || err.statusCode === 410;
      console.error(`push send failed (${err.statusCode}): ${err.body || err.message}${expired ? " — dropping subscription" : ""}`);
      if (!expired) stillValid.push(sub);
    }
  }
  saveSubs(stillValid);
}

// `tag` lets the same review replace its own earlier notification instead of
// stacking, and lets a later closeNotification(tag) find and dismiss it.
function notifyAll(title, body, tag) {
  return sendToAll({ title, body, tag });
}

// Fires when the item is answered from any device — the service worker finds any
// shown notification with this tag (on every device it's installed on) and closes
// it, so answering on the PC clears the phone's notification tray.
function closeNotification(tag) {
  return sendToAll({ closeTag: tag });
}

module.exports = { publicKey: keys.publicKey, addSubscription, notifyAll, closeNotification };
