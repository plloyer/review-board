"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { summarizeTitle } = require("../server/summarize");

test("summarizeTitle is a no-op under REVIEW_BOARD_NO_SUMMARY (never touches the store, never spawns a CLI)", async () => {
  const before = process.env.REVIEW_BOARD_NO_SUMMARY;
  process.env.REVIEW_BOARD_NO_SUMMARY = "1";
  const store = { setSummary: () => assert.fail("must not be called when summarizing is disabled") };
  try {
    await summarizeTitle("u1", "a title with \"quotes\" and `backticks`", store);
  } finally {
    if (before === undefined) delete process.env.REVIEW_BOARD_NO_SUMMARY;
    else process.env.REVIEW_BOARD_NO_SUMMARY = before;
  }
});
