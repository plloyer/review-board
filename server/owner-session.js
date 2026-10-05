"use strict";
// Only report-intake decisions need this owner identity. No request body can
// designate itself PL; a server-configured secret mints an HttpOnly signed cookie.
const crypto = require("node:crypto");
const COOKIE = "review_board_pl";
const SESSION_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;

function equalSecret(first, second) {
  const left = Buffer.from(String(first || ""));
  const right = Buffer.from(String(second || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function createOwnerSession(secret = process.env.REVIEW_BOARD_PL_SECRET || "", now = Date.now) {
  const enabled = typeof secret === "string" && secret.length >= 32;
  const sign = (value) => crypto.createHmac("sha256", secret).update(value).digest("hex");
  function identity(request) {
    if (!enabled) return null;
    const cookie = String(request.headers.cookie || "").split(";").map((part) => part.trim())
      .find((part) => part.startsWith(COOKIE + "="));
    if (!cookie) return null;
    const token = cookie.slice(COOKIE.length + 1);
    const match = token.match(/^([0-9]+\.[a-f0-9]{32})\.([a-f0-9]{64})$/);
    if (!match || Number(match[1].split(".")[0]) <= now() || !equalSecret(sign(match[1]), match[2])) return null;
    return { id: "PL", role: "owner" };
  }
  function login(request, response) {
    if (!enabled) return response.status(503).json({ error: "PL sign-in is not configured on this board" });
    if (!equalSecret((request.body || {}).secret, secret)) return response.status(403).json({ error: "PL sign-in refused" });
    const value = `${now() + SESSION_MILLISECONDS}.${crypto.randomBytes(16).toString("hex")}`;
    response.cookie(COOKIE, value + "." + sign(value), {
      httpOnly: true, sameSite: "strict", secure: request.secure,
      path: "/api", maxAge: SESSION_MILLISECONDS,
    });
    return response.json({ identity: "PL" });
  }
  return { enabled, identity, login, cookie: COOKIE };
}

module.exports = { createOwnerSession };
