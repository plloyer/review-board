"use strict";
const { spawn, exec } = require("child_process");

const PROMPT_PREFIX =
  "Resume ce feedback de bug/feature en une etiquette de 8 mots max, meme langue, sans guillemets ni ponctuation finale: ";

const RUN_TIMEOUT_MS = 60000;

// spawn's own `timeout` option only signals the direct child; with shell:true on
// win32 that child is a cmd.exe wrapper, so the real CLI process survives it
// orphaned. Kill the whole tree there; a plain kill is enough everywhere else.
function killTree(child) {
  if (process.platform === "win32") exec(`taskkill /pid ${child.pid} /T /F`);
  else child.kill();
}

// Runs a local CLI on the user's own subscription (no API keys). The prompt travels
// via stdin only — never interpolated into the command line — so a title containing
// quotes/backticks can't break out into the shell (shell:true is only for Windows'
// .cmd wrappers, e.g. codex.cmd; the argv stays fixed literals either way).
function runCli(cmd, args, input) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { shell: true, windowsHide: true });
    } catch (err) {
      return reject(err);
    }
    let out = "";
    const timer = setTimeout(() => killTree(child), RUN_TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d));
    child.stdin.on("error", () => {}); // e.g. EPIPE if the child already exited
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      return code === 0 && out.trim() ? resolve(out.trim()) : reject(new Error(`exit ${code}`));
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}

function sanitize(text) {
  const line = text.split("\n")[0].trim();
  return line && line.length <= 120 ? line : null;
}

// A card whose summary is already in flight skips a duplicate call instead of
// racing it (e.g. a fast double-submit).
const inFlight = new Set();

// Fire-and-forget: on any failure across both CLIs, gives up silently and the
// title just stays as typed. Skipped entirely under the test env flag.
async function summarizeTitle(id, title, store) {
  if (process.env.REVIEW_BOARD_NO_SUMMARY === "1") return;
  if (inFlight.has(id)) return;
  inFlight.add(id);
  try {
    const prompt = PROMPT_PREFIX + title.slice(0, 500);
    for (const [cmd, args] of [
      ["claude", ["-p", "--model", "haiku"]],
      ["codex", ["exec"]],
    ]) {
      try {
        const summary = sanitize(await runCli(cmd, args, prompt));
        if (summary) return void store.setSummary(id, summary);
      } catch {
        // try the next CLI, then give up silently
      }
    }
  } finally {
    inFlight.delete(id);
  }
}

module.exports = { summarizeTitle };
