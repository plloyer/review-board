"use strict";
const { spawn } = require("child_process");

const PROMPT_PREFIX =
  "Resume ce feedback de bug/feature en une etiquette de 8 mots max, meme langue, sans guillemets ni ponctuation finale: ";

// Runs a local CLI on the user's own subscription (no API keys). The prompt travels
// via stdin only — never interpolated into the command line — so a title containing
// quotes/backticks can't break out into the shell (shell:true is only for Windows'
// .cmd wrappers, e.g. codex.cmd; the argv stays fixed literals either way).
function runCli(cmd, args, input) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { shell: true, timeout: 60000, windowsHide: true });
    } catch (err) {
      return reject(err);
    }
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 && out.trim() ? resolve(out.trim()) : reject(new Error(`exit ${code}`))));
    child.stdin.write(input);
    child.stdin.end();
  });
}

function sanitize(text) {
  const line = text.split("\n")[0].trim();
  return line && line.length <= 120 ? line : null;
}

// Fire-and-forget: on any failure across both CLIs, gives up silently and the
// title just stays as typed. Skipped entirely under the test env flag.
async function summarizeTitle(id, title, store) {
  if (process.env.REVIEW_BOARD_NO_SUMMARY === "1") return;
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
}

module.exports = { summarizeTitle };
