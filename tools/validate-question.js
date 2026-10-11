"use strict";
// The posting preflight uses the same pure contract as the board/browser, with no store or network.
const { readFileSync } = require("fs");
const Questions = require("../shared/questions");
const request = JSON.parse(readFileSync(0, "utf8"));
process.stdout.write(JSON.stringify(Questions.parse(request.text)) + "\n");
